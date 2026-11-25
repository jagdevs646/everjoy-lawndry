import crypto from 'node:crypto';
import { db, insertId, logActivity, notify } from './db.js';
import { HttpError, nowIso } from './util.js';
import { slipKey } from './auth.js';

/**
 * Two-sided register: the student confirms what they handed in and what they got back, the way they
 * signed the paper register before, but with a code instead of a signature.
 *
 * When staff take an order, or press "Hand over" after counting the clothes back, a pop-up opens on the
 * student's app with what they confirm ("I received 12 of 12 clothes…") and a 6-digit code that changes
 * every 30 seconds. The student reads it out and staff type it in: that proves the student is at the
 * counter with their own phone and agrees. "Something is wrong" on the pop-up records a dispute and opens
 * a complaint. Walk-in customers (no app) are confirmed by the staff member at the counter. Only the admin
 * can hand over without the code, and must write why.
 *
 * Every confirmation keeps the exact sentence, who was at the counter, the time, the device and a SHA-256
 * fingerprint over all of it, so a record changed afterwards no longer matches its fingerprint.
 */

export type SignKind = 'DROPOFF' | 'PICKUP';
export type Proof =
  | { method: 'CODE' }                                        // the student read the code from their app to staff
  | { method: 'COUNTER' }                                     // walk-in customer (no app), confirmed by staff
  | { method: 'OVERRIDE'; reason: string }                    // admin only, with a written reason
  | { method: 'PHONE' }                                       // older records
  | { method: 'SIGNATURE'; signature: string };               // older records

/** Acks that mean "the drop-off / collection was confirmed". */
export const CONFIRMED_ACKS = ['CODE', 'COUNTER', 'SIGNATURE', 'PHONE'];
export const isConfirmed = (ack: string | null | undefined) => !!ack && CONFIRMED_ACKS.includes(ack);

/** Who sent the confirmation: kept as evidence. */
export type Origin = { ip?: string; userAgent?: string };

const MAX_SIGNATURE_BYTES = 60 * 1024;
export const REQUEST_MINUTES = 10;            // a confirmation request stays open this long
export const CODE_STEP_SECONDS = 30;          // the code on the student's screen changes this often
const MAX_TRIES = 5;                          // wrong codes before the request is cancelled

const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: process.env.APP_TZ || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const kgText = (n: number) => `${Math.round(Number(n) * 10) / 10} kg`;

type OrderForSign = {
  id: number; order_no: string; student_id: number; status: string; clothes_count: number; weight_kg: number; service_name: string | null;
  tag_no: string | null; dropoff_ack: string | null; pickup_ack: string | null; student_name: string; id_card_no: string;
};

export async function orderForSign(id: number) {
  const o = await db.get<OrderForSign>(`SELECT o.id, o.order_no, o.student_id, o.status, o.clothes_count, o.weight_kg, o.service_name, o.tag_no,
      o.dropoff_ack, o.pickup_ack, u.name AS student_name, st.id_card_no
    FROM orders o JOIN users u ON u.id = o.student_id JOIN students st ON st.user_id = o.student_id WHERE o.id = ?`, [id]);
  if (!o) throw new HttpError(404, 'Order not found.');
  return o;
}

/** The sentence the student agrees to: shown before they sign, and stored with the signature. */
export function statementFor(kind: SignKind, o: OrderForSign, at: string, returned?: number, note?: string) {
  const who = `I, ${o.student_name} (ID ${o.id_card_no})`;
  const card = o.tag_no ? `, basket card ${o.tag_no}` : '';
  if (kind === 'DROPOFF') {
    const w = Number(o.weight_kg) > 0 ? ` (${kgText(o.weight_kg)})` : '';
    return `${who}, gave ${o.clothes_count} clothes${w} for ${o.service_name || 'Wash & fold'} at the Everjoy laundry counter, order ${o.order_no}${card}, on ${time(at)}.`;
  }
  const r = returned ?? o.clothes_count;
  return `${who}, received ${r} of the ${o.clothes_count} clothes I gave for order ${o.order_no}${card}, on ${time(at)}.${note ? ` Staff note: ${note}` : ''}`;
}

/**
 * A short fingerprint of what the student is shown (without the time), sent back with their answer. If
 * staff changed the order or the hand-over in between, the answer is refused and the student checks again.
 */
export function shownVersion(parts: unknown[]) {
  return crypto.createHash('sha256').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}
export const dropoffVersion = (o: Pick<OrderForSign, 'clothes_count' | 'weight_kg' | 'tag_no' | 'service_name' | 'order_no'>) =>
  shownVersion(['D', o.order_no, o.clothes_count, Number(o.weight_kg), o.tag_no, o.service_name]);
export const handoverVersion = (o: Pick<OrderForSign, 'clothes_count' | 'order_no'>, h: { created_at: string; returned_count: number; note: string | null; pay_method: string | null }) =>
  shownVersion(['H', o.order_no, o.clothes_count, h.created_at, h.returned_count, h.note, h.pay_method]);

/** A finger signature from the counter screen: a small PNG. Returns its stored file name and SHA-256. */
export async function saveSignature(dataUrl: string) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new HttpError(400, 'The signature did not come through. Ask the student to sign again.');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new HttpError(400, 'The signature image is too large. Clear it and sign again.');
  if (bytes.length < 200 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new HttpError(400, 'The signature did not come through. Ask the student to sign again.');
  }
  const name = `sig-${crypto.randomBytes(16).toString('hex')}.png`;
  await db.run('INSERT INTO files (name, mime, data, created_at) VALUES (?,?,?,?)', [name, 'image/png', bytes, nowIso()]);
  return { name, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Fingerprint over everything that was agreed to. Recomputed by verifySignoff. */
function fingerprint(r: { order_id: number; kind: string; method: string; status: string; statement: string; signature_sha: string | null; student_id: number; staff_id: number | null; reason: string | null; created_at: string }) {
  return crypto.createHash('sha256').update([r.order_id, r.kind, r.method, r.status, r.statement, r.signature_sha ?? '', r.student_id, r.staff_id ?? '', r.reason ?? '', r.created_at].join('|')).digest('hex');
}

/**
 * Save one confirmation (or dispute) and mark it on the order. Call inside the caller's transaction,
 * with the order row locked.
 */
export async function recordSignoff(p: {
  o: OrderForSign; kind: SignKind; proof: Proof | { method: 'PHONE'; dispute: string }; staffId: number | null; at: string;
  statement: string; origin?: Origin; returned?: number;
}) {
  const disputed = 'dispute' in p.proof;
  const status = disputed ? 'DISPUTED' : 'CONFIRMED';
  let signature: string | null = null;
  let sigSha: string | null = null;
  if (p.proof.method === 'SIGNATURE') ({ name: signature, sha: sigSha } = await saveSignature(p.proof.signature));
  const reason = 'dispute' in p.proof ? p.proof.dispute : p.proof.method === 'OVERRIDE' ? p.proof.reason : null;
  const row = { order_id: p.o.id, kind: p.kind, method: p.proof.method, status, statement: p.statement, signature_sha: sigSha, student_id: p.o.student_id, staff_id: p.staffId, reason, created_at: p.at };
  const id = await insertId(`INSERT INTO order_signoffs (order_id, kind, method, status, statement, signature, signature_sha, student_id, staff_id, reason,
      clothes, returned_count, ip, user_agent, proof_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    row.order_id, row.kind, row.method, row.status, row.statement, signature, sigSha, row.student_id, row.staff_id, row.reason,
    p.o.clothes_count, p.returned ?? null, (p.origin?.ip ?? '').slice(0, 64) || null, (p.origin?.userAgent ?? '').slice(0, 200) || null, fingerprint(row), p.at,
  ]);
  const ack = disputed ? 'DISPUTED' : p.proof.method;
  if (p.kind === 'DROPOFF') await db.run('UPDATE orders SET dropoff_ack = ?, dropoff_ack_at = ?, updated_at = ? WHERE id = ?', [ack, p.at, p.at, p.o.id]);
  else await db.run('UPDATE orders SET pickup_ack = ?, pickup_ack_at = ?, updated_at = ? WHERE id = ?', [ack, p.at, p.at, p.o.id]);
  const how = p.proof.method === 'CODE' ? 'confirmed with the code on their phone' : p.proof.method === 'COUNTER' ? 'walk-in customer, confirmed at the counter'
    : p.proof.method === 'SIGNATURE' ? 'signed at the counter' : p.proof.method === 'PHONE' ? 'confirmed on their phone'
    : p.kind === 'DROPOFF' ? `drop-off counted as received by the admin without the student's code: ${reason}` : `handed over without the student's confirmation: ${reason}`;
  const what = p.kind === 'DROPOFF' ? 'drop-off' : 'collection';
  await db.run('INSERT INTO order_events (order_id, type, note, by_user, at) VALUES (?,?,?,?,?)', [
    p.o.id, disputed ? `${p.kind}_DISPUTED` : `${p.kind}_SIGNED`, disputed ? `Student disputes the ${what}: ${reason}` : p.proof.method === 'OVERRIDE' ? `Admin: ${how}` : `Student ${how}`,
    disputed ? p.o.student_id : p.staffId, p.at,
  ]);
  await logActivity(disputed ? p.o.student_id : p.staffId, disputed ? `${p.kind}_DISPUTED` : p.proof.method === 'OVERRIDE' ? `${p.kind}_OVERRIDE` : `${p.kind}_SIGNED`,
    'order', p.o.order_no, disputed ? String(reason) : p.proof.method === 'OVERRIDE' ? String(reason) : how);
  return id;
}

/** Recompute a confirmation's fingerprint: false means the stored record was changed after it was made. */
export async function verifySignoff(id: number) {
  const r = await db.get<{ order_id: number; kind: string; method: string; status: string; statement: string; signature: string | null; signature_sha: string | null;
    student_id: number; staff_id: number | null; reason: string | null; created_at: string; proof_hash: string }>('SELECT * FROM order_signoffs WHERE id = ?', [id]);
  if (!r) return false;
  if (r.signature) {
    const f = await db.get<{ data: Buffer | Uint8Array }>('SELECT data FROM files WHERE name = ?', [r.signature]);
    if (!f || crypto.createHash('sha256').update(Buffer.from(f.data)).digest('hex') !== r.signature_sha) return false;
  }
  return fingerprint(r) === r.proof_hash;
}

/** A complaint opened for the student when they dispute (does not count against their open-complaint limit). */
export async function disputeComplaint(o: OrderForSign, kind: SignKind, reason: string, at: string) {
  const id = await insertId('INSERT INTO complaints (student_id, order_id, category, description, created_at, updated_at) VALUES (?,?,?,?,?,?)', [
    o.student_id, o.id, kind === 'DROPOFF' ? 'Wrong count' : 'Missing clothes',
    `${kind === 'DROPOFF' ? 'I did not confirm this drop-off' : 'I did not confirm this collection'}: ${reason}`, at, at,
  ]);
  await db.run('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)', [id, o.student_id, 'OPEN', null, at]);
  return id;
}

/** The student's history of confirmations for an order (newest first). Hidden details stay with staff. */
export async function signoffsFor(orderId: number, forStudent = false) {
  const rows = await db.all<Record<string, unknown>>(`SELECT s.id, s.kind, s.method, s.status, s.statement, s.signature, s.reason, s.created_at, s.superseded_at,
      s.returned_count, st.name AS staff_name${forStudent ? '' : ', s.proof_hash, s.ip, s.user_agent'}
    FROM order_signoffs s LEFT JOIN users st ON st.id = s.staff_id WHERE s.order_id = ? ORDER BY s.id DESC`, [orderId]);
  return rows;
}

/** The student must confirm again after staff correct the count or weight they confirmed. */
export async function resetDropoff(o: { id: number; order_no: string; student_id: number }, actorId: number, at: string) {
  await db.run(`UPDATE order_signoffs SET superseded_at = ? WHERE order_id = ? AND kind = 'DROPOFF' AND superseded_at IS NULL`, [at, o.id]);
  await db.run('UPDATE orders SET dropoff_ack = NULL, dropoff_ack_at = NULL WHERE id = ?', [o.id]);
  await db.run('INSERT INTO order_events (order_id, type, note, by_user, at) VALUES (?,?,?,?,?)', [o.id, 'DROPOFF_RESET', 'Details changed: the student must confirm the drop-off again', actorId, at]);
  await notify(o.student_id, `Confirm ${o.order_no} again`, 'The counter corrected your order. Open the app and confirm the new count, or say what is wrong.', o.id);
}

/* --------------------------------------------------- confirmation requests */

export type ConfirmRequest = {
  order_id: number; kind: SignKind; staff_id: number; secret: string; returned_count: number | null; note: string | null;
  pay_method: 'CASH' | 'UPI' | null; pay_ref: string | null; status: 'WAITING' | 'DISPUTED'; reason: string | null; tries: number; created_at: string; expires_at: string;
};

/** The key the student's app gets to make the codes (never the secret itself). */
export const requestKey = (r: Pick<ConfirmRequest, 'secret'>) => slipKey(`confirm:${r.secret}`);

/** The 6-digit code for one 30-second step. The app makes the same code from the key. */
export function confirmCode(key: string, orderId: number, kind: SignKind, step: number) {
  const h = crypto.createHmac('sha256', key).update(`code.${orderId}.${kind}.${step}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 1000 / CODE_STEP_SECONDS);

export async function getRequest(orderId: number, kind: SignKind) {
  return db.get<ConfirmRequest>('SELECT * FROM confirm_requests WHERE order_id = ? AND kind = ?', [orderId, kind]);
}

/** Ask the student to confirm: a pop-up with the code opens on their app. Replaces an earlier request. */
export async function openRequest(o: OrderForSign, kind: SignKind, staffId: number, extra: { returned_count?: number; note?: string; pay_method?: string | null; pay_ref?: string } = {}) {
  const at = nowIso();
  await db.run('DELETE FROM confirm_requests WHERE order_id = ? AND kind = ?', [o.id, kind]);
  await db.run(`INSERT INTO confirm_requests (order_id, kind, staff_id, secret, returned_count, note, pay_method, pay_ref, status, tries, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [o.id, kind, staffId, crypto.randomBytes(18).toString('base64url'), extra.returned_count ?? null, extra.note || null,
    extra.pay_method ?? null, extra.pay_ref || null, 'WAITING', 0, at, new Date(Date.now() + REQUEST_MINUTES * 60_000).toISOString()]);
  await notify(o.student_id, kind === 'DROPOFF' ? `Confirm your drop-off ${o.order_no}` : `Confirm you received ${o.order_no}`,
    'Open the app: tell the staff the code on your screen to confirm.', o.id);
}

/**
 * Check a code staff typed. Wrong codes count (outside any transaction, so they stick); after 5 the
 * request is cancelled. The current code and the one just before it are accepted (time to read it out).
 */
export async function checkRequestCode(orderId: number, kind: SignKind, code: string) {
  const r = await getRequest(orderId, kind);
  if (!r) throw new HttpError(409, 'Nothing is waiting for a code. Press the button again to send the student a new code.');
  if (r.status !== 'WAITING') throw new HttpError(409, `The student said something is wrong: “${r.reason}”. Sort it out, then send a new code.`);
  if (r.expires_at <= nowIso()) throw new HttpError(409, 'The code request expired. Send the student a new code.');
  const key = requestKey(r);
  const step = stepNow();
  const ok = [step, step - 1].some(s => crypto.timingSafeEqual(Buffer.from(confirmCode(key, orderId, kind, s)), Buffer.from(code.padStart(6, '0').slice(0, 6))));
  if (ok) return r;
  const tries = Number(r.tries) + 1;
  if (tries >= MAX_TRIES) {
    await db.run('DELETE FROM confirm_requests WHERE order_id = ? AND kind = ?', [orderId, kind]);
    throw new HttpError(429, 'Too many wrong codes. Send the student a new code.');
  }
  await db.run('UPDATE confirm_requests SET tries = ? WHERE order_id = ? AND kind = ?', [tries, orderId, kind]);
  throw new HttpError(422, `That code is not right. Ask the student to read the code on their screen again (${MAX_TRIES - tries} tries left).`);
}
