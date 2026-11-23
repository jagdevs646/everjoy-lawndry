# Everjoy Lawndry

One website that replaces the laundry register and the paper slip. Students register and keep a digital slip on their phone. Staff take and return laundry from a phone at the counter. Admin sets the rules and gets the reports.

See **[FEATURES.md](FEATURES.md)** for everything each role can do.

## Try it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The first run creates `data/lawndry.db` with **demo data**:

| Role | Sign in with | Password |
|---|---|---|
| Admin | `ADMIN` | `Everjoy@123` |
| Staff | `STAFF1` | `Everjoy@123` |
| Student (has orders) | `EJ2026001` | `Everjoy@123` |
| Student (waiting for approval) | `EJ2026007` | `Everjoy@123` |

To try it on a phone on the same Wi-Fi, open the "Network" address Vite prints (e.g. `http://192.168.1.20:5173`). The camera scanner only works over **https** or on localhost; typing the number always works.

To start fresh, stop the server and delete `data/lawndry.db*`.

## Commands

```bash
npm run dev     # website + API with demo data, auto-reload
npm test        # API tests, run on both SQLite and Postgres (in-memory)
npm run build   # type-check + build the website into dist/
npm start       # production: one server for website + API (no demo data)
npm run demo    # build, then run the production server with demo data
```

## Database: SQLite or Postgres

The server works with either engine, chosen by one setting:

| Setting | Engine | Use it for |
|---|---|---|
| `DATABASE_URL=postgres://…` | Postgres | Hosting on Render (free) with a free Neon database |
| *(not set)* | SQLite file `data/lawndry.db` (or `DB_PATH`) | This laptop, a college PC, any server with a real disk |

Complaint photos and the session signing key are stored in the database too, so nothing is lost when a host wipes its disk.

## Going live for free: Render + Neon

**Render** runs the server (website + API) for free. Its free disk is wiped on every restart, so the data lives in a free **Neon** Postgres database.

**One-time setup**
1. **Neon:** sign up at [neon.tech](https://neon.tech) (free), create a project (region: Singapore is closest to India), and copy its **connection string** (`postgresql://…sslmode=require`).
2. **Render:** open the `everjoy-lawndry` service → **Environment** → add `DATABASE_URL` = that connection string → **Save, rebuild and deploy**. You paste it yourself so the password never passes through anyone else.
3. Open the Render service URL. The first admin password is printed in Render → **Logs** ("First admin account → …"). Sign in as `ADMIN` and change it.

**Render settings** (already configured on the service):
- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- Environment: `NODE_ENV=production`, `TRUST_PROXY=1`, `APP_TZ=Asia/Kolkata`, `DEMO=1` while testing
- To start with a clean database for real use, set `DEMO=0`, then in the Neon console run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and redeploy.

**Good to know about free tiers**
- Render's free server **sleeps after 15 minutes without visitors**. The next visit takes about a minute while it wakes. To keep it awake during counter hours, add a free monitor (e.g. UptimeRobot) that opens `https://<your-service>.onrender.com/api/health` every 10 minutes.
- Neon free gives 0.5 GB, enough for years of orders. Photos are shrunk on the phone before upload.
- Pushing to the `main` branch on GitHub redeploys Render automatically.

## Going live on your own server

1. Any machine with a disk: a VPS, or a PC at the college. SQLite needs nothing else. Set `DATABASE_URL` to use Postgres instead.
2. Environment: `NODE_ENV=production`. Optional: `ADMIN_PASSWORD` (first admin password, otherwise a random one is printed once), `JWT_SECRET` (otherwise a random key is generated and kept in the database), `PORT` (default 3001), `DB_PATH`, `APP_TZ` (default `Asia/Kolkata`), `TRUST_PROXY` (set when behind a proxy other than one on the same machine).
3. Run `npm ci --include=dev && npm run build && npm start`.
4. Put it behind **HTTPS** (Caddy or Nginx with Let's Encrypt). HTTPS is required for phone cameras and secure cookies.
5. Sign in as `ADMIN` and follow the setup checklist on the Overview page: add hostels, create staff, review rules.
6. **Backups**: Admin → Reports → *Download backup* weekly (a `.db` file on SQLite, a `.json` file on Postgres).

## Android and iPhone apps

The apps are the same screens as the website, packaged with [Capacitor](https://capacitorjs.com) 8, so anything that works on the website works in the apps. They talk to the same Everjoy server. Students and staff can use either the website or the app.

**Which server the app uses.** It is set in `.env.app` (`VITE_API_BASE`). The first test build points at this laptop: `http://10.2.25.194:3001`. Anyone can change it on the app's sign-in screen (**Laundry server → Change**), so one APK works for testing now and for the real domain later.

### Build the Android APK (Windows, no Android Studio)

Needs Java 21 and the Android SDK. On this PC they are at `D:\dev-tools\jdk21-extract\…` and `%LOCALAPPDATA%\Android\Sdk`. Elsewhere, set `JAVA_HOME` and `ANDROID_HOME`.

```bash
npm run app:apk
```

The APK appears in `release/everjoy-lawndry-<version>-debug.apk`. The first build downloads Gradle and the Android libraries (cached in `D:\dev-tools\gradle-home`).

### Try it on a phone with this laptop as the server

1. Run `npm run demo` on the laptop (it serves on port 3001 with demo data). When Windows asks, allow Node.js on **private networks**.
2. Connect the phone to the **same Wi-Fi** as the laptop.
3. Copy the APK to the phone (USB, Drive or WhatsApp), open it, and allow "Install unknown apps" when asked. Or, with USB debugging on: `adb install release/everjoy-lawndry-2.0.0-debug.apk`.
4. Sign in with a demo account from the table above.

If the laptop's Wi-Fi address changes, update it on the sign-in screen, or in `.env.app` before rebuilding.

### Going live on Android

1. Host the server on HTTPS (see "Going live" above) and put that address in `.env.app`, e.g. `VITE_API_BASE=https://laundry.youruniversity.edu`. With an `https://` address the build automatically turns off plain-HTTP (cleartext) and mixed-content access.
2. Create a signing key **once** and keep it and its password safe. Every future update must be signed with the same key:
   ```powershell
   & "D:\dev-tools\jdk21-extract\jdk-21.0.13.1+2\bin\keytool.exe" -genkeypair -v -keystore D:\keys\everjoy-release.jks -alias everjoy -keyalg RSA -keysize 2048 -validity 10000
   ```
3. Build a signed release:
   ```powershell
   $env:EJ_KEYSTORE="D:\keys\everjoy-release.jks"; $env:EJ_KEYSTORE_PASSWORD="<your password>"; npm run app:apk:release
   ```
   Use `npm run app:aab` instead to get the `.aab` file the Google Play Store needs (one-time $25 developer account).
4. For every new version, raise `versionCode` (and `versionName`) in `android/app/build.gradle`.

### iPhone (iOS)

The `ios/` project is ready (Swift Package Manager, no CocoaPods). Apple only allows iPhone apps to be built on a **Mac with Xcode**, and installing on phones needs an **Apple Developer account** ($99/year).

On a Mac:
1. `npm ci && npm run app:ios`
2. `npx cap open ios`. In Xcode, choose your team under *Signing & Capabilities*, plug in an iPhone and press Run.
3. To share with staff and students: *Product → Archive → Distribute → TestFlight* (testers install the TestFlight app), or publish on the App Store.

No Mac? A cloud Mac build service (e.g. Codemagic, or GitHub Actions macOS runners) can build and upload it to TestFlight.

### How the app signs in (for developers)

- The website uses an httpOnly cookie. The app runs on a different origin (`https://localhost` on Android, `capacitor://localhost` on iOS), where WebViews don't reliably keep cookies. So the app sends `x-ej-client: app`, receives the same signed token in the JSON reply, and sends it back as `Authorization: Bearer …`.
- The token is kept in the app's private storage (`@capacitor/preferences`), excluded from Android cloud backup and phone-to-phone transfer, and invalidated by any password change or reset.
- The server allows cross-origin requests only from the app origins (`APP_ORIGINS`, default `https://localhost,capacitor://localhost,http://localhost`) and never with cookies.

## How it is built

- `server/`: Express 5 + SQLite (`better-sqlite3`). Session is an httpOnly cookie, plus a custom header that blocks cross-site forms.
  - `rules.ts`: **the only place laundry rules live** (7 kg, monthly limits, pricing, handover checks). The counter's live check and the saved order use the same function.
  - `routes/public.ts` (sign-in, sign-up), `routes/student.ts`, `routes/ops.ts` (staff + admin counter work), `routes/admin.ts`.
  - `seed.ts`: first admin account; demo data only with `--demo`.
- `client/`: React 19 + Vite, no UI framework. `student.tsx`, `staff.tsx`, `admin.tsx`, shared pieces in `ops.tsx` and `ui.tsx`. Themes live in `client/styles/`. Staff, admin and the camera scanner load only for those roles, so students download less.
- `tests/api.test.ts`: covers registration and approval, the 7 kg limit, unique order numbers, double-tap protection, QR pickup and double-handover protection, monthly limits and charges, role security, password reset, complaints, notices and Excel export.

The first version (a larger "operating system" design with allowances, carry-forward and email sign-in) is kept in `archive/v1/` with its old database.
