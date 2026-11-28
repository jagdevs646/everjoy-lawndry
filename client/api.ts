import { apiUrl, authHeaders, bumpSession, clearExportsFolder, EXPORTS_DIR, getToken, isApp, serverAddress, sessionGeneration, setDeviceToken, setToken } from './platform';

export type Role = 'ADMIN' | 'STAFF' | 'STUDENT';
export type User = { id: number; role: Role; name: string; login_id: string; must_change_password: boolean; complete_profile?: boolean; student_status?: string };
export type OrderStatus = 'RECEIVED' | 'WASHING' | 'READY' | 'DELIVERED' | 'CANCELLED';
export type Order = {
  id: number; order_no: string; student_id?: number; student_name?: string; id_card_no?: string; hostel_name: string; room_no: string; mobile?: string;
  weight_kg: number; clothes_count: number; service: 'REGULAR' | 'EXPRESS'; note?: string | null; status: OrderStatus;
  within_kg: number; extra_kg: number; amount: number; payment_status: 'NONE' | 'DUE' | 'PAID' | 'WAIVED'; paid_method?: string | null; paid_ref?: string | null; paid_at?: string | null;
  received_at: string; expected_at: string; ready_at?: string | null; delivered_at?: string | null; returned_count?: number | null; cancel_reason?: string | null;
  received_by_name?: string; delivered_by_name?: string | null; late?: number; qr_key?: string | null;
  events?: { type: string; note: string | null; at: string; by_name: string | null; by_role: Role | null }[];
  via?: 'QR' | 'NUMBER' | 'CARD';
  service_id?: number | null; service_name?: string | null; unit?: 'KG' | 'PIECE' | null; rate?: number | null; charge_note?: string | null; customer_kind?: 'HOSTELER' | 'WALKIN';
  tag_no?: string | null; student_photo?: string | null;
  // Two-sided register: what the student confirmed (SIGNATURE | PHONE | OVERRIDE | DISPUTED; null = not yet)
  dropoff_ack?: string | null; dropoff_ack_at?: string | null; dropoff_needed?: number; pickup_ack?: string | null; pickup_ack_at?: string | null;
  signoffs?: Signoff[];
  confirm_requests?: ConfirmRequest[];
};
export type Signoff = {
  id: number; kind: 'DROPOFF' | 'PICKUP'; method: 'SIGNATURE' | 'PHONE' | 'OVERRIDE'; status: 'CONFIRMED' | 'DISPUTED'; statement: string;
  signature: string | null; reason: string | null; created_at: string; superseded_at: string | null; returned_count: number | null; staff_name: string | null;
  proof_hash?: string; ip?: string | null; user_agent?: string | null;
};
export type ConfirmKind = 'DROPOFF' | 'PICKUP';
/** A code the counter is waiting for (staff see the status, never the code). */
export type ConfirmRequest = { kind: ConfirmKind; returned_count: number | null; note: string | null; pay_method: string | null; status: 'WAITING' | 'DISPUTED'; reason: string | null;
  tries: number; created_at: string; expires_at: string; seconds_left: number; staff_name: string };
/** Codes the counter is waiting for: the app shows a pop-up and makes the code from `key`. */
export type Pending = {
  requests: { order_id: number; kind: ConfirmKind; order_no: string; tag_no: string | null; staff_name: string; created_at: string; statement: string;
    key: string; step_seconds: number; pay_method: string | null; amount: number; seconds_left: number }[];
};
export type Student = {
  id: number; name: string; mobile: string; login_id: string; active: number; created_at: string; id_card_no: string; hostel_id: number; hostel_name: string;
  room_no: string; status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED'; review_note?: string | null; reviewed_at?: string | null; reviewed_by_name?: string | null;
  month_orders?: number; month_kg?: number; open_orders?: number;
  kind?: 'HOSTELER' | 'WALKIN'; valid_until?: string | null; valid_from?: string | null; claimable?: number; claimed_at?: string | null;
  photo?: string | null; email?: string | null; email_verified_at?: string | null; left_at?: string | null;
  pending_hostel_id?: number | null; pending_hostel_name?: string | null; pending_room_no?: string | null; change_requested_at?: string | null;
};
export type Plan = { hosteler: boolean; label: string };
export type Service = { id: number; name: string; unit: 'KG' | 'PIECE'; rate: number; hosteler_rate: number; uses_allowance: number; active: number; sort: number };
export type PaymentInfo = { upi_id: string; upi_name: string; has_upi_qr: boolean };
/** The server asks for the code it emailed before signing in. */
export type OtpStart = { otp_required: true; challenge: string; email_hint: string; purpose: 'LOGIN' | 'CLAIM' | 'SIGNUP' | 'EMAIL' | 'RESET' };
export type SignedIn = { user: User; claimed?: boolean };
export type Usage = { month: string; orders: number; kg: number; active: number; order_limit: number; kg_limit: number; kg_left: number | null; orders_left: number | null };
export type Hostel = { id: number; name: string; active?: number; students?: number };
export type Announcement = { id: number; title: string; body: string; created_at: string; expires_on: string | null; hostel_id: number | null; hostel_name: string | null; created_by_name?: string; expired?: number };
export type Complaint = {
  id: number; category: string; description: string; status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED'; photo: string | null; created_at: string; updated_at: string;
  order_no: string | null; order_id: number | null; student_name: string; id_card_no: string; room_no: string; hostel_name: string; mobile?: string; last_message?: string | null;
  updates?: { status: string | null; message: string | null; at: string; by_name: string; by_role: Role }[];
};
export type Notice = { id: number; title: string; body: string; order_id: number | null; read_at: string | null; created_at: string };

export class ApiError extends Error { constructor(public status: number, message: string, public details?: Record<string, any>) { super(message); } }

const listeners = new Set<() => void>();
/** Called when any request comes back 401, so the app can drop to the sign-in screen. */
export const onSignedOut = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const noServer = () => new ApiError(0, 'This app has no laundry server address yet. Set it on the sign-in screen, or ask the laundry office.');

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData; as?: 'blob' } = {}): Promise<T> {
  if (isApp && !serverAddress()) throw noServer();
  const headers = authHeaders();
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.body); }
  const sentWith = sessionGeneration();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { method: init.method || (body ? 'POST' : 'GET'), headers, body, credentials: isApp ? 'omit' : 'same-origin' });
  } catch {
    throw new ApiError(0, isApp ? `Could not reach the laundry server (${serverAddress().replace(/^https?:\/\//, '')}). Check your internet.` : 'No connection. Check your internet and try again.');
  }
  // A 401 only ends the session it was sent with. If someone signed in again or changed their
  // password while this request was in flight, the newer session stays.
  if (res.status === 401 && sentWith === sessionGeneration() && !path.startsWith('/auth/login')) {
    if (isApp && getToken()) await setToken(null);
    if (!path.startsWith('/auth/')) listeners.forEach(fn => fn());
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Request failed (${res.status}).`, data.details ?? undefined);
  }
  if (res.status === 204) return undefined as T;
  if (init.as === 'blob') return res.blob() as Promise<T>;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new ApiError(res.status, 'The laundry server sent an unexpected reply. Check the server address.');
  const data = await res.json();
  // A successful sign-in, sign-up, email code or password change starts a new session (new cookie or token).
  // "Check your email for a code" is not a session yet.
  if (/^\/auth\/(login|signup|password|otp|claim\/password)$/.test(path) && data && !data.otp_required) {
    if (isApp && typeof data.token === 'string') await setToken(data.token);
    else bumpSession();
    if (isApp && typeof data.deviceToken === 'string') await setDeviceToken(data.deviceToken);
  }
  return data as T;
}

/** Sign out: the website clears its cookie on the server; the app forgets its token and shared files. */
export async function signOutRequest() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  await setToken(null);
  clearExportsFolder();
}

/** Download a file from a GET endpoint (Excel export, backup). */
export async function download(path: string, fallbackName: string) {
  if (isApp && !serverAddress()) throw noServer();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { headers: authHeaders(), credentials: isApp ? 'omit' : 'same-origin' });
  } catch {
    throw new ApiError(0, 'No connection. Check your internet and try again.');
  }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.error || 'Download failed.'); }
  const name = safeFileName(/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName, fallbackName);
  return saveDownload(await res.blob(), name);
}

export async function saveDownload(blob: Blob, name: string) {
  if (isApp) return saveAndShare(blob, name);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Keep only a plain file name (no folders, no odd characters) before using it as a path. */
function safeFileName(name: string, fallback: string) {
  const base = name.split(/[\/]/).pop() ?? '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean || fallback;
}

/**
 * In the app a WebView can't "download" a blob, so write it to a private cache folder and open
 * the share sheet (Save to Files, Drive, WhatsApp…). The folder is emptied before each export,
 * on sign-out and at start, so admin backups don't pile up on the phone.
 */
async function saveAndShare(blob: Blob, name: string) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new ApiError(0, 'Could not read the downloaded file.'));
    r.readAsDataURL(blob);
  });
  await Filesystem.rmdir({ path: EXPORTS_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
  const written = await Filesystem.writeFile({ path: `${EXPORTS_DIR}/${name}`, data, directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: name, files: [written.uri] });
  } catch (e) {
    // Closing the share sheet is not an error.
    if (!/cancel/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

/** Load a private file (complaint photo) with this user's session and return a temporary object URL. */
export async function fileObjectUrl(name: string) {
  return blobUrl(`/files/${encodeURIComponent(name)}`);
}

/** Load any signed-in image (e.g. the UPI QR) and return a temporary object URL. */
export async function blobUrl(path: string) {
  const blob = await api<Blob>(path, { as: 'blob' });
  return URL.createObjectURL(blob);
}
