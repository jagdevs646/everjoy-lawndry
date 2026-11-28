import { db } from './db.js';
import crypto from 'node:crypto';
import { QR_STEP_SECONDS, formatCard, getSettings, matchSeries, orderKeys, qrSignature } from './rules.js';
import { awaitingSql, codeKey, dayKey, HttpError, likeContains, nowIso } from './util.js';
import { signoffsFor } from './signoff.js';

/* Columns safe to show staff/admin. qr_token and request_id are never listed.
   The late flag takes one `?` (the current time), bound before any WHERE params. */
const ORDER_COLS = `o.id, o.order_no, o.student_id, o.hostel_name, o.room_no, o.mobile, o.weight_kg, o.clothes_count, o.service, o.note,
  o.status, o.within_kg, o.extra_kg, o.amount, o.payment_status, o.paid_method, o.paid_ref, o.paid_at, o.received_at, o.day_key,
  o.expected_at, o.ready_at, o.delivered_at, o.returned_count, o.cancel_reason,
  o.service_id, o.service_name, o.unit, o.rate, o.charge_note, st.kind AS customer_kind, o.tag_no, u.photo AS student_photo,
  o.dropoff_ack, o.dropoff_ack_at, o.pickup_ack, o.pickup_ack_at, o.dropoff_needed,
  u.name AS student_name, st.id_card_no, rb.name AS received_by_name, dl.name AS delivered_by_name,
  CASE WHEN o.status IN ('RECEIVED','WASHING') AND o.expected_at < ? THEN 1 ELSE 0 END AS late`;
const ORDER_FROM = `FROM orders o JOIN users u ON u.id = o.student_id JOIN students st ON st.user_id = o.student_id
  LEFT JOIN actor_names rb ON rb.id = o.received_by LEFT JOIN actor_names dl ON dl.id = o.delivered_by`;

export type OrderFilters = {
  status?: string; q?: string; from?: string; to?: string; hostel?: string; payment?: string; studentId?: number;
  limit?: number; offset?: number;
};

/** WHERE clause and its positional params, in the order the `?`s appear. */
function orderWhere(f: OrderFilters, now: string) {
  const where: string[] = [];
  const p: unknown[] = [];
  const waiting = awaitingSql('o.');
  if (f.status === 'OPEN') where.push(`o.status IN ('RECEIVED','WASHING','READY')`);
  // Clothes taken in, but the student has not confirmed with the code (or disputes): not received yet.
  else if (f.status === 'UNCONFIRMED' || f.status === 'UNSIGNED') where.push(waiting);
  else if (f.status === 'DISPUTED') where.push(`o.status IN ('RECEIVED','WASHING','READY') AND o.dropoff_ack = 'DISPUTED'`);
  else if (f.status === 'LATE') { where.push(`o.status IN ('RECEIVED','WASHING') AND o.expected_at < ?`); p.push(now); }
  else if (f.status) { where.push('o.status = ?'); p.push(f.status); }
  if (f.payment) { where.push('o.payment_status = ?'); p.push(f.payment); }
  if (f.hostel) { where.push('o.hostel_name = ?'); p.push(f.hostel); }
  if (f.from) { where.push('o.day_key >= ?'); p.push(f.from); }
  if (f.to) { where.push('o.day_key <= ?'); p.push(f.to); }
  if (f.studentId) { where.push('o.student_id = ?'); p.push(f.studentId); }
  if (f.q) {
    const q = f.q.trim();
    const like = likeContains(q);
    where.push(`(o.order_key = ? OR LOWER(o.order_no) LIKE LOWER(?) ESCAPE '\\' OR o.tag_key = ? OR LOWER(o.tag_no) LIKE LOWER(?) ESCAPE '\\' OR LOWER(st.id_card_no) LIKE LOWER(?) ESCAPE '\\' OR LOWER(u.name) LIKE LOWER(?) ESCAPE '\\' OR o.room_no = ? OR LOWER(o.mobile) LIKE LOWER(?) ESCAPE '\\')`);
    p.push(codeKey(q), like, codeKey(q), like, like, like, q, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', p };
}

export async function listOrders(f: OrderFilters) {
  const now = nowIso();
  const { sql, p } = orderWhere(f, now);
  const limit = Math.min(Math.max(Math.trunc(Number(f.limit)) || 50, 1), 5000);
  const offset = Math.max(Math.trunc(Number(f.offset)) || 0, 0);
  const rows = await db.all(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${sql} ORDER BY o.id DESC LIMIT ${limit} OFFSET ${offset}`, [now, ...p]);
  const total = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c ${ORDER_FROM} ${sql}`, p))!.c;
  return { rows, total };
}

export async function orderDetail(id: number, opts: { includeQr?: boolean } = {}): Promise<Record<string, any>> {
  const o = await db.get<Record<string, unknown>>(`SELECT ${ORDER_COLS}${opts.includeQr ? ', o.qr_token' : ''} ${ORDER_FROM} WHERE o.id = ?`, [nowIso(), id]);
  if (!o) throw new HttpError(404, 'Order not found.');
  const events = await db.all(`SELECT e.type, e.note, e.at, u.name AS by_name, u.role AS by_role FROM order_events e LEFT JOIN users u ON u.id = e.by_user WHERE e.order_id = ? ORDER BY e.id`, [id]);
  const signoffs = await signoffsFor(id, !!opts.includeQr);
  // Codes the counter is waiting for (staff see the status, never the code).
  const requests = opts.includeQr ? [] : (await db.all<Record<string, unknown> & { expires_at: string }>(`SELECT r.kind, r.returned_count, r.note, r.pay_method, r.status, r.reason, r.tries,
      r.created_at, r.expires_at, u.name AS staff_name FROM confirm_requests r JOIN users u ON u.id = r.staff_id WHERE r.order_id = ? AND r.expires_at > ?`, [id, nowIso()]))
    .map(r => ({ ...r, seconds_left: Math.max(0, Math.round((Date.parse(r.expires_at) - Date.now()) / 1000)) }));
  return { ...o, events, signoffs, confirm_requests: requests };
}

export async function findOrderByCode(code: string) {
  const raw = code.trim();
  if (raw.startsWith('EJ2:')) {
    // Rotating slip QR: right order, right signature, made within the last ~2 minutes (phone clocks drift a little).
    const m = /^EJ2:(\d{1,10})\.(\d{1,12})\.([A-Za-z0-9_-]{16})$/.exec(raw);
    const row = m ? await db.get<{ id: number; qr_token: string }>('SELECT id, qr_token FROM orders WHERE id = ?', [Number(m[1])]) : undefined;
    if (!m || !row) throw new HttpError(404, 'This QR is not a valid Everjoy slip. Do not hand over clothes.');
    const step = Number(m[2]);
    const now = Math.floor(Date.now() / 1000 / QR_STEP_SECONDS);
    const want = Buffer.from(qrSignature(row.qr_token, row.id, step));
    const got = Buffer.from(m[3]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(404, 'This QR is not a valid Everjoy slip. Do not hand over clothes.');
    if (Math.abs(step - now) > 4) throw new HttpError(409, 'This slip QR is from another time: a screenshot, or the phone clock is wrong. Ask the student to open the slip again (with automatic time on), or check their ID card and use the card no.');
    return { id: row.id, via: 'QR' as const };
  }
  if (raw.startsWith('EJ:')) {
    // The old fixed QR could be screenshotted and shared, so it is no longer accepted.
    throw new HttpError(409, 'This is an old-style slip QR. Ask the student to update the app or reload the website and open the slip again, or check their ID card and use the card no.');
  }
  // Typed with or without signs, spaces and leading zeros: "ej 1042", "a-0012", "inv 26 27 7".
  const key = codeKey(raw);
  if (!key) throw new HttpError(404, `No open basket card or order found for “${raw}”.`);
  const s = await getSettings();
  // An order no.: exactly, or (only digits typed) the number part in today's style or the old EJ- style.
  type Hit = { id: number; order_no: string; tag_no: string | null };
  const byKeys = (keys: string[]) => db.all<Hit>(`SELECT id, order_no, tag_no FROM orders WHERE order_key IN (${keys.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 5`, keys);
  let orders = await byKeys([key]);
  if (!orders.length && /^\d+$/.test(key)) orders = await byKeys(orderKeys(s.order_no_format, raw));
  // A basket card on an order that hasn't been collected yet (one card is on one open basket at most).
  // Only the number typed: the card with that number in any series (A256, BLUE-256…).
  const cardKeys = [...new Set([key, ...(/^\d{1,9}$/.test(key) ? s.card_series.filter(x => +key >= x.from && +key <= x.to).map(x => codeKey(formatCard(x, +key))) : [])])];
  const cardHits = await db.all<Hit>(`SELECT id, order_no, tag_no FROM orders WHERE tag_key IN (${cardKeys.map(() => '?').join(',')}) AND status IN ('RECEIVED','WASHING','READY')`, cardKeys);
  if (cardHits.length > 1) throw new HttpError(409, `More than one basket has a card with this no.: ${cardHits.map(h => `${h.tag_no} on ${h.order_no}`).join(', ')}. Type the full card no.`);
  const c = cardHits[0];
  const o = orders[0];
  if (orders.length > 1) throw new HttpError(409, `More than one order matches “${raw}”: ${orders.map(x => x.order_no).join(', ')}. Type the full order no.`);
  if (c && o && c.id !== o.id) throw new HttpError(409, `Card ${c.tag_no} is on ${c.order_no}, and there is also an order ${o.order_no}. Type the full order no. for the order, or check the card.`);
  if (c) return { id: c.id, via: 'CARD' as const };
  if (o) return { id: o.id, via: 'NUMBER' as const };
  const card = matchSeries(s.card_series, raw);
  if (card) throw new HttpError(404, `No basket is waiting on card ${card}.`);
  throw new HttpError(404, `No open basket card or order found for “${raw}”.`);
}

const STUDENT_COLS = `u.id, u.name, u.mobile, u.login_id, u.active, u.created_at, u.must_change_password,
  st.id_card_no, st.hostel_id, h.name AS hostel_name, st.room_no, st.status, st.review_note, st.reviewed_at, rv.name AS reviewed_by_name,
  st.kind, st.valid_until, st.valid_from, st.claimable, st.claimed_at, st.pending_hostel_id, ph.name AS pending_hostel_name, st.pending_room_no, st.change_requested_at,
  u.photo, st.email, st.email_verified_at, st.left_at`;
const STUDENT_FROM = `FROM users u JOIN students st ON st.user_id = u.id JOIN hostels h ON h.id = st.hostel_id LEFT JOIN users rv ON rv.id = st.reviewed_by
  LEFT JOIN hostels ph ON ph.id = st.pending_hostel_id`;

export async function studentProfile(id: number) {
  const s = await db.get<Record<string, unknown> & { id: number; status: string; hostel_id: number; name: string; id_card_no: string }>(
    `SELECT ${STUDENT_COLS} ${STUDENT_FROM} WHERE u.id = ?`, [id]);
  if (!s) throw new HttpError(404, 'Student not found.');
  return s;
}

export async function listStudents(f: { q?: string; status?: string; hostelId?: number; plan?: 'EXPIRED' | 'VALID' | 'UPCOMING' | 'WALKIN' | ''; limit?: number; offset?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  const month = dayKey().slice(0, 7);
  // Students who left the hostel are hidden unless asked for ("Left hostel").
  if (f.status === 'LEFT') where.push('st.left_at IS NOT NULL');
  else {
    where.push('st.left_at IS NULL');
    if (f.status === 'UNCLAIMED') where.push('st.claimable = 1');
    else if (f.status) { where.push('st.status = ?'); p.push(f.status); }
  }
  if (f.plan === 'WALKIN') where.push("st.kind = 'WALKIN'");
  else if (f.plan === 'EXPIRED') { where.push("st.kind = 'HOSTELER' AND st.valid_until IS NOT NULL AND st.valid_until < ?"); p.push(dayKey()); }
  else if (f.plan === 'VALID') { where.push("st.kind = 'HOSTELER' AND (st.valid_from IS NULL OR st.valid_from <= ?) AND (st.valid_until IS NULL OR st.valid_until >= ?)"); p.push(dayKey(), dayKey()); }
  else if (f.plan === 'UPCOMING') { where.push("st.kind = 'HOSTELER' AND st.valid_from IS NOT NULL AND st.valid_from > ?"); p.push(dayKey()); }
  if (f.hostelId) { where.push('st.hostel_id = ?'); p.push(f.hostelId); }
  if (f.q) {
    const q = f.q.trim();
    const like = likeContains(q);
    where.push("(LOWER(st.id_card_no) LIKE LOWER(?) ESCAPE '\\' OR LOWER(u.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(u.mobile) LIKE LOWER(?) ESCAPE '\\' OR st.room_no = ?)");
    p.push(like, like, like, q);
  }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Math.trunc(Number(f.limit)) || 50, 1), 1000);
  const offset = Math.max(Math.trunc(Number(f.offset)) || 0, 0);
  // The two month subqueries come before the WHERE, so the month is bound twice ahead of the filter params.
  const rows = await db.all(`SELECT ${STUDENT_COLS},
      (SELECT COUNT(*) FROM orders o WHERE o.student_id = u.id AND o.month_key = ? AND o.status != 'CANCELLED') AS month_orders,
      (SELECT COALESCE(SUM(weight_kg),0) FROM orders o WHERE o.student_id = u.id AND o.month_key = ? AND o.status != 'CANCELLED') AS month_kg,
      (SELECT COUNT(*) FROM orders o WHERE o.student_id = u.id AND o.status IN ('RECEIVED','WASHING','READY')) AS open_orders
    ${STUDENT_FROM} ${sql} ORDER BY CASE st.status WHEN 'PENDING' THEN 0 ELSE 1 END, u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    [month, month, ...p]);
  const total = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c ${STUDENT_FROM} ${sql}`, p))!.c;
  return { rows, total };
}

export async function announcementsFor(hostelId: number | null) {
  const today = dayKey();
  const p: unknown[] = [today];
  if (hostelId !== null) p.push(hostelId);
  return db.all(`SELECT a.id, a.title, a.body, a.created_at, a.expires_on, a.hostel_id, h.name AS hostel_name, u.name AS created_by_name
    FROM announcements a LEFT JOIN hostels h ON h.id = a.hostel_id LEFT JOIN users u ON u.id = a.created_by
    WHERE a.active = 1 AND (a.expires_on IS NULL OR a.expires_on >= ?) ${hostelId === null ? '' : 'AND (a.hostel_id IS NULL OR a.hostel_id = ?)'}
    ORDER BY a.id DESC LIMIT 20`, p);
}

export async function complaintDetail(id: number) {
  const c = await db.get<Record<string, unknown> & { student_id: number; status: string }>(`SELECT c.*, o.order_no, u.name AS student_name, st.id_card_no, h.name AS hostel_name, st.room_no, u.mobile
    FROM complaints c JOIN users u ON u.id = c.student_id JOIN students st ON st.user_id = c.student_id JOIN hostels h ON h.id = st.hostel_id
    LEFT JOIN orders o ON o.id = c.order_id WHERE c.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Complaint not found.');
  const updates = await db.all(`SELECT cu.status, cu.message, cu.at, u.name AS by_name, u.role AS by_role FROM complaint_updates cu LEFT JOIN users u ON u.id = cu.by_user WHERE cu.complaint_id = ? ORDER BY cu.id`, [id]);
  return { ...c, updates };
}

export async function listComplaints(f: { studentId?: number; status?: string; q?: string; category?: string; limit?: number; offset?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.studentId) { where.push('c.student_id = ?'); p.push(f.studentId); }
  if (f.status === 'OPEN') where.push(`c.status IN ('OPEN','IN_PROGRESS')`);
  else if (f.status === 'NEW') where.push(`c.status = 'OPEN'`);
  else if (f.status) { where.push('c.status = ?'); p.push(f.status); }
  if (f.category) { where.push('c.category = ?'); p.push(f.category); }
  if (f.q?.trim()) {
    const like = likeContains(f.q.trim());
    where.push(`(LOWER(u.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(st.id_card_no) LIKE LOWER(?) ESCAPE '\\' OR LOWER(c.description) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(o.order_no) LIKE LOWER(?) ESCAPE '\\' OR st.room_no = ?)`);
    p.push(like, like, like, like, f.q.trim());
  }
  const limit = Math.min(Math.max(Math.trunc(Number(f.limit)) || 200, 1), 1000);
  const offset = Math.max(Math.trunc(Number(f.offset)) || 0, 0);
  const from = `FROM complaints c JOIN users u ON u.id = c.student_id JOIN students st ON st.user_id = c.student_id JOIN hostels h ON h.id = st.hostel_id
    LEFT JOIN orders o ON o.id = c.order_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return db.all(`SELECT c.id, c.category, c.description, c.status, c.photo, c.created_at, c.updated_at, o.order_no, c.order_id,
      u.name AS student_name, st.id_card_no, st.room_no, h.name AS hostel_name,
      (SELECT message FROM complaint_updates cu WHERE cu.complaint_id = c.id AND cu.message IS NOT NULL ORDER BY cu.id DESC LIMIT 1) AS last_message
    ${from} ORDER BY CASE c.status WHEN 'RESOLVED' THEN 1 ELSE 0 END, c.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, p)
    .then(async rows => Object.assign(rows, { total: Number((await db.get<{ c: number }>(`SELECT COUNT(*) AS c ${from}`, p))?.c ?? 0) }));
}
