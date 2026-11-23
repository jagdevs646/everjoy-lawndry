import { Router } from 'express';
import { z } from 'zod';
import { db, insertId, logActivity } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { photoUpload, savePhoto } from '../files.js';
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

router.get('/me/home', handle(async (req, res) => {
  const user = me(req);
  const profile = await studentProfile(user.id);
  const s = await getSettings();
  const open = await db.all(`SELECT ${MY_ORDER_COLS} FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY') ORDER BY id DESC`, [user.id]);
  const due = (await db.get<{ amount: number }>(`SELECT COALESCE(SUM(amount),0) AS amount FROM orders WHERE student_id = ? AND payment_status = 'DUE' AND status != 'CANCELLED'`, [user.id]))!.amount;
  const unread = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]))!.c;
  const openComplaints = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM complaints WHERE student_id = ? AND status != 'RESOLVED'`, [user.id]))!.c;
  const usage = await monthUsage(user.id);
  const announcements = (await announcementsFor(profile.hostel_id)).slice(0, 3);
  res.json({
    profile,
    usage,
    open,
    due,
    unread,
    open_complaints: openComplaints,
    announcements,
    info: {
      max_kg_per_order: s.max_kg_per_order, counter_hours: s.counter_hours, upi_id: s.upi_id, upi_name: s.upi_name,
      pay_before_pickup: s.pay_before_pickup, express_enabled: s.express_enabled, express_fee: s.express_fee,
      monthly_kg_limit: s.monthly_kg_limit, monthly_order_limit: s.monthly_order_limit, over_limit_action: s.over_limit_action, extra_rate_per_kg: s.extra_rate_per_kg,
    },
  });
}));

router.get('/me/orders', handle(async (req, res) => {
  const user = me(req);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const rows = await db.all(`SELECT ${MY_ORDER_COLS} FROM orders WHERE student_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [user.id, q.limit, q.offset]);
  const total = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE student_id = ?', [user.id]))!.c;
  res.json({ rows, total });
}));

router.get('/me/orders/:id', handle(async (req, res) => {
  const user = me(req);
  const id = parse(zId, req.params.id);
  const d = await orderDetail(id, { includeQr: true });
  if (d.student_id !== user.id) throw new HttpError(404, 'Order not found.');   // 404, not 403: don't confirm other students' orders exist
  res.json(d);
}));

router.patch('/me/profile', handle(async (req, res) => {
  const user = me(req);
  await db.tx(async () => {
    // Lock the student's row so the status read below can't change (e.g. an approval) before the update lands.
    await db.lockRow('users', user.id);
    const current = await studentProfile(user.id);
    const canEditIdentity = current.status === 'PENDING' || current.status === 'REJECTED';
    const b = parse(z.object({
      mobile: zMobile,
      hostelId: z.coerce.number().int().positive('Choose your hostel'),
      roomNo: zRoom,
      name: zText(2, 80).optional(),
      idCardNo: zIdCard.optional(),
    }), req.body);
    if (!(await db.get('SELECT 1 FROM hostels WHERE id = ? AND active = 1', [b.hostelId]))) throw new HttpError(400, 'Choose your hostel.');
    if (canEditIdentity && b.idCardNo && b.idCardNo !== current.id_card_no) {
      if (await db.get('SELECT 1 FROM users WHERE login_id = ? AND id != ?', [b.idCardNo, user.id])) throw new HttpError(409, 'That ID card no. is already registered.');
      await db.run('UPDATE users SET login_id = ? WHERE id = ?', [b.idCardNo, user.id]);
      await db.run('UPDATE students SET id_card_no = ? WHERE user_id = ?', [b.idCardNo, user.id]);
    }
    await db.run('UPDATE users SET mobile = ?, name = COALESCE(?, name) WHERE id = ?', [b.mobile, canEditIdentity ? b.name ?? null : null, user.id]);
    await db.run(`UPDATE students SET hostel_id = ?, room_no = ?, status = CASE WHEN status = 'REJECTED' THEN 'PENDING' ELSE status END WHERE user_id = ?`, [b.hostelId, b.roomNo, user.id]);
    await logActivity(user.id, current.status === 'REJECTED' ? 'STUDENT_RESUBMITTED' : 'PROFILE_UPDATED', 'student', current.id_card_no, `room ${b.roomNo} · ${b.mobile}`);
  });
  res.json(await studentProfile(user.id));
}));

router.get('/me/complaints', handle(async (req, res) => {
  const user = me(req);
  const list = await listComplaints({ studentId: user.id });
  const rows: Awaited<ReturnType<typeof complaintDetail>>[] = [];
  for (const c of list) rows.push(await complaintDetail((c as { id: number }).id));
  res.json({ rows, categories: COMPLAINT_CATEGORIES });
}));

router.post('/me/complaints', photoUpload.single('photo'), handle(async (req, res) => {
  const user = me(req);
  const b = parse(z.object({
    orderId: z.union([z.literal(''), z.coerce.number().int().positive()]).optional(),
    category: z.enum(COMPLAINT_CATEGORIES, { error: 'Choose what went wrong' }),
    description: zText(5, 1000),
  }), req.body);
  const orderId = b.orderId ? Number(b.orderId) : null;
  const id = await db.tx(async () => {
    // One complaint at a time per student, so two quick submissions can't both slip past the open limit.
    await db.lockRow('users', user.id);
    if (orderId) {
      const o = await db.get<{ student_id: number }>('SELECT student_id FROM orders WHERE id = ?', [orderId]);
      if (!o || o.student_id !== user.id) throw new HttpError(400, 'Choose one of your own orders.');
    }
    const open = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM complaints WHERE student_id = ? AND status != 'RESOLVED'`, [user.id]))!.c;
    if (open >= 5) throw new HttpError(429, 'You already have 5 open complaints. Wait for them to be resolved first.');
    // Saved only once the complaint is accepted, and inside the transaction so a failed insert leaves no stray photo.
    const photo = req.file ? await savePhoto(req.file) : null;
    const at = nowIso();
    const newId = await insertId('INSERT INTO complaints (student_id, order_id, category, description, photo, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [user.id, orderId, b.category, b.description, photo, at, at]);
    await db.run('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)', [newId, user.id, 'OPEN', null, at]);
    await logActivity(user.id, 'COMPLAINT_RAISED', 'complaint', newId, b.category);
    return newId;
  });
  res.status(201).json(await complaintDetail(id));
}));
