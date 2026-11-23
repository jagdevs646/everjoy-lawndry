import { Router } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { photoUpload } from '../files.js';
import { getSettings, monthUsage } from '../rules.js';
import { announcementsFor, complaintDetail, listComplaints, orderDetail, studentProfile } from '../queries.js';
import { HttpError, handle, nowIso, parse, zId, zText } from '../util.js';
import { zIdCard, zMobile, zRoom } from './public.js';

export const router = Router();
router.use('/me', requireRole('STUDENT'));

const me = (req: unknown) => (req as AuthedRequest).user;

export const COMPLAINT_CATEGORIES = ['Missing clothes', 'Damaged clothes', 'Wrong count', 'Not washed properly', 'Delay', 'Behaviour', 'Other'] as const;

/** Student-facing order fields: own orders only, includes the QR token for the digital slip. */
const MY_ORDER_COLS = `id, order_no, weight_kg, clothes_count, service, note, status, within_kg, extra_kg, amount, payment_status, paid_method, paid_at,
  qr_token, received_at, expected_at, ready_at, delivered_at, returned_count, cancel_reason, hostel_name, room_no`;

router.get('/me/home', handle((req, res) => {
  const user = me(req);
  const profile = studentProfile(user.id);
  const s = getSettings();
  const open = db.prepare(`SELECT ${MY_ORDER_COLS} FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY') ORDER BY id DESC`).all(user.id);
  const due = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM orders WHERE student_id = ? AND payment_status = 'DUE' AND status != 'CANCELLED'`).get(user.id) as { amount: number }).amount;
  const unread = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id) as { c: number }).c;
  const openComplaints = (db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE student_id = ? AND status != 'RESOLVED'`).get(user.id) as { c: number }).c;
  res.json({
    profile,
    usage: monthUsage(user.id),
    open,
    due,
    unread,
    open_complaints: openComplaints,
    announcements: announcementsFor(profile.hostel_id).slice(0, 3),
    info: {
      max_kg_per_order: s.max_kg_per_order, counter_hours: s.counter_hours, upi_id: s.upi_id, upi_name: s.upi_name,
      pay_before_pickup: s.pay_before_pickup, express_enabled: s.express_enabled, express_fee: s.express_fee,
      monthly_kg_limit: s.monthly_kg_limit, monthly_order_limit: s.monthly_order_limit, over_limit_action: s.over_limit_action, extra_rate_per_kg: s.extra_rate_per_kg,
    },
  });
}));

router.get('/me/orders', handle((req, res) => {
  const user = me(req);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const rows = db.prepare(`SELECT ${MY_ORDER_COLS} FROM orders WHERE student_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(user.id, q.limit, q.offset);
  const total = (db.prepare('SELECT COUNT(*) AS c FROM orders WHERE student_id = ?').get(user.id) as { c: number }).c;
  res.json({ rows, total });
}));

router.get('/me/orders/:id', handle((req, res) => {
  const user = me(req);
  const id = parse(zId, req.params.id);
  const d = orderDetail(id, { includeQr: true });
  if (d.student_id !== user.id) throw new HttpError(404, 'Order not found.');   // 404, not 403: don't confirm other students' orders exist
  res.json(d);
}));

router.patch('/me/profile', handle((req, res) => {
  const user = me(req);
  const current = studentProfile(user.id);
  const canEditIdentity = current.status === 'PENDING' || current.status === 'REJECTED';
  const b = parse(z.object({
    mobile: zMobile,
    hostelId: z.coerce.number().int().positive('Choose your hostel'),
    roomNo: zRoom,
    name: zText(2, 80).optional(),
    idCardNo: zIdCard.optional(),
  }), req.body);
  if (!db.prepare('SELECT 1 FROM hostels WHERE id = ? AND active = 1').get(b.hostelId)) throw new HttpError(400, 'Choose your hostel.');
  db.transaction(() => {
    if (canEditIdentity && b.idCardNo && b.idCardNo !== current.id_card_no) {
      if (db.prepare('SELECT 1 FROM users WHERE login_id = ? AND id != ?').get(b.idCardNo, user.id)) throw new HttpError(409, 'That ID card no. is already registered.');
      db.prepare('UPDATE users SET login_id = ? WHERE id = ?').run(b.idCardNo, user.id);
      db.prepare('UPDATE students SET id_card_no = ? WHERE user_id = ?').run(b.idCardNo, user.id);
    }
    db.prepare('UPDATE users SET mobile = ?, name = COALESCE(?, name) WHERE id = ?').run(b.mobile, canEditIdentity ? b.name ?? null : null, user.id);
    db.prepare(`UPDATE students SET hostel_id = ?, room_no = ?, status = CASE WHEN status = 'REJECTED' THEN 'PENDING' ELSE status END WHERE user_id = ?`).run(b.hostelId, b.roomNo, user.id);
    logActivity(user.id, current.status === 'REJECTED' ? 'STUDENT_RESUBMITTED' : 'PROFILE_UPDATED', 'student', current.id_card_no, `room ${b.roomNo} · ${b.mobile}`);
  })();
  res.json(studentProfile(user.id));
}));

router.get('/me/complaints', handle((req, res) => {
  const user = me(req);
  const rows = listComplaints({ studentId: user.id }).map(c => complaintDetail((c as { id: number }).id));
  res.json({ rows, categories: COMPLAINT_CATEGORIES });
}));

router.post('/me/complaints', photoUpload.single('photo'), handle((req, res) => {
  const user = me(req);
  const b = parse(z.object({
    orderId: z.union([z.literal(''), z.coerce.number().int().positive()]).optional(),
    category: z.enum(COMPLAINT_CATEGORIES, { error: 'Choose what went wrong' }),
    description: zText(5, 1000),
  }), req.body);
  const orderId = b.orderId ? Number(b.orderId) : null;
  if (orderId) {
    const o = db.prepare('SELECT student_id FROM orders WHERE id = ?').get(orderId) as { student_id: number } | undefined;
    if (!o || o.student_id !== user.id) throw new HttpError(400, 'Choose one of your own orders.');
  }
  const open = (db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE student_id = ? AND status != 'RESOLVED'`).get(user.id) as { c: number }).c;
  if (open >= 5) throw new HttpError(429, 'You already have 5 open complaints. Wait for them to be resolved first.');
  const at = nowIso();
  const id = Number(db.prepare('INSERT INTO complaints (student_id, order_id, category, description, photo, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(user.id, orderId, b.category, b.description, req.file?.filename ?? null, at, at).lastInsertRowid);
  db.prepare('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)').run(id, user.id, 'OPEN', null, at);
  logActivity(user.id, 'COMPLAINT_RAISED', 'complaint', id, b.category);
  res.status(201).json(complaintDetail(id));
}));
