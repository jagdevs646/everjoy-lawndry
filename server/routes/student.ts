import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { db, insertId, logActivity } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { photoUpload, savePhoto } from '../files.js';
import { checkStudentEmail, startChallenge } from '../otp.js';
import { slipKey } from '../auth.js';
import { deliverOrder, getSettings, listServices, monthUsage, planStatus, recordPayment } from '../rules.js';
import { disputeComplaint, dropoffVersion, handoverVersion, orderForSign, recordSignoff, statementFor, type Origin } from '../signoff.js';
import { announcementsFor, complaintDetail, listComplaints, orderDetail, studentProfile } from '../queries.js';
import { HttpError, handle, nowIso, parse, zId, zText } from '../util.js';
import { zIdCard, zMobile, zRoom } from './public.js';

export const router = Router();
router.use('/me', requireRole('STUDENT'));

const me = (req: unknown) => (req as AuthedRequest).user;

export const COMPLAINT_CATEGORIES = ['Missing clothes', 'Damaged clothes', 'Wrong count', 'Not washed properly', 'Delay', 'Behaviour', 'Other'] as const;

/** Student-facing order fields: own orders only, includes the QR token for the digital slip. */
const MY_ORDER_COLS = `id, order_no, weight_kg, clothes_count, service, note, status, within_kg, extra_kg, amount, payment_status, paid_method, paid_at,
  qr_token, received_at, expected_at, ready_at, delivered_at, returned_count, cancel_reason, hostel_name, room_no, service_name, unit, rate, charge_note, tag_no,
  dropoff_ack, dropoff_ack_at, pickup_ack, pickup_ack_at`;

/** Never send the order's QR token to the phone: send the derived key that signs the rotating QR instead. */
const withSlipKey = <T extends Record<string, unknown>>(o: T) => {
  const { qr_token: token, ...rest } = o as T & { qr_token?: string | null };
  return { ...rest, qr_key: token && ['RECEIVED', 'WASHING', 'READY'].includes(String(o.status)) ? slipKey(token) : null };
};

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
  const services = await listServices();
  res.json({
    profile,
    plan: planStatus({ kind: String(profile.kind), valid_until: (profile.valid_until as string | null) ?? null, valid_from: (profile.valid_from as string | null) ?? null }),
    services,
    usage,
    open: (open as Record<string, unknown>[]).map(withSlipKey),
    server_time: Date.now(),   // phones with a wrong clock still make a valid slip QR
    due,
    unread,
    open_complaints: openComplaints,
    announcements,
    pending: await pendingFor(user.id),
    info: {
      max_kg_per_order: s.max_kg_per_order, counter_hours: s.counter_hours, upi_id: s.upi_id, upi_name: s.upi_name,
      pay_before_pickup: s.pay_before_pickup, express_enabled: s.express_enabled, express_fee: s.express_fee,
      monthly_kg_limit: s.monthly_kg_limit, monthly_order_limit: s.monthly_order_limit, allow_paid_extra: s.allow_paid_extra, extra_rate_per_kg: s.extra_rate_per_kg,
      has_upi_qr: !!s.upi_qr_file,
      dropoff_from: s.dropoff_from, dropoff_to: s.dropoff_to, pickup_from: s.pickup_from, pickup_to: s.pickup_to,
    },
  });
}));

/**
 * What the student still has to confirm: drop-offs they have not confirmed yet, and a hand-over the
 * counter is waiting on. Polled quickly by the app while an order is ready for pickup.
 */
async function pendingFor(studentId: number) {
  const s = await getSettings();
  // Not confirmed yet, or disputed (once it is sorted out, the student can still confirm).
  const rows = s.sign_dropoff ? await db.all<{ id: number }>(`SELECT id FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY')
    AND (dropoff_ack IS NULL OR dropoff_ack = 'DISPUTED') ORDER BY id`, [studentId]) : [];
  const at = nowIso();
  const dropoff = [];
  for (const r of rows.slice(0, 5)) {
    const o = await orderForSign(r.id);
    dropoff.push({ id: o.id, order_no: o.order_no, tag_no: o.tag_no, clothes_count: o.clothes_count, weight_kg: o.weight_kg, service_name: o.service_name,
      statement: statementFor('DROPOFF', o, at), version: dropoffVersion(o), disputed: o.dropoff_ack === 'DISPUTED' });
  }
  const h = await db.get<{ order_id: number; returned_count: number; note: string | null; pay_method: string | null; status: string; reason: string | null; created_at: string; expires_at: string; staff_name: string }>(
    `SELECT h.order_id, h.returned_count, h.note, h.pay_method, h.status, h.reason, h.created_at, h.expires_at, u.name AS staff_name FROM handover_requests h
     JOIN orders o ON o.id = h.order_id JOIN users u ON u.id = h.staff_id WHERE o.student_id = ? AND h.status = 'WAITING' AND h.expires_at > ? ORDER BY h.created_at DESC LIMIT 1`, [studentId, at]);
  let handover = null;
  if (h) {
    const o = await orderForSign(h.order_id);
    const amount = (await db.get<{ amount: number; payment_status: string }>('SELECT amount, payment_status FROM orders WHERE id = ?', [h.order_id]))!;
    handover = { ...h, order_no: o.order_no, tag_no: o.tag_no, clothes_count: o.clothes_count, amount: amount.payment_status === 'DUE' ? amount.amount : 0,
      statement: statementFor('PICKUP', o, at, h.returned_count, h.note ?? ''), version: handoverVersion(o, h),
      seconds_left: Math.max(0, Math.round((Date.parse(h.expires_at) - Date.now()) / 1000)) };
  }
  return { dropoff, handover };
}

router.get('/me/pending', handle(async (req, res) => res.json(await pendingFor(me(req).id))));

const zAnswer = z.object({ confirm: z.boolean(), reason: z.string().trim().max(300).default(''), version: z.string().max(40).default('') })
  .refine(b => b.confirm || b.reason.length >= 3, { message: 'Say what is wrong (a few words).', path: ['reason'] });
const origin = (req: Request): Origin => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** "Yes, I gave this laundry" (or "Something is wrong") for a drop-off. */
router.post('/me/orders/:id/dropoff', handle(async (req, res) => {
  const user = me(req);
  const id = parse(zId, req.params.id);
  const b = parse(zAnswer, req.body);
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await orderForSign(id);
    if (o.student_id !== user.id) throw new HttpError(404, 'Order not found.');
    if (!['RECEIVED', 'WASHING', 'READY'].includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()}.`);
    if (o.dropoff_ack === 'SIGNATURE' || o.dropoff_ack === 'PHONE') throw new HttpError(409, `You already confirmed ${o.order_no}.`);
    if (b.version !== dropoffVersion(o)) throw new HttpError(409, `The counter changed ${o.order_no}. Check the new details and answer again.`, { code: 'CHANGED' });
    const at = nowIso();
    const statement = statementFor('DROPOFF', o, at);
    if (b.confirm) await recordSignoff({ o, kind: 'DROPOFF', proof: { method: 'PHONE' }, staffId: null, at, statement, origin: origin(req) });
    else {
      if (o.dropoff_ack === 'DISPUTED') throw new HttpError(409, 'You already told the counter something is wrong with this order. They will contact you.');
      await recordSignoff({ o, kind: 'DROPOFF', proof: { method: 'PHONE', dispute: b.reason }, staffId: null, at, statement, origin: origin(req) });
      await disputeComplaint(o, 'DROPOFF', b.reason, at);
    }
  });
  res.json({ ok: true, pending: await pendingFor(user.id) });
}));

/** "Yes, I received my clothes" for the hand-over the counter is waiting on (or "Something is wrong"). */
router.post('/me/orders/:id/handover', handle(async (req, res) => {
  const user = me(req);
  const id = parse(zId, req.params.id);
  const b = parse(zAnswer, req.body);
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await orderForSign(id);
    if (o.student_id !== user.id) throw new HttpError(404, 'Order not found.');
    const h = await db.get<{ staff_id: number; returned_count: number; note: string | null; pay_method: 'CASH' | 'UPI' | null; pay_ref: string | null; status: string; expires_at: string }>(
      'SELECT * FROM handover_requests WHERE order_id = ?', [id]) as { staff_id: number; returned_count: number; note: string | null; pay_method: 'CASH' | 'UPI' | null; pay_ref: string | null; status: string; created_at: string; expires_at: string } | undefined;
    if (!h || h.status !== 'WAITING') throw new HttpError(409, 'The counter is not waiting for you to confirm this order.');
    if (h.expires_at <= nowIso()) throw new HttpError(409, 'The request from the counter expired. Ask staff to send it again.');
    if (b.version !== handoverVersion(o, h as typeof h & { created_at: string })) throw new HttpError(409, 'The counter changed what you are confirming. Check the new details and answer again.', { code: 'CHANGED' });
    if (b.confirm) {
      // Payment (if staff collected it) and the hand-over happen together, as if staff pressed "Hand over".
      if (h.pay_method && (await db.get<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = ?', [id]))!.payment_status === 'DUE') {
        await recordPayment(h.staff_id, id, h.pay_method, h.pay_ref ?? '');
      }
      await deliverOrder(h.staff_id, id, h.returned_count, h.note ?? '', { method: 'PHONE' }, origin(req));
    } else {
      const at = nowIso();
      await db.run(`UPDATE handover_requests SET status = 'DISPUTED', reason = ? WHERE order_id = ?`, [b.reason, id]);
      await recordSignoff({ o, kind: 'PICKUP', proof: { method: 'PHONE', dispute: b.reason }, staffId: h.staff_id, at,
        statement: statementFor('PICKUP', o, at, h.returned_count, h.note ?? ''), origin: origin(req), returned: h.returned_count });
      await disputeComplaint(o, 'PICKUP', b.reason, at);
    }
  });
  res.json({ ok: true, pending: await pendingFor(user.id) });
}));

router.get('/me/orders', handle(async (req, res) => {
  const user = me(req);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const rows = await db.all(`SELECT ${MY_ORDER_COLS} FROM orders WHERE student_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [user.id, q.limit, q.offset]);
  const total = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE student_id = ?', [user.id]))!.c;
  res.json({ rows: (rows as Record<string, unknown>[]).map(withSlipKey), total });
}));

router.get('/me/orders/:id', handle(async (req, res) => {
  const user = me(req);
  const id = parse(zId, req.params.id);
  const d = await orderDetail(id, { includeQr: true });
  if (d.student_id !== user.id) throw new HttpError(404, 'Order not found.');   // 404, not 403: don't confirm other students' orders exist
  res.json({ ...withSlipKey(d), server_time: Date.now() });
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
    const roomChanged = b.hostelId !== Number(current.hostel_id) || b.roomNo !== current.room_no;
    if (canEditIdentity) {
      // Not approved yet: the whole registration is checked by staff anyway, so change it directly.
      await db.run(`UPDATE students SET hostel_id = ?, room_no = ?, status = CASE WHEN status = 'REJECTED' THEN 'PENDING' ELSE status END WHERE user_id = ?`, [b.hostelId, b.roomNo, user.id]);
    } else if (roomChanged) {
      // Approved students: a new hostel/room waits for staff to check it before it replaces the old one.
      await db.run('UPDATE students SET pending_hostel_id = ?, pending_room_no = ?, change_requested_at = ? WHERE user_id = ?', [b.hostelId, b.roomNo, nowIso(), user.id]);
    } else if (current.pending_hostel_id) {
      // Back to the room already on file: withdraw the waiting change.
      await db.run('UPDATE students SET pending_hostel_id = NULL, pending_room_no = NULL, change_requested_at = NULL WHERE user_id = ?', [user.id]);
    }
    await logActivity(user.id, current.status === 'REJECTED' ? 'STUDENT_RESUBMITTED' : !canEditIdentity && roomChanged ? 'ROOM_CHANGE_REQUESTED' : 'PROFILE_UPDATED', 'student', current.id_card_no, `room ${b.roomNo}, ${b.mobile}`);
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

/** Only approved students can raise complaints (and upload photos); checked before the upload is read. */
const activeOnly = (req: Request, _res: Response, next: NextFunction) =>
  (req as AuthedRequest).user?.student_status === 'ACTIVE' ? next() : next(new HttpError(403, 'Your account must be approved first.'));

router.post('/me/complaints', activeOnly, photoUpload.single('photo'), handle(async (req, res) => {
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

/* ------------------------------------------------------------------ photo */

/**
 * The student's own photo. They can add it until staff approve the account (staff compare it with the
 * face at the counter); after that only staff can change it, so an approved account can't swap faces.
 */
router.post('/me/photo', photoUpload.single('photo'), handle(async (req, res) => {
  const user = me(req);
  if (!req.file) throw new HttpError(400, 'Choose a photo.');
  const p = await studentProfile(user.id);
  if (p.status === 'ACTIVE' && p.photo) throw new HttpError(403, 'Your photo is locked after approval. Ask at the counter to change it.');
  if (p.status === 'SUSPENDED') throw new HttpError(403, 'Your account is on hold.');
  const name = await savePhoto(req.file);
  await db.run('UPDATE users SET photo = ? WHERE id = ?', [name, user.id]);
  if (p.photo) await db.run('DELETE FROM files WHERE name = ?', [p.photo]);
  await logActivity(user.id, 'PHOTO_ADDED', 'student', p.id_card_no);
  res.json(await studentProfile(user.id));
}));

/**
 * A student without an email on file adds one. It is saved only after they type the code sent to it,
 * so a typo can't lock them out and nobody can point the codes at someone else's inbox.
 */
router.put('/me/email', handle(async (req, res) => {
  const user = me(req);
  const b = parse(z.object({ email: z.string().trim().toLowerCase().max(120).email('Enter your university email address') }), req.body);
  const p = await studentProfile(user.id);
  if (p.email) throw new HttpError(403, 'To change your email, ask at the counter.');
  await checkStudentEmail(b.email);
  if (await db.get('SELECT 1 AS ok FROM students WHERE lower(email) = ? AND user_id != ?', [b.email, user.id])) throw new HttpError(409, 'This email is already used by another account.');
  const tv = (await db.get<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', [user.id]))!.token_version;
  res.status(202).json(await startChallenge('EMAIL', b.email, user.id, { email: b.email, v: tv }));
}));
