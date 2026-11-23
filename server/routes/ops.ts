import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, logActivity, notify } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { cancelOrder, correctOrder, createOrder, deliverOrder, getOrderRow, getSettings, monthUsage, orderInput, quote, recordPayment, setStatus } from '../rules.js';
import { announcementsFor, complaintDetail, findOrderByCode, listComplaints, listOrders, listStudents, orderDetail, studentProfile } from '../queries.js';
import { HttpError, dayKey, handle, nowIso, parse, startOfLocalDayIso, zId, zText } from '../util.js';
import { normaliseLogin, zIdCard, zMobile, zRoom } from './public.js';

export const router = Router();
router.use('/ops', requireRole('STAFF', 'ADMIN'));

const actor = (req: unknown) => (req as AuthedRequest).user;
const isAdmin = (req: unknown) => actor(req).role === 'ADMIN';

/** Readable temporary password, e.g. "wash-4821". Shown once to staff, who tells the student. */
export const tempPassword = () => `${['wash', 'fold', 'iron', 'fresh', 'clean', 'soap'][crypto.randomInt(6)]}-${crypto.randomInt(1000, 9999)}`;

router.get('/ops/summary', handle((_req, res) => {
  const today = dayKey();
  const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
  res.json({
    today: {
      received: one(`SELECT COUNT(*) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      kg: one(`SELECT COALESCE(ROUND(SUM(weight_kg),1),0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      clothes: one(`SELECT COALESCE(SUM(clothes_count),0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      delivered: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'DELIVERED' AND delivered_at >= ?`, startOfLocalDayIso()),
      collected: one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE payment_status = 'PAID' AND paid_at >= ?`, startOfLocalDayIso()),
    },
    open: {
      received: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'RECEIVED'`),
      washing: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'WASHING'`),
      ready: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY'`),
      late: one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING') AND expected_at < ?`, nowIso()),
    },
    pending_students: one(`SELECT COUNT(*) AS c FROM students WHERE status = 'PENDING'`),
    open_complaints: one(`SELECT COUNT(*) AS c FROM complaints WHERE status != 'RESOLVED'`),
    dues: one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE payment_status = 'DUE' AND status != 'CANCELLED'`),
    settings: pickSettings(),
    announcements: announcementsFor(null).slice(0, 2),
  });
}));

function pickSettings() {
  const s = getSettings();
  return {
    max_kg_per_order: s.max_kg_per_order, express_enabled: s.express_enabled, express_fee: s.express_fee, pay_before_pickup: s.pay_before_pickup,
    monthly_kg_limit: s.monthly_kg_limit, monthly_order_limit: s.monthly_order_limit, max_active_orders: s.max_active_orders,
    regular_rate_per_kg: s.regular_rate_per_kg, extra_rate_per_kg: s.extra_rate_per_kg, upi_id: s.upi_id,
  };
}

/* ---------------------------------------------------------------- students */

router.get('/ops/students', handle((req, res) => {
  const q = parse(z.object({ q: z.string().optional(), status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional().or(z.literal('')), hostelId: z.coerce.number().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }), req.query);
  res.json(listStudents({ ...q, status: q.status || undefined }));
}));

/** Counter lookup: exact ID card match (typed, USB scanner, or the student's own ID QR) plus fuzzy suggestions. */
router.get('/ops/students/lookup', handle((req, res) => {
  const raw = String(req.query.code || '').trim();
  if (!raw) throw new HttpError(400, 'Enter or scan an ID card no.');
  const code = normaliseLogin(raw.replace(/^EJS:/i, ''));
  const hit = db.prepare('SELECT user_id FROM students WHERE id_card_no = ?').get(code) as { user_id: number } | undefined;
  if (hit) return res.json({ student: counterCard(hit.user_id), suggestions: [] });
  res.json({ student: null, suggestions: raw.length >= 2 ? listStudents({ q: raw, limit: 8 }).rows : [] });
}));

function counterCard(id: number) {
  const open = db.prepare(`SELECT id, order_no, status, clothes_count, weight_kg, amount, payment_status, received_at, expected_at FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY') ORDER BY id`).all(id);
  return { ...studentProfile(id), usage: monthUsage(id), open };
}

router.get('/ops/students/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  res.json({ ...counterCard(id), orders: listOrders({ studentId: id, limit: 50 }).rows });
}));

router.patch('/ops/students/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const before = studentProfile(id);
  const b = parse(z.object({ name: zText(2, 80), idCardNo: zIdCard, mobile: zMobile, hostelId: z.coerce.number().int().positive(), roomNo: zRoom }), req.body);
  if (!db.prepare('SELECT 1 FROM hostels WHERE id = ?').get(b.hostelId)) throw new HttpError(400, 'Choose a hostel.');
  if (b.idCardNo !== before.id_card_no && db.prepare('SELECT 1 FROM users WHERE login_id = ? AND id != ?').get(b.idCardNo, id)) throw new HttpError(409, 'Another account already uses that ID card no.');
  db.transaction(() => {
    db.prepare('UPDATE users SET name = ?, mobile = ?, login_id = ? WHERE id = ?').run(b.name, b.mobile, b.idCardNo, id);
    db.prepare('UPDATE students SET id_card_no = ?, hostel_id = ?, room_no = ? WHERE user_id = ?').run(b.idCardNo, b.hostelId, b.roomNo, id);
    logActivity(actor(req).id, 'STUDENT_EDITED', 'student', b.idCardNo, `${before.name}/${before.id_card_no} → ${b.name}/${b.idCardNo}, room ${b.roomNo}`);
  })();
  res.json(counterCard(id));
}));

router.post('/ops/students/:id/review', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(200).default('') }), req.body);
  const s = studentProfile(id);
  if (s.status !== 'PENDING') throw new HttpError(409, `${s.name} is already ${s.status.toLowerCase()}.`);
  if (b.decision === 'REJECT' && !b.note) throw new HttpError(400, 'Tell the student why (e.g. “ID no. does not match portal”).');
  const status = b.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
  db.transaction(() => {
    db.prepare('UPDATE students SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE user_id = ?').run(status, b.note || null, actor(req).id, nowIso(), id);
    notify(id, status === 'ACTIVE' ? 'Registration approved 🎉' : 'Registration needs a fix', status === 'ACTIVE' ? 'You can now give laundry at the counter. Your digital slips will appear here.' : `Reason: ${b.note}. Update your details in Profile and resubmit.`);
    logActivity(actor(req).id, status === 'ACTIVE' ? 'STUDENT_APPROVED' : 'STUDENT_REJECTED', 'student', s.id_card_no, b.note);
  })();
  res.json(counterCard(id));
}));

router.post('/ops/students/:id/status', requireRole('ADMIN'), handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), note: z.string().trim().max(200).default('') }), req.body);
  const s = studentProfile(id);
  db.prepare('UPDATE students SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE user_id = ?').run(b.status, b.note || null, actor(req).id, nowIso(), id);
  notify(id, b.status === 'ACTIVE' ? 'Account active' : 'Account suspended', b.status === 'ACTIVE' ? 'You can use the laundry again.' : `Reason: ${b.note || 'contact the laundry office'}.`);
  logActivity(actor(req).id, b.status === 'ACTIVE' ? 'STUDENT_REACTIVATED' : 'STUDENT_SUSPENDED', 'student', s.id_card_no, b.note);
  res.json(counterCard(id));
}));

router.post('/ops/students/:id/reset-password', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const s = studentProfile(id);
  const pass = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(pass, 10), id);
  logActivity(actor(req).id, 'PASSWORD_RESET', 'student', s.id_card_no);
  res.json({ tempPassword: pass });
}));

/* ------------------------------------------------------------------ orders */

router.post('/ops/quote', handle((req, res) => res.json(quote(parse(orderInput, req.body)))));

router.post('/ops/orders', handle((req, res) => {
  const input = parse(orderInput, req.body);
  const requestId = parse(z.string().min(8).max(64).optional(), req.body.requestId);
  const created = createOrder(actor(req).id, input, requestId);
  res.status(created.duplicate ? 200 : 201).json(orderDetail(created.id));
}));

const orderFilters = z.object({
  status: z.string().optional(), q: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  hostel: z.string().optional(), payment: z.string().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional(),
});
router.get('/ops/orders', handle((req, res) => {
  const f = parse(orderFilters, req.query);
  res.json(listOrders(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined))));
}));

router.get('/ops/orders/:id', handle((req, res) => res.json(orderDetail(parse(zId, req.params.id)))));

router.post('/ops/scan', handle((req, res) => {
  const code = parse(z.string().trim().min(1, 'Scan a slip QR or type the order no.'), req.body.code);
  const found = findOrderByCode(code);
  res.json({ ...orderDetail(found.id), via: found.via });
}));

router.post('/ops/orders/status', handle((req, res) => {
  const b = parse(z.object({ ids: z.array(zId).min(1).max(200), status: z.enum(['RECEIVED', 'WASHING', 'READY']) }), req.body);
  res.json({ changed: setStatus(actor(req).id, b.ids, b.status) });
}));

router.post('/ops/orders/:id/pay', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ method: z.enum(['CASH', 'UPI']), ref: z.string().trim().max(60).default('') }), req.body);
  recordPayment(actor(req).id, id, b.method, b.ref);
  res.json(orderDetail(id));
}));

router.post('/ops/orders/:id/waive', requireRole('ADMIN'), handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ reason: zText(3, 200) }), req.body);
  recordPayment(actor(req).id, id, 'WAIVED', b.reason);
  res.json(orderDetail(id));
}));

router.post('/ops/orders/:id/deliver', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({
    returnedCount: z.coerce.number().int().min(0, 'Count cannot be negative').max(300),
    note: z.string().trim().max(200).default(''),
    payMethod: z.enum(['CASH', 'UPI']).optional(),
    payRef: z.string().trim().max(60).default(''),
  }), req.body);
  db.transaction(() => {   // payment + handover succeed or fail together
    if (b.payMethod && getOrderRow(id).payment_status === 'DUE') recordPayment(actor(req).id, id, b.payMethod, b.payRef);
    deliverOrder(actor(req).id, id, b.returnedCount, b.note);
  })();
  res.json(orderDetail(id));
}));

router.post('/ops/orders/:id/cancel', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ reason: zText(3, 200) }), req.body);
  const o = getOrderRow(id);
  if (!isAdmin(req) && o.status !== 'RECEIVED') throw new HttpError(403, 'Staff can only cancel orders that have not started washing. Ask the admin.');
  cancelOrder(actor(req).id, id, b.reason);
  res.json(orderDetail(id));
}));

router.patch('/ops/orders/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ weightKg: z.coerce.number().positive(), clothesCount: z.coerce.number().int().min(1).max(300), reason: zText(3, 200) }), req.body);
  const o = getOrderRow(id);
  if (!isAdmin(req) && o.status !== 'RECEIVED') throw new HttpError(403, 'Staff can only correct orders that have not started washing. Ask the admin.');
  correctOrder(actor(req).id, id, b.weightKg, b.clothesCount, b.reason);
  res.json(orderDetail(id));
}));

/* -------------------------------------------------------------- complaints */

router.get('/ops/complaints', handle((req, res) => {
  const status = parse(z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', '']).optional(), req.query.status);
  res.json({ rows: listComplaints({ status: status || undefined }) });
}));

router.get('/ops/complaints/:id', handle((req, res) => res.json(complaintDetail(parse(zId, req.params.id)))));

router.post('/ops/complaints/:id/update', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(), message: z.string().trim().max(1000).default('') }), req.body);
  const c = complaintDetail(id);
  if (!b.message && (!b.status || b.status === c.status)) throw new HttpError(400, 'Write a reply or change the status.');
  db.transaction(() => {
    const at = nowIso();
    db.prepare('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)').run(id, actor(req).id, b.status && b.status !== c.status ? b.status : null, b.message || null, at);
    db.prepare('UPDATE complaints SET status = COALESCE(?, status), updated_at = ? WHERE id = ?').run(b.status ?? null, at, id);
    notify(c.student_id, b.status === 'RESOLVED' ? 'Complaint resolved' : 'Reply on your complaint', b.message || `Status: ${(b.status ?? c.status).replace('_', ' ').toLowerCase()}`);
    logActivity(actor(req).id, 'COMPLAINT_UPDATED', 'complaint', id, `${b.status ?? ''} ${b.message}`.trim());
  })();
  res.json(complaintDetail(id));
}));
