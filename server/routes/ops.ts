import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, insertId, logActivity, notify } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { addEvent, cancelOrder, cardInUse, checkCard, correctOrder, createOrder, deliverOrder, getOrderRow, getSettings, listServices, monthUsage, orderInput, planStatus, quote, recordPayment, setStatus } from '../rules.js';
import { photoUpload, savePhoto } from '../files.js';
import { checkStudentEmail } from '../otp.js';
import { announcementsFor, complaintDetail, findOrderByCode, listComplaints, listOrders, listStudents, orderDetail, studentProfile } from '../queries.js';
import { dayKey, handle, HttpError, MAX_ID, nowIso, parse, startOfLocalDayIso, zDate, zId, zText } from '../util.js';
import { normaliseLogin, zIdCard, zMobile, zRoom } from './public.js';

export const router = Router();
router.use('/ops', requireRole('STAFF', 'ADMIN'));

const actor = (req: unknown) => (req as AuthedRequest).user;
const isAdmin = (req: unknown) => actor(req).role === 'ADMIN';

/** Readable temporary password, e.g. "wash-4821". Shown once to staff, who tells the student. */
/** Easy to read out at the counter, hard to guess: e.g. "fold-K7QM-4821" (about 40 bits). No 0/O or 1/I/L. */
export function tempPassword() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  return `${['wash', 'fold', 'iron', 'fresh', 'clean', 'soap'][crypto.randomInt(6)]}-${code}-${crypto.randomInt(1000, 10000)}`;
}
/** A temporary password works for 7 days; after that the counter gives a new one. */
export const tempPasswordExpiry = () => new Date(Date.now() + 7 * 86400_000).toISOString();

router.get('/ops/summary', handle(async (_req, res) => {
  const today = dayKey();
  const one = async (sql: string, ...p: unknown[]) => (await db.get<{ c: number }>(sql, p))!.c;
  // Independent reads: run them side by side.
  const [
    received, kg, clothes, delivered, collected,
    openReceived, washing, ready, late,
    pendingStudents, openComplaints, dues, settings, announcements, roomChanges, services,
  ] = await Promise.all([
    one(`SELECT COUNT(*) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
    one(`SELECT COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1), 0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
    one(`SELECT COALESCE(SUM(clothes_count),0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
    one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'DELIVERED' AND delivered_at >= ?`, startOfLocalDayIso()),
    one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE payment_status = 'PAID' AND paid_at >= ?`, startOfLocalDayIso()),
    one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'RECEIVED'`),
    one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'WASHING'`),
    one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY'`),
    one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING') AND expected_at < ?`, nowIso()),
    one(`SELECT COUNT(*) AS c FROM students WHERE status = 'PENDING'`),
    one(`SELECT COUNT(*) AS c FROM complaints WHERE status != 'RESOLVED'`),
    one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE payment_status = 'DUE' AND status != 'CANCELLED'`),
    pickSettings(),
    announcementsFor(null),
    one(`SELECT COUNT(*) AS c FROM students WHERE pending_hostel_id IS NOT NULL`),
    listServices(),
  ]);
  res.json({
    today: { received, kg, clothes, delivered, collected },
    open: { received: openReceived, washing, ready, late },
    pending_students: pendingStudents,
    room_changes: roomChanges,
    services,
    open_complaints: openComplaints,
    dues,
    settings,
    announcements: announcements.slice(0, 2),
  });
}));

async function pickSettings() {
  const s = await getSettings();
  return {
    max_kg_per_order: s.max_kg_per_order, express_enabled: s.express_enabled, express_fee: s.express_fee, pay_before_pickup: s.pay_before_pickup,
    monthly_kg_limit: s.monthly_kg_limit, monthly_order_limit: s.monthly_order_limit, max_active_orders: s.max_active_orders,
    allow_paid_extra: s.allow_paid_extra, extra_rate_per_kg: s.extra_rate_per_kg,
    upi_id: s.upi_id, upi_name: s.upi_name, has_upi_qr: !!s.upi_qr_file,
    card_required: s.card_required, card_series: s.card_series, semester_start: s.semester_start, semester_end: s.semester_end,
  };
}

/* ---------------------------------------------------------------- students */

router.get('/ops/students', handle(async (req, res) => {
  const q = parse(z.object({ q: z.string().optional(), status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional().or(z.literal('')), hostelId: z.coerce.number().int().positive().max(MAX_ID).optional(), plan: z.enum(['EXPIRED', 'VALID', 'UPCOMING', 'WALKIN', '']).optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().min(0).optional() }), req.query);
  res.json(await listStudents({ ...q, status: q.status || undefined }));
}));

/** Counter lookup: exact ID card match (typed, USB scanner, or the student's own ID QR) plus fuzzy suggestions. */
router.get('/ops/students/lookup', handle(async (req, res) => {
  const raw = String(req.query.code || '').trim();
  if (!raw) throw new HttpError(400, 'Enter or scan an ID card no.');
  const code = normaliseLogin(raw.replace(/^EJS:/i, ''));
  const hit = await db.get<{ user_id: number }>('SELECT user_id FROM students WHERE id_card_no = ?', [code]);
  if (hit) return res.json({ student: await counterCard(hit.user_id), suggestions: [] });
  res.json({ student: null, suggestions: raw.length >= 2 ? (await listStudents({ q: raw, limit: 8 })).rows : [] });
}));

async function counterCard(id: number) {
  const open = await db.all(`SELECT id, order_no, status, clothes_count, weight_kg, amount, payment_status, received_at, expected_at, service_name, tag_no FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY') ORDER BY id`, [id]);
  const profile = await studentProfile(id);
  const usage = await monthUsage(id);
  return { ...profile, plan: planStatus({ kind: String(profile.kind), valid_until: (profile.valid_until as string | null) ?? null, valid_from: (profile.valid_from as string | null) ?? null }), usage, open };
}

router.get('/ops/students/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const card = await counterCard(id);
  const orders = (await listOrders({ studentId: id, limit: 50 })).rows;
  res.json({ ...card, orders });
}));

router.patch('/ops/students/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const before = await studentProfile(id);
  const b = parse(z.object({
    name: zText(2, 80), idCardNo: zIdCard, mobile: zMobile, hostelId: z.coerce.number().int().positive().max(MAX_ID), roomNo: zRoom,
    validFrom: z.union([z.literal(''), z.null(), zDate]).optional(),
    validUntil: z.union([z.literal(''), z.null(), zDate]).optional(),
    email: z.union([z.literal(''), z.string().trim().toLowerCase().max(120).email('Enter a valid email')]).optional(),
  }), req.body);
  if (b.validFrom && b.validUntil && b.validFrom > b.validUntil) throw new HttpError(400, 'The plan start must be before its end.');
  const emailChanged = b.email !== undefined && (b.email || null) !== (((before.email as string | null) ?? null)?.toLowerCase() ?? null);
  if (emailChanged && b.email) {
    await checkStudentEmail(b.email);
    if (await db.get('SELECT 1 AS ok FROM students WHERE lower(email) = ? AND user_id != ?', [b.email, id])) throw new HttpError(409, 'This email is already used by another account.');
  }
  if (!(await db.get('SELECT 1 FROM hostels WHERE id = ?', [b.hostelId]))) throw new HttpError(400, 'Choose a hostel.');
  if (b.idCardNo !== before.id_card_no && (await db.get('SELECT 1 FROM users WHERE login_id = ? AND id != ?', [b.idCardNo, id]))) throw new HttpError(409, 'Another account already uses that ID card no.');
  await db.tx(async () => {
    await db.run('UPDATE users SET name = ?, mobile = ?, login_id = ? WHERE id = ?', [b.name, b.mobile, b.idCardNo, id]);
    await db.run('UPDATE students SET id_card_no = ?, hostel_id = ?, room_no = ? WHERE user_id = ?', [b.idCardNo, b.hostelId, b.roomNo, id]);
    if (b.validUntil !== undefined) await db.run('UPDATE students SET valid_until = ? WHERE user_id = ?', [b.validUntil || null, id]);
    if (b.validFrom !== undefined) await db.run('UPDATE students SET valid_from = ? WHERE user_id = ?', [b.validFrom || null, id]);
    // A new email must be confirmed again with a code; the old trusted devices are signed out.
    if (emailChanged) {
      await db.run('UPDATE students SET email = ?, email_verified_at = NULL WHERE user_id = ?', [b.email || null, id]);
      await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
    }
    // Staff set the hostel/room themselves: a change the student asked for earlier no longer applies.
    if (b.hostelId !== Number(before.hostel_id) || b.roomNo !== before.room_no) {
      await db.run('UPDATE students SET pending_hostel_id = NULL, pending_room_no = NULL, change_requested_at = NULL WHERE user_id = ?', [id]);
    }
    await logActivity(actor(req).id, 'STUDENT_EDITED', 'student', b.idCardNo, `${before.name}/${before.id_card_no} → ${b.name}/${b.idCardNo}, room ${b.roomNo}${b.validUntil !== undefined ? `, plan till ${b.validUntil || 'no end'}` : ''}`);
  });
  res.json(await counterCard(id));
}));

router.post('/ops/students/:id/review', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(200).default('') }), req.body);
  await db.tx(async () => {
    await db.lockRow('users', id);   // two counters can't review the same registration at once
    const s = await studentProfile(id);
    if (s.status !== 'PENDING') throw new HttpError(409, `${s.name} is already ${s.status.toLowerCase()}.`);
    if (b.decision === 'REJECT' && !b.note) throw new HttpError(400, 'Tell the student why (e.g. “ID no. does not match portal”).');
    const status = b.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
    await db.run('UPDATE students SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE user_id = ?', [status, b.note || null, actor(req).id, nowIso(), id]);
    // Approved hostelers get the current semester's plan end date, if the admin has set one.
    const { semester_start: semesterStart, semester_end: semesterEnd } = await getSettings();
    if (status === 'ACTIVE' && semesterEnd && !s.valid_until) await db.run('UPDATE students SET valid_from = ?, valid_until = ? WHERE user_id = ?', [semesterStart || null, semesterEnd, id]);
    await notify(id, status === 'ACTIVE' ? 'Registration approved 🎉' : 'Registration needs a fix', status === 'ACTIVE' ? 'You can now give laundry at the counter. Your digital slips will appear here.' : `Reason: ${b.note}. Update your details in Profile and resubmit.`);
    await logActivity(actor(req).id, status === 'ACTIVE' ? 'STUDENT_APPROVED' : 'STUDENT_REJECTED', 'student', s.id_card_no, b.note);
  });
  res.json(await counterCard(id));
}));

router.post('/ops/students/:id/status', requireRole('ADMIN'), handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), note: z.string().trim().max(200).default('') }), req.body);
  await db.tx(async () => {
    await db.lockRow('users', id);
    const s = await studentProfile(id);
    await db.run('UPDATE students SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE user_id = ?', [b.status, b.note || null, actor(req).id, nowIso(), id]);
    await notify(id, b.status === 'ACTIVE' ? 'Account active' : 'Account suspended', b.status === 'ACTIVE' ? 'You can use the laundry again.' : `Reason: ${b.note || 'contact the laundry office'}.`);
    await logActivity(actor(req).id, b.status === 'ACTIVE' ? 'STUDENT_REACTIVATED' : 'STUDENT_SUSPENDED', 'student', s.id_card_no, b.note);
  });
  res.json(await counterCard(id));
}));

router.post('/ops/students/:id/reset-password', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const s = await studentProfile(id);
  const pass = tempPassword();
  const hash = await bcrypt.hash(pass, 10);
  await db.tx(async () => {
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 1, password_expires_at = ?, token_version = token_version + 1 WHERE id = ?', [hash, tempPasswordExpiry(), id]);
    // Staff checked the student in person: an imported account no longer waits to be claimed.
    await db.run('UPDATE students SET claimable = 0, claim_hash = NULL, claim_expires_at = NULL WHERE user_id = ?', [id]);
    await logActivity(actor(req).id, 'PASSWORD_RESET', 'student', s.id_card_no);
  });
  res.json({ tempPassword: pass });
}));

/* ------------------------------------------------------------ room changes */

/** Students' hostel/room changes wait here until staff check them. */
router.get('/ops/room-changes', handle(async (_req, res) => {
  res.json({ rows: await db.all(`SELECT u.id, u.name, u.mobile, st.id_card_no, st.room_no, h.name AS hostel_name,
      st.pending_room_no, ph.name AS pending_hostel_name, st.change_requested_at
    FROM students st JOIN users u ON u.id = st.user_id JOIN hostels h ON h.id = st.hostel_id
    JOIN hostels ph ON ph.id = st.pending_hostel_id
    WHERE st.pending_hostel_id IS NOT NULL ORDER BY st.change_requested_at`) });
}));

router.post('/ops/students/:id/room-change', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(200).default('') }), req.body);
  await db.tx(async () => {
    await db.lockRow('users', id);
    const s = await db.get<{ id_card_no: string; pending_hostel_id: number | null; pending_room_no: string | null }>(
      'SELECT id_card_no, pending_hostel_id, pending_room_no FROM students WHERE user_id = ?', [id]);
    if (!s) throw new HttpError(404, 'Student not found.');
    if (!s.pending_hostel_id) throw new HttpError(409, 'There is no room change waiting for this student.');
    if (b.decision === 'REJECT' && !b.note) throw new HttpError(400, 'Tell the student why (e.g. "Room not on the hostel list").');
    const newHostel = await db.get<{ name: string }>('SELECT name FROM hostels WHERE id = ?', [s.pending_hostel_id]);
    if (b.decision === 'APPROVE') {
      await db.run('UPDATE students SET hostel_id = ?, room_no = ?, pending_hostel_id = NULL, pending_room_no = NULL, change_requested_at = NULL WHERE user_id = ?', [s.pending_hostel_id, s.pending_room_no, id]);
      await notify(id, 'Room change approved', `Your laundry account now shows ${newHostel?.name}, room ${s.pending_room_no}.`);
    } else {
      await db.run('UPDATE students SET pending_hostel_id = NULL, pending_room_no = NULL, change_requested_at = NULL WHERE user_id = ?', [id]);
      await notify(id, 'Room change not approved', `Reason: ${b.note}. Your hostel and room stay as before.`);
    }
    await logActivity(actor(req).id, b.decision === 'APPROVE' ? 'ROOM_CHANGE_APPROVED' : 'ROOM_CHANGE_REJECTED', 'student', s.id_card_no,
      `${newHostel?.name}, room ${s.pending_room_no}${b.note ? `, ${b.note}` : ''}`);
  });
  res.json(await counterCard(id));
}));

/* ---------------------------------------------------------------- walk-ins */

/**
 * Quick counter registration for someone who isn't a registered student (not shown to students).
 * Walk-ins pay normal prices. The same mobile number finds the same customer again.
 */
router.post('/ops/walk-in', handle(async (req, res) => {
  const b = parse(z.object({ name: zText(2, 80), mobile: zMobile }), req.body);
  const loginId = `WALKIN-${b.mobile}`;
  const existing = await db.get<{ id: number; kind: string | null }>('SELECT u.id, st.kind FROM users u LEFT JOIN students st ON st.user_id = u.id WHERE u.login_id = ?', [loginId]);
  if (existing && existing.kind === 'WALKIN') return res.json(await counterCard(existing.id));
  if (existing) throw new HttpError(409, 'This mobile number is tied to another account. Search for it in Students.');
  const id = await db.tx(async () => {
    const hostel = await db.get<{ id: number }>("SELECT id FROM hostels WHERE lower(name) = 'walk-in customers'");
    const hostelId = hostel?.id ?? await insertId('INSERT INTO hostels (name, active) VALUES (?, 0)', ['Walk-in customers']);
    // No usable password: walk-ins are served at the counter and never sign in.
    const unusable = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const userId = await insertId(`INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES ('STUDENT',?,?,?,?,?)`, [loginId, b.name, b.mobile, unusable, nowIso()]);
    await db.run(`INSERT INTO students (user_id, id_card_no, hostel_id, room_no, status, kind, reviewed_by, reviewed_at) VALUES (?,?,?,?,'ACTIVE','WALKIN',?,?)`,
      [userId, loginId, hostelId, '-', actor(req).id, nowIso()]);
    await logActivity(actor(req).id, 'WALKIN_ADDED', 'student', loginId, b.name);
    return userId;
  });
  res.status(201).json(await counterCard(id));
}));

/* ------------------------------------------------------------------ orders */

router.post('/ops/quote', handle(async (req, res) => res.json(await quote(parse(orderInput, req.body)))));

router.post('/ops/orders', handle(async (req, res) => {
  const input = parse(orderInput, req.body);
  const requestId = parse(z.string().min(8).max(64).optional(), req.body.requestId);
  const created = await createOrder(actor(req).id, input, requestId);
  res.status(created.duplicate ? 200 : 201).json(await orderDetail(created.id));
}));

const orderFilters = z.object({
  status: z.string().optional(), q: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  hostel: z.string().optional(), payment: z.string().optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().min(0).optional(),
});
router.get('/ops/orders', handle(async (req, res) => {
  const f = parse(orderFilters, req.query);
  res.json(await listOrders(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined))));
}));

router.get('/ops/orders/:id', handle(async (req, res) => res.json(await orderDetail(parse(zId, req.params.id)))));

router.post('/ops/scan', handle(async (req, res) => {
  const code = parse(z.string().trim().min(1, 'Scan a slip QR or type the order no.'), req.body.code);
  const found = await findOrderByCode(code);
  res.json({ ...(await orderDetail(found.id)), via: found.via });
}));

router.post('/ops/orders/status', handle(async (req, res) => {
  const b = parse(z.object({ ids: z.array(zId).min(1).max(200), status: z.enum(['RECEIVED', 'WASHING', 'READY']) }), req.body);
  // Back to "received" re-opens staff-only corrections and cancelling, so only the admin may do it.
  res.json({ changed: await setStatus(actor(req).id, b.ids, b.status, { allowBackToReceived: isAdmin(req) }) });
}));

router.post('/ops/orders/:id/pay', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ method: z.enum(['CASH', 'UPI']), ref: z.string().trim().max(60).default('') }), req.body);
  await recordPayment(actor(req).id, id, b.method, b.ref);
  res.json(await orderDetail(id));
}));

router.post('/ops/orders/:id/waive', requireRole('ADMIN'), handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ reason: zText(3, 200) }), req.body);
  await recordPayment(actor(req).id, id, 'WAIVED', b.reason);
  res.json(await orderDetail(id));
}));

router.post('/ops/orders/:id/deliver', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({
    returnedCount: z.coerce.number().int().min(0, 'Count cannot be negative').max(300),
    note: z.string().trim().max(200).default(''),
    payMethod: z.enum(['CASH', 'UPI']).optional(),
    payRef: z.string().trim().max(60).default(''),
  }), req.body);
  await db.tx(async () => {   // payment + handover succeed or fail together
    await db.lockRow('orders', id);
    if (b.payMethod && (await getOrderRow(id)).payment_status === 'DUE') await recordPayment(actor(req).id, id, b.payMethod, b.payRef);
    await deliverOrder(actor(req).id, id, b.returnedCount, b.note);
  });
  res.json(await orderDetail(id));
}));

router.post('/ops/orders/:id/cancel', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ reason: zText(3, 200) }), req.body);
  await db.tx(async () => {   // the status check and the cancel see the same row
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (!isAdmin(req) && o.status !== 'RECEIVED') throw new HttpError(403, 'Staff can only cancel orders that have not started washing. Ask the admin.');
    await cancelOrder(actor(req).id, id, b.reason);
  });
  res.json(await orderDetail(id));
}));

router.patch('/ops/orders/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ weightKg: z.coerce.number().min(0).max(50), clothesCount: z.coerce.number().int().min(1).max(300), reason: zText(3, 200) }), req.body);
  await db.tx(async () => {   // the status check and the correction see the same row
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (!isAdmin(req) && o.status !== 'RECEIVED') throw new HttpError(403, 'Staff can only correct orders that have not started washing. Ask the admin.');
    await correctOrder(actor(req).id, id, b.weightKg, b.clothesCount, b.reason);
  });
  res.json(await orderDetail(id));
}));

/** Change the basket card on an order that hasn't been collected (wrong card typed, card lost). */
router.patch('/ops/orders/:id/card', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ tagNo: z.string().trim().max(20) }), req.body);
  const s = await getSettings();
  const card = checkCard(s, b.tagNo);
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (!['RECEIVED', 'WASHING', 'READY'].includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()}; its card can't be changed.`);
    if (card) {
      const busy = await cardInUse(card, id);
      if (busy) throw new HttpError(409, `Card ${card} is still on ${busy.order_no}. Use another card.`, { code: 'CARD_IN_USE' });
    }
    await db.run('UPDATE orders SET tag_no = ?, updated_at = ? WHERE id = ?', [card, nowIso(), id]);
    await addEvent(id, 'CARD', card ? `Basket card ${card}` : 'Basket card removed', actor(req).id);
    await logActivity(actor(req).id, 'ORDER_CARD', 'order', o.order_no, card ?? 'removed');
  });
  res.json(await orderDetail(id));
}));

/* ------------------------------------------------------------------ photos */

/** Staff take or upload the student's photo at the counter (also after approval). */
router.post('/ops/students/:id/photo', photoUpload.single('photo'), handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose a photo.');
  const before = await studentProfile(id);
  const name = await savePhoto(req.file);
  await db.run('UPDATE users SET photo = ? WHERE id = ?', [name, id]);
  if (before.photo) await db.run('DELETE FROM files WHERE name = ?', [before.photo]);
  await logActivity(actor(req).id, 'PHOTO_SET', 'student', before.id_card_no);
  res.json(await counterCard(id));
}));
router.delete('/ops/students/:id/photo', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const before = await studentProfile(id);
  await db.run('UPDATE users SET photo = NULL WHERE id = ?', [id]);
  if (before.photo) await db.run('DELETE FROM files WHERE name = ?', [before.photo]);
  await logActivity(actor(req).id, 'PHOTO_REMOVED', 'student', before.id_card_no);
  res.json(await counterCard(id));
}));

/* -------------------------------------------------------------- complaints */

router.get('/ops/complaints', handle(async (req, res) => {
  const status = parse(z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', '']).optional(), req.query.status);
  res.json({ rows: await listComplaints({ status: status || undefined }) });
}));

router.get('/ops/complaints/:id', handle(async (req, res) => res.json(await complaintDetail(parse(zId, req.params.id)))));

router.post('/ops/complaints/:id/update', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(), message: z.string().trim().max(1000).default('') }), req.body);
  await db.tx(async () => {
    await db.lockRow('complaints', id);
    const c = await complaintDetail(id);
    if (!b.message && (!b.status || b.status === c.status)) throw new HttpError(400, 'Write a reply or change the status.');
    const at = nowIso();
    await db.run('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)', [id, actor(req).id, b.status && b.status !== c.status ? b.status : null, b.message || null, at]);
    await db.run('UPDATE complaints SET status = COALESCE(?, status), updated_at = ? WHERE id = ?', [b.status ?? null, at, id]);
    await notify(c.student_id, b.status === 'RESOLVED' ? 'Complaint resolved' : 'Reply on your complaint', b.message || `Status: ${(b.status ?? c.status).replace('_', ' ').toLowerCase()}`);
    await logActivity(actor(req).id, 'COMPLAINT_UPDATED', 'complaint', id, `${b.status ?? ''} ${b.message}`.trim());
  });
  res.json(await complaintDetail(id));
}));
