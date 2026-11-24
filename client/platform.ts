/**
 * Website vs Android/iOS app. The same React code runs in both.
 *
 * Website: served by the Everjoy server itself, calls '/api' on the same origin and
 * uses the httpOnly session cookie.
 * App: screens are bundled inside the APK/IPA and served from the Capacitor local
 * origin, so it calls the server at an absolute address and sends a bearer token.
 * The token lives in the iOS Keychain (this device only, never iCloud) / Android
 * Keystore-encrypted storage, not in plain preferences, so it never lands in backups.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';

export const isApp = Capacitor.isNativePlatform();
export const platformName = Capacitor.getPlatform();   // 'web' | 'android' | 'ios'

/** Build-time default from .env.app (VITE_API_BASE). */
const BUILT_IN_SERVER = normaliseServer(String(import.meta.env.VITE_API_BASE ?? ''));

/**
 * Only a test build made for a laptop server (plain http:// in .env.app) lets people change the
 * server on the sign-in screen. Any other build, including one made without .env.app, is locked,
 * so nobody can point a phone at a look-alike server to collect passwords.
 */
export const canChangeServer = BUILT_IN_SERVER.startsWith('http://');

let server = BUILT_IN_SERVER;
let token: string | null = null;
/** Bumped whenever a new session starts or ends; a 401 from an older session must not sign out a newer one. */
let generation = 0;

const TOKEN_KEY = 'ej-token';
/** App only: proof this phone already confirmed an email code (the website keeps it in an httpOnly cookie). */
const DEVICE_KEY = 'ej-device';
let deviceToken: string | null = null;

/** Load the saved server address and token before the first render. No-op on the website. */
export async function initPlatform() {
  if (!isApp) return;
  const saved = (await Preferences.get({ key: 'ej-server' })).value;
  if (saved && canChangeServer) server = saved;
  else if (saved) await Preferences.remove({ key: 'ej-server' });   // a production build drops any old override
  // get() pairs with set() (which stores JSON); the low-level getItem() would return the JSON-quoted text.
  try { const v = await SecureStorage.get(TOKEN_KEY, false, false); token = typeof v === 'string' && v ? v : null; } catch { token = null; }
  try { const d = await SecureStorage.get(DEVICE_KEY, false, false); deviceToken = typeof d === 'string' && d ? d : null; } catch { deviceToken = null; }
  // Early test builds kept the token in plain Preferences: move it into secure storage once.
  const legacy = (await Preferences.get({ key: TOKEN_KEY })).value;
  if (legacy) {
    await Preferences.remove({ key: TOKEN_KEY });
    if (!token) { token = legacy; await storeToken(legacy).catch(() => {}); }
  }
  clearExportsFolder();
}

export function normaliseServer(input: string) {
  let u = input.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '').replace(/\/api$/i, '');
}

export const serverAddress = () => server;
export const builtInServer = () => BUILT_IN_SERVER;
/** Full URL for an API path: relative on the website, absolute in the app. */
export const apiUrl = (path: string) => `${isApp ? server : ''}/api${path}`;
export const getToken = () => token;
export const sessionGeneration = () => generation;
/** Mark that a new session started (website cookie or app token), so stale 401s are ignored. */
export const bumpSession = () => { generation++; };

async function storeToken(t: string | null) {
  if (t) await SecureStorage.set(TOKEN_KEY, t, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
  else await SecureStorage.remove(TOKEN_KEY, false);
}

export async function setToken(t: string | null) {
  token = t;
  generation++;
  if (!isApp) return;
  try { await storeToken(t); } catch { /* storage unavailable: session lasts until the app closes */ }
}

/** Switch a test build to another server. Signs out and forgets offline copies from the old server. */
export async function setServer(url: string) {
  if (!canChangeServer) throw new Error('This app is locked to the official laundry server.');
  server = normaliseServer(url);
  await Preferences.set({ key: 'ej-server', value: server });
  await setToken(null);
  clearOfflineCopies();
}

/** Remove saved slips and the remembered user (they belong to one server and one session). */
export function clearOfflineCopies() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('ej-home-') || k === 'ej-last-user')) localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
}

/** Shared Excel/backup files are written here and cleared on start, before each export and on sign-out. */
export const EXPORTS_DIR = 'everjoy-exports';
export function clearExportsFolder() {
  if (!isApp) return;
  import('@capacitor/filesystem').then(({ Filesystem, Directory }) =>
    Filesystem.rmdir({ path: EXPORTS_DIR, directory: Directory.Cache, recursive: true }).catch(() => {})).catch(() => {});
}

/** Headers that identify the caller: CSRF header always; in the app also the client marker and bearer token. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'x-ej': '1' };
  if (isApp) {
    h['x-ej-client'] = 'app';
    if (token) h.Authorization = `Bearer ${token}`;
    if (deviceToken) h['x-ej-device'] = deviceToken;
  }
  return h;
}

/** Remember that this phone confirmed an email code (app only). */
export async function setDeviceToken(t: string | null) {
  deviceToken = t;
  if (!isApp) return;
  try {
    if (t) await SecureStorage.set(DEVICE_KEY, t, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
    else await SecureStorage.remove(DEVICE_KEY, false);
  } catch { /* the code is simply asked again next time */ }
}

/** Check a server address answers like an Everjoy server before saving it. */
export async function probeServer(url: string) {
  const base = normaliseServer(url);
  if (!base) throw new Error('Enter the server address.');
  let res: Response;
  try {
    res = await fetch(`${base}/api/health`, { headers: { 'x-ej-client': 'app' } });
  } catch {
    throw new Error(`Could not reach ${base}. Check the address and that this phone has internet (or is on the same Wi-Fi).`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(`${base} is not an Everjoy Lawndry server.`);
  return base;
}
