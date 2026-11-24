import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* ------------------------------------------------------------- formatting */

export const kg = (v: number | null | undefined) => `${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg`;
export const rupees = (v: number | null | undefined) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function when(v: string | null | undefined, style: 'full' | 'date' | 'time' | 'short' = 'full') {
  if (!v) return '—';
  const d = new Date(v);
  if (style === 'time') return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (style === 'date') return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (style === 'short') {
    const today = new Date();
    const yest = new Date(Date.now() - 86400_000);
    const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Today, ${t}`;
    if (d.toDateString() === yest.toDateString()) return `Yesterday, ${t}`;
    const tomorrow = new Date(Date.now() + 86400_000);
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${t}`;
    return `${d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
  }
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function ago(v: string) {
  const m = Math.round((Date.now() - Date.parse(v)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const shiftDay = (key: string, days: number) => {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const firstName = (name: string) => name.split(' ')[0];
export const initials = (name: string) => name.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** crypto.randomUUID needs HTTPS; fall back so the counter works on a LAN IP during setup too. */
export const requestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/* ------------------------------------------------------------------ route */

function readHash() { return window.location.hash.replace(/^#\/?/, '') || ''; }
const subscribeHash = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };

/** Tiny hash router: '#/orders/12' → ['orders', '12']. The phone's back button just works. */
export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const parts = hash.split('?')[0].split('/').filter(Boolean);
  return parts;
}
let pushed = 0;   // in-app navigations we can safely undo with history.back()
/** New page → start at the top (sheets/overlays don't count as pages). */
export function useScrollTop(page: string) {
  useEffect(() => { window.scrollTo(0, 0); }, [page]);
}
export const go = (path: string) => { pushed++; window.location.hash = `/${path.replace(/^\//, '')}`; };
/** Close a sheet/page: real "back" when we navigated here, otherwise jump to the fallback. */
export const back = (fallback: string) => {
  if (pushed > 0) { pushed--; window.history.back(); } else window.location.replace(`#/${fallback}`);
};

/* --------------------------------------------------------------- loading */

type LoadState<T> = { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void>; set: (d: T) => void };

/**
 * Load data, keep it fresh: refetch on an interval (if given) and whenever the
 * tab or phone screen comes back into view.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], opts: { every?: number } = {}): LoadState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void reload();
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = opts.every ? window.setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, opts.every) : 0;
    return () => { alive.current = false; document.removeEventListener('visibilitychange', onVisible); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, set: setData };
}

/* ----------------------------------------------------------------- toasts */

type Toast = { id: number; text: string; tone: 'ok' | 'bad' };
let toasts: Toast[] = [];
const toastSubs = new Set<() => void>();
const emit = () => toastSubs.forEach(f => f());
export function toast(text: string, tone: 'ok' | 'bad' = 'ok') {
  const t = { id: Date.now() + Math.random(), text, tone };
  toasts = [...toasts.slice(-2), t];
  emit();
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); emit(); }, tone === 'bad' ? 6000 : 3500);
}
export const toastError = (e: unknown) => toast((e as Error).message || 'Something went wrong.', 'bad');
export function useToasts() {
  return useSyncExternalStore(cb => { toastSubs.add(cb); return () => { toastSubs.delete(cb); }; }, () => toasts);
}

/** Run an async action with a busy flag; errors become a toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/** Like useAction, but the error is shown inline on the form instead of as a toast. */
export function useFormAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, submit };
}

/* -------------------------------------------------------------- semesters */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2027-06-30" → "Jun 2027" */
export const monthYear = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** Semesters run January–June and July–December. The current one and the next two, for quick picking. */
export function semesterOptions(today = todayKey()) {
  const y = Number(today.slice(0, 4));
  const firstHalf = Number(today.slice(5, 7)) <= 6;
  const list: [number, 1 | 2][] = firstHalf ? [[y, 1], [y, 2], [y + 1, 1]] : [[y, 2], [y + 1, 1], [y + 1, 2]];
  return list.map(([yr, h]) => ({
    label: h === 1 ? `Jan–Jun ${yr}` : `Jul–Dec ${yr}`,
    from: h === 1 ? `${yr}-01-01` : `${yr}-07-01`,
    until: h === 1 ? `${yr}-06-30` : `${yr}-12-31`,
  }));
}

/** "Jan 2027 – Jun 2027", "till Jun 2027", or '' */
export function planPeriod(from?: string | null, until?: string | null) {
  if (from && until) return `${monthYear(from)} – ${monthYear(until)}`;
  if (until) return `till ${monthYear(until)}`;
  if (from) return `from ${monthYear(from)}`;
  return '';
}

/**
 * Shrink a camera photo before upload (longest side 1600 px, JPEG): faster on campus data and
 * keeps the database small. Falls back to the original if the browser can't decode it (e.g. HEIC).
 */
export async function shrinkPhoto(file: File, longest = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/* ----------------------------------------------------------- server clock */

/**
 * How far this phone's clock is from the server's. The slip QR is time-based, so a phone set a few
 * minutes wrong still makes a QR the counter accepts. Kept on the phone for offline use.
 */
let clockOffset = (() => { try { return Number(localStorage.getItem('ej-clock-offset')) || 0; } catch { return 0; } })();
export function noteServerTime(serverMs: unknown) {
  if (typeof serverMs !== 'number' || !Number.isFinite(serverMs)) return;
  clockOffset = serverMs - Date.now();
  try { localStorage.setItem('ej-clock-offset', String(Math.round(clockOffset))); } catch { /* storage blocked */ }
}
export const serverNow = () => Date.now() + clockOffset;
