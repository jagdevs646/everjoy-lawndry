import { db } from './db.js';
import { HttpError, dayKey, nowIso } from './util.js';

/* Columns safe to show staff/admin. qr_token and request_id are never listed. */
const ORDER_COLS = `o.id, o.order_no, o.student_id, o.hostel_name, o.room_no, o.mobile, o.weight_kg, o.clothes_count, o.service, o.note,
  o.status, o.within_kg, o.extra_kg, o.amount, o.payment_status, o.paid_method, o.paid_ref, o.paid_at, o.received_at, o.day_key,
  o.expected_at, o.ready_at, o.delivered_at, o.returned_count, o.cancel_reason,
  u.name AS student_name, st.id_card_no, rb.name AS received_by_name, dl.name AS delivered_by_name,
  CASE WHEN o.status IN ('RECEIVED','WASHING') AND o.expected_at < @now THEN 1 ELSE 0 END AS late`;
const ORDER_FROM = `FROM orders o JOIN users u ON u.id = o.student_id JOIN students st ON st.user_id = o.student_id
  JOIN users rb ON rb.id = o.received_by LEFT JOIN users dl ON dl.id = o.delivered_by`;

export type OrderFilters = {
  status?: string; q?: string; from?: string; to?: string; hostel?: string; payment?: string; studentId?: number;
  limit?: number; offset?: number;
};

function orderWhere(f: OrderFilters) {
  const where: string[] = [];
  const p: Record<string, unknown> = { now: nowIso() };
  if (f.status === 'OPEN') where.push(`o.status IN ('RECEIVED','WASHING','READY')`);
  else if (f.status === 'LATE') where.push(`o.status IN ('RECEIVED','WASHING') AND o.expected_at < @now`);
  else if (f.status) { where.push('o.status = @status'); p.status = f.status; }
  if (f.payment) { where.push('o.payment_status = @payment'); p.payment = f.payment; }
  if (f.hostel) { where.push('o.hostel_name = @hostel'); p.hostel = f.hostel; }
  if (f.from) { where.push('o.day_key >= @from'); p.from = f.from; }
  if (f.to) { where.push('o.day_key <= @to'); p.to = f.to; }
  if (f.studentId) { where.push('o.student_id = @studentId'); p.studentId = f.studentId; }
  if (f.q) {
    const q = f.q.trim();
    const digits = q.replace(/^EJ-?/i, '');
    where.push(`(o.order_no = @orderNo OR st.id_card_no LIKE @like OR u.name LIKE @like OR o.room_no = @q OR o.mobile LIKE @like)`);
    Object.assign(p, { orderNo: `EJ-${digits}`, like: `%${q}%`, q });
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', p };
}

export function listOrders(f: OrderFilters) {
  const { sql, p } = orderWhere(f);
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 5000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const rows = db.prepare(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${sql} ORDER BY o.id DESC LIMIT ${limit} OFFSET ${offset}`).all(p);
  const total = (db.prepare(`SELECT COUNT(*) AS c ${ORDER_FROM} ${sql}`).get(p) as { c: number }).c;
  return { rows, total };
}

export function orderDetail(id: number, opts: { includeQr?: boolean } = {}): Record<string, any> {
  const o = db.prepare(`SELECT ${ORDER_COLS}${opts.includeQr ? ', o.qr_token' : ''} ${ORDER_FROM} WHERE o.id = @id`).get({ id, now: nowIso() }) as Record<string, unknown> | undefined;
  if (!o) throw new HttpError(404, 'Order not found.');
  const events = db.prepare(`SELECT e.type, e.note, e.at, u.name AS by_name, u.role AS by_role FROM order_events e LEFT JOIN users u ON u.id = e.by_user WHERE e.order_id = ? ORDER BY e.id`).all(id);
  return { ...o, events };
}

export function findOrderByCode(code: string) {
  const raw = code.trim();
  if (raw.startsWith('EJ:')) {
    const row = db.prepare('SELECT id FROM orders WHERE qr_token = ?').get(raw.slice(3)) as { id: number } | undefined;
    if (!row) throw new HttpError(404, 'This QR is not a valid Everjoy slip. Do not hand over clothes.');
    return { id: row.id, via: 'QR' as const };
  }
  const digits = raw.replace(/^EJ-?/i, '').replace(/\D/g, '');
  const row = digits ? db.prepare('SELECT id FROM orders WHERE order_no = ?').get(`EJ-${digits}`) as { id: number } | undefined : undefined;
  if (!row) throw new HttpError(404, `No order found for “${raw}”.`);
  return { id: row.id, via: 'NUMBER' as const };
}

const STUDENT_COLS = `u.id, u.name, u.mobile, u.login_id, u.active, u.created_at, u.must_change_password,
  st.id_card_no, st.hostel_id, h.name AS hostel_name, st.room_no, st.status, st.review_note, st.reviewed_at, rv.name AS reviewed_by_name`;
const STUDENT_FROM = `FROM users u JOIN students st ON st.user_id = u.id JOIN hostels h ON h.id = st.hostel_id LEFT JOIN users rv ON rv.id = st.reviewed_by`;

export function studentProfile(id: number) {
  const s = db.prepare(`SELECT ${STUDENT_COLS} ${STUDENT_FROM} WHERE u.id = ?`).get(id);
  if (!s) throw new HttpError(404, 'Student not found.');
  return s as Record<string, unknown> & { id: number; status: string; hostel_id: number; name: string; id_card_no: string };
}

export function listStudents(f: { q?: string; status?: string; hostelId?: number; limit?: number; offset?: number }) {
  const where: string[] = [];
  const p: Record<string, unknown> = { month: dayKey().slice(0, 7) };
  if (f.status) { where.push('st.status = @status'); p.status = f.status; }
  if (f.hostelId) { where.push('st.hostel_id = @hostelId'); p.hostelId = f.hostelId; }
  if (f.q) { where.push('(st.id_card_no LIKE @like OR u.name LIKE @like OR u.mobile LIKE @like OR st.room_no = @q)'); p.like = `%${f.q.trim()}%`; p.q = f.q.trim(); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const rows = db.prepare(`SELECT ${STUDENT_COLS},
      (SELECT COUNT(*) FROM orders o WHERE o.student_id = u.id AND o.month_key = @month AND o.status != 'CANCELLED') AS month_orders,
      (SELECT COALESCE(SUM(weight_kg),0) FROM orders o WHERE o.student_id = u.id AND o.month_key = @month AND o.status != 'CANCELLED') AS month_kg,
      (SELECT COUNT(*) FROM orders o WHERE o.student_id = u.id AND o.status IN ('RECEIVED','WASHING','READY')) AS open_orders
    ${STUDENT_FROM} ${sql} ORDER BY CASE st.status WHEN 'PENDING' THEN 0 ELSE 1 END, u.created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(p);
  const total = (db.prepare(`SELECT COUNT(*) AS c ${STUDENT_FROM} ${sql}`).get(p) as { c: number }).c;
  return { rows, total };
}

export function announcementsFor(hostelId: number | null) {
  const today = dayKey();
  return db.prepare(`SELECT a.id, a.title, a.body, a.created_at, a.expires_on, a.hostel_id, h.name AS hostel_name, u.name AS created_by_name
    FROM announcements a LEFT JOIN hostels h ON h.id = a.hostel_id LEFT JOIN users u ON u.id = a.created_by
    WHERE a.active = 1 AND (a.expires_on IS NULL OR a.expires_on >= @today) ${hostelId === null ? '' : 'AND (a.hostel_id IS NULL OR a.hostel_id = @hostelId)'}
    ORDER BY a.id DESC LIMIT 20`).all({ today, hostelId });
}

export function complaintDetail(id: number) {
  const c = db.prepare(`SELECT c.*, o.order_no, u.name AS student_name, st.id_card_no, h.name AS hostel_name, st.room_no, u.mobile
    FROM complaints c JOIN users u ON u.id = c.student_id JOIN students st ON st.user_id = c.student_id JOIN hostels h ON h.id = st.hostel_id
    LEFT JOIN orders o ON o.id = c.order_id WHERE c.id = ?`).get(id) as Record<string, unknown> & { student_id: number; status: string } | undefined;
  if (!c) throw new HttpError(404, 'Complaint not found.');
  const updates = db.prepare(`SELECT cu.status, cu.message, cu.at, u.name AS by_name, u.role AS by_role FROM complaint_updates cu LEFT JOIN users u ON u.id = cu.by_user WHERE cu.complaint_id = ? ORDER BY cu.id`).all(id);
  return { ...c, updates };
}

export function listComplaints(f: { studentId?: number; status?: string }) {
  const where: string[] = [];
  const p: Record<string, unknown> = {};
  if (f.studentId) { where.push('c.student_id = @studentId'); p.studentId = f.studentId; }
  if (f.status === 'OPEN') where.push(`c.status IN ('OPEN','IN_PROGRESS')`);
  else if (f.status) { where.push('c.status = @status'); p.status = f.status; }
  return db.prepare(`SELECT c.id, c.category, c.description, c.status, c.photo, c.created_at, c.updated_at, o.order_no, c.order_id,
      u.name AS student_name, st.id_card_no, st.room_no, h.name AS hostel_name,
      (SELECT message FROM complaint_updates cu WHERE cu.complaint_id = c.id AND cu.message IS NOT NULL ORDER BY cu.id DESC LIMIT 1) AS last_message
    FROM complaints c JOIN users u ON u.id = c.student_id JOIN students st ON st.user_id = c.student_id JOIN hostels h ON h.id = st.hostel_id
    LEFT JOIN orders o ON o.id = c.order_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE c.status WHEN 'RESOLVED' THEN 1 ELSE 0 END, c.updated_at DESC LIMIT 200`).all(p);
}
