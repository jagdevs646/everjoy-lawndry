import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // Our own bridge view controller, so the app's native plugins (PrivacyScreen) are registered.
        window?.rootViewController = EverjoyBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// MARK: - Bridge

/// Capacitor's view controller plus the plugins that live inside this app (not in npm packages).
class EverjoyBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrivacyScreenPlugin())
    }
}

// MARK: - PrivacyScreen (iPhone)

/**
 * The iPhone side of the "no screenshots of the slip" rule (Android uses FLAG_SECURE).
 *
 * iOS does not let an app block screenshots outright. While the web screens ask for it (the slip QR,
 * the ID QR, the confirmation code), this plugin:
 *  - covers the screen while it is being recorded, mirrored or AirPlayed;
 *  - covers it when the app leaves the foreground, so the app switcher shows no QR or code;
 *  - tells the web screens when a screenshot was taken (they explain it won't work: the QR and the
 *    code change every 30 seconds, so a screenshot is useless at the counter anyway).
 *
 * Optional, off by default: Info.plist key EJScreenshotShield = YES makes the whole app come out blank
 * in screenshots and recordings, using a secure text field's layer. This relies on how iOS draws secure
 * fields and has changed between iOS versions: test it on real iPhones before turning it on.
 */
@objc(PrivacyScreenPlugin)
public class PrivacyScreenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrivacyScreenPlugin"
    public let jsName = "PrivacyScreen"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
    ]

    private var active = false
    private var cover: UIView?
    private var shieldApplied = false

    public override func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(screenshotTaken), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        DispatchQueue.main.async { self.applyShieldIfConfigured() }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.active = true
            self.refreshCover()
            call.resolve()
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.active = false
            self.hideCover()
            call.resolve()
        }
    }

    // MARK: events

    @objc private func captureChanged() {
        DispatchQueue.main.async { self.refreshCover() }
    }

    @objc private func willResignActive() {
        DispatchQueue.main.async { if self.active { self.showCover(message: nil) } }
    }

    @objc private func didBecomeActive() {
        DispatchQueue.main.async { self.refreshCover() }
    }

    @objc private func screenshotTaken() {
        if active { notifyListeners("screenshotTaken", data: [:]) }
    }

    // MARK: cover

    private var hostView: UIView? { bridge?.viewController?.view }

    private func screenIsCaptured() -> Bool {
        if let screen = hostView?.window?.windowScene?.screen { return screen.isCaptured }
        return false
    }

    private func refreshCover() {
        if active && screenIsCaptured() {
            showCover(message: "Hidden while the screen is recorded or shared.")
        } else {
            hideCover()
        }
    }

    private func showCover(message: String?) {
        guard let host = hostView else { return }
        let view = cover ?? makeCover()
        cover = view
        if let label = view.viewWithTag(4711) as? UILabel {
            label.text = message
            label.isHidden = message == nil
        }
        view.frame = host.bounds
        if view.superview !== host { host.addSubview(view) }
        host.bringSubviewToFront(view)
    }

    private func hideCover() {
        cover?.removeFromSuperview()
    }

    private func makeCover() -> UIView {
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let label = UILabel()
        label.tag = 4711
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = UIFont.preferredFont(forTextStyle: .headline)
        label.textColor = .label
        label.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: blur.contentView.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(lessThanOrEqualTo: blur.contentView.trailingAnchor, constant: -32),
        ])
        return blur
    }

    // MARK: optional shield (Info.plist EJScreenshotShield)

    /// Moves the web view's layer into a secure text field's canvas, which iOS leaves out of
    /// screenshots and recordings. Only when the app's Info.plist turns it on, and only if the
    /// canvas is found; otherwise nothing changes.
    private func applyShieldIfConfigured() {
        guard !shieldApplied,
              Bundle.main.object(forInfoDictionaryKey: "EJScreenshotShield") as? Bool == true,
              let web = bridge?.webView, let container = web.superview else { return }
        let field = UITextField(frame: container.bounds)
        field.isSecureTextEntry = true
        field.isUserInteractionEnabled = false
        field.backgroundColor = .clear
        container.insertSubview(field, belowSubview: web)
        field.layoutIfNeeded()
        guard let canvas = field.subviews.first(where: { String(describing: type(of: $0)).contains("CanvasView") }) else {
            field.removeFromSuperview()
            return
        }
        container.layer.addSublayer(field.layer)
        canvas.layer.addSublayer(web.layer)
        shieldApplied = true
    }
}
