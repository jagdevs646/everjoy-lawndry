import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, onSignedOut, signOutRequest, User } from './api';
import { PublicApp, ChangePassword } from './auth';
import { StudentApp } from './student';
import { clearOfflineCopies, getToken, initPlatform, isApp, serverAddress } from './platform';
import { Brand, Button, Icon, Loading, Toasts } from './ui';
// Fonts ship with the site and inside the app, so it looks right offline and makes no third-party requests.
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/figtree/index.css';
import '@fontsource-variable/public-sans/index.css';
import './styles/base.css';
import './styles/student.css';
import './styles/staff.css';
import './styles/admin.css';

// Staff and admin screens (and the camera scanner) load only for those roles, keeping the student download small.
const StaffApp = lazy(() => import('./staff').then(m => ({ default: m.StaffApp })));
const AdminApp = lazy(() => import('./admin').then(m => ({ default: m.AdminApp })));

type Theme = 'public' | 'student' | 'staff' | 'admin';
const THEME_COLOR: Record<Theme, string> = { public: '#EAF2FB', student: '#EAF2FB', staff: '#1F2327', admin: '#5C1F2E' };
/** Status-bar icon colour per theme: light icons on dark bars. */
const DARK_BAR: Record<Theme, boolean> = { public: false, student: false, staff: true, admin: false };

function useTheme(theme: Theme) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
    if (!isApp) return;
    import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
      // Style.Dark = light icons for a dark background. When the page is drawn under the status bar
      // (iOS, and Android with WebView 140+), the bar shows our theme colour, so follow the theme.
      // On older Android WebViews Capacitor pads the page below a light system strip: keep dark icons there.
      const darkIcons = !(DARK_BAR[theme] && drawsUnderStatusBar());
      void StatusBar.setStyle({ style: darkIcons ? Style.Light : Style.Dark }).catch(() => {});
    }).catch(() => {});
  }, [theme]);
}

/** True when the page extends under the status bar (safe-area inset at the top is non-zero). */
function drawsUnderStatusBar() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h > 0;
}

/** The last signed-in user, so a student can still open their slip QR with no network. */
const USER_KEY = 'ej-last-user';
const rememberUser = (u: User | null) => { try { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); } catch { /* storage blocked */ } };
const lastUser = (): User | null => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } };

function App() {
  const [user, setUserState] = useState<User | null | undefined>(undefined);
  // An admin can switch to the counter screens (staff theme) and back.
  const [counterMode, setCounterMode] = useState(() => sessionStorageGet('ej-counter') === '1');
  const setUser = useCallback((u: User | null) => { rememberUser(u); setUserState(u); }, []);
  // The server could not be reached at launch while a session may still be valid (e.g. counter Wi-Fi reconnecting).
  const [unreachable, setUnreachable] = useState(false);

  const checkSession = useCallback(() => {
    api<{ user: User | null }>('/auth/me')
      .then(r => {
        setUnreachable(false);
        // Signed out on the server (password reset, signed out elsewhere): don't keep saved slips on this phone.
        if (!r?.user) clearOfflineCopies();
        setUser(r?.user ?? null);
      })
      .catch(e => {
        // Only a definite answer (e.g. not signed in) means signed out; no network or a server error (5xx) means "try again".
        const temporary = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        if (!temporary) { clearOfflineCopies(); setUnreachable(false); setUserState(null); return; }
        const last = lastUser();
        // Students keep their saved slips: show them from the offline copy.
        if (last?.role === 'STUDENT') { setUnreachable(false); setUserState(last); return; }
        // Someone may still be signed in: wait for the network instead of sending them to the sign-in screen.
        if ((isApp && getToken()) || last) { setUnreachable(true); setUserState(null); return; }
        setUnreachable(false);
        setUserState(null);
      });
  }, [setUser]);

  useEffect(() => {
    checkSession();
    return onSignedOut(() => { clearOfflineCopies(); setUser(null); });
  }, [checkSession, setUser]);

  // Retry by itself when the connection comes back, and every 15 s while waiting.
  useEffect(() => {
    if (!unreachable) return;
    const t = window.setInterval(checkSession, 15_000);
    window.addEventListener('online', checkSession);
    return () => { window.clearInterval(t); window.removeEventListener('online', checkSession); };
  }, [unreachable, checkSession]);

  const signOut = useCallback(async () => {
    await signOutRequest();
    clearOfflineCopies();
    setUnreachable(false);
    sessionStorageSet('ej-counter', '0');
    setCounterMode(false);
    window.location.hash = '/';
    setUser(null);
  }, [setUser]);

  const toggleCounter = (on: boolean) => { sessionStorageSet('ej-counter', on ? '1' : '0'); setCounterMode(on); window.location.hash = '/'; };

  const theme: Theme = !user || user.must_change_password ? (user?.role === 'STAFF' ? 'staff' : user?.role === 'ADMIN' ? 'admin' : 'public')
    : user.role === 'STUDENT' ? 'student' : user.role === 'STAFF' || counterMode ? 'staff' : 'admin';
  useTheme(theme);

  let body;
  if (unreachable && !user) body = <Unreachable onRetry={checkSession} onSignOut={signOut} />;
  else if (user === undefined) body = <div className="boot"><Loading label="Opening Everjoy" /></div>;
  else if (!user) body = <PublicApp onSignedIn={u => { window.location.hash = '/'; setUser(u); }} />;
  else if (user.must_change_password) body = <div className="forced-wrap"><ChangePassword user={user} forced onDone={setUser} onSignOut={signOut} /></div>;
  else if (user.role === 'STUDENT') body = <StudentApp user={user} onSignOut={signOut} onUser={setUser} />;
  else if (user.role === 'STAFF' || counterMode) body = <StaffApp user={user} onSignOut={signOut} onUser={setUser} onAdmin={user.role === 'ADMIN' ? () => toggleCounter(false) : undefined} />;
  else body = <AdminApp user={user} onSignOut={signOut} onUser={setUser} onCounter={() => toggleCounter(true)} />;

  return <div className="app-root"><Suspense fallback={<div className="boot"><Loading /></div>}>{body}</Suspense><Toasts /></div>;
}

function Unreachable({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  const host = serverAddress().replace(/^https?:\/\//, '');
  return (
    <div className="boot unreachable">
      <div className="unreachable-card">
        <Brand />
        <Icon name="alert" size={28} />
        <h1>Can’t reach the laundry server</h1>
        <p>{isApp && host ? `Trying ${host}. ` : ''}Check the Wi-Fi or mobile data. This page tries again by itself when the connection is back.</p>
        <Button tone="primary" icon="refresh" block onClick={onRetry}>Try again</Button>
        <button type="button" className="link-btn" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

function sessionStorageGet(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }

// Load the app's saved server address and token before the first screen renders.
initPlatform().finally(() => {
  if (isApp) document.documentElement.classList.add('is-app');
  createRoot(document.getElementById('root')!).render(<App />);
});
