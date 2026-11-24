import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import { TABLES, db, insertId, logActivity, type Row } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { getSettings, listServices, saveSettings, serviceSchema } from '../rules.js';
import { photoUpload, savePhoto } from '../files.js';
import { readUpload, writeXlsx, XLSX_TYPE } from '../sheets.js';
import { mailConfigured } from '../mail.js';
import { checkStudentEmail } from '../otp.js';
import { announcementsFor, listOrders } from '../queries.js';
import { dayKey, handle, HttpError, likeContains, nowIso, parse, startOfLocalDayIso, zDate, zId, zText } from '../util.js';
import { normaliseLogin, zIdCard, zMobile, zPassword, zRoom } from './public.js';
import { tempPassword, tempPasswordExpiry } from './ops.js';
import { claimHash } from './public.js';

export const router = Router();
router.use('/admin', requireRole('ADMIN'));
// Announcements are read by everyone signed in, written by admin only.
router.get('/announcements', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const hostel = user.role === 'STUDENT' ? (await db.get<{ hostel_id: number }>('SELECT hostel_id FROM students WHERE user_id = ?', [user.id]))!.hostel_id : null;
  res.json({ rows: await announcementsFor(hostel) });
}));

const actor = (req: unknown) => (req as AuthedRequest).user;
const one = async (sql: string, ...p: unknown[]) => (await db.get<{ c: number }>(sql, p))!.c;
const daysAgo = (n: number) => dayKey(new Date(Date.now() - n * 86400_000));

/**
 * Await an object of promises at once and keep its keys (and their order). Independent read-only
 * queries then run side by side on Postgres (several pool connections); SQLite simply queues them.
 */
async function together<T extends Record<string, unknown>>(o: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(o);
  const values = await Promise.all(keys.map(k => o[k]));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [K in keyof T]: Awaited<T[K]> };
}

/* ---------------------------------------------------------------- overview */

router.get('/admin/overview', handle(async (_req, res) => {
  const today = dayKey();
  const month = today.slice(0, 7);
  const d = await together({
    series: db.all<{ day: string; orders: number; kg: number }>(`SELECT day_key AS day, COUNT(*) AS orders, ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1) AS kg FROM orders
      WHERE day_key >= ? AND status != 'CANCELLED' GROUP BY day_key ORDER BY day_key`, [daysAgo(13)]),
    hostels: db.all(`SELECT hostel_name AS name, COUNT(*) AS orders, ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1) AS kg FROM orders
      WHERE month_key = ? AND status != 'CANCELLED' GROUP BY hostel_name ORDER BY orders DESC`, [month]),
    settings: getSettings(),
    today: together({
      orders: one(`SELECT COUNT(*) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      kg: one(`SELECT COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1), 0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      delivered: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'DELIVERED' AND delivered_at >= ?`, startOfLocalDayIso()),
    }),
    month: together({
      orders: one(`SELECT COUNT(*) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
      kg: one(`SELECT COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1), 0) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
      revenue: one(`SELECT COALESCE(SUM(amount), 0) AS c FROM orders WHERE month_key = ? AND payment_status = 'PAID'`, month),
      students: one(`SELECT COUNT(DISTINCT student_id) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
    }),
    open: together({
      in_progress: one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING')`),
      ready: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY'`),
      late: one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING') AND expected_at < ?`, nowIso()),
      uncollected: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY' AND ready_at < ?`, new Date(Date.now() - 3 * 86400_000).toISOString()),
      dues: one(`SELECT COALESCE(SUM(amount), 0) AS c FROM orders WHERE payment_status = 'DUE' AND status != 'CANCELLED'`),
      pending_students: one(`SELECT COUNT(*) AS c FROM students WHERE status = 'PENDING'`),
      complaints: one(`SELECT COUNT(*) AS c FROM complaints WHERE status != 'RESOLVED'`),
    }),
    totals: together({
      students: one(`SELECT COUNT(*) AS c FROM students WHERE status = 'ACTIVE'`),
      staff: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'STAFF' AND active = 1`),
    }),
    setup: together({
      hostels: one('SELECT COUNT(*) AS c FROM hostels WHERE active = 1'),
      staff: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'STAFF'`),
      rules: one('SELECT COUNT(*) AS c FROM settings'),
      defaultPassword: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND must_change_password = 1`),
    }),
    recent: db.all(`SELECT a.action, a.entity_id, a.detail, a.created_at, u.name AS actor_name FROM activity a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 8`),
  });
  const byDay = new Map(d.series.map(r => [r.day, r]));
  const days = Array.from({ length: 14 }, (_, i) => daysAgo(13 - i)).map(day => byDay.get(day) ?? { day, orders: 0, kg: 0 });
  res.json({
    today: d.today,
    month: d.month,
    open: d.open,
    totals: d.totals,
    days,
    hostels: d.hostels,
    setup: [
      { key: 'hostels', label: 'Add your hostels', done: d.setup.hostels > 0 },
      { key: 'staff', label: 'Create a staff account for the counter', done: d.setup.staff > 0 },
      { key: 'rules', label: 'Review rules & pricing', done: d.setup.rules > 0 },
      { key: 'password', label: 'Change the default admin password', done: d.setup.defaultPassword === 0 },
    ],
    upi_configured: !!d.settings.upi_id,
    recent: d.recent,
  });
}));

/* ---------------------------------------------------------------- settings */

router.get('/admin/settings', handle(async (_req, res) => res.json(await getSettings())));
/** Is email sending set up on this server (Render: BREVO_API_KEY and MAIL_FROM)? */
router.get('/admin/mail-status', handle(async (_req, res) => {
  res.json({ configured: mailConfigured(), from: mailConfigured() ? process.env.MAIL_FROM : null, local: !mailConfigured() && process.env.NODE_ENV !== 'production' });
}));
router.put('/admin/settings', handle(async (req, res) => {
  // The UPI QR image is set only by uploading it.
  const { upi_qr_file: _ignored, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  res.json(await saveSettings(actor(req).id, rest));
}));

/* ----------------------------------------------------------------- hostels */

router.get('/admin/hostels', handle(async (_req, res) => {
  res.json({ rows: await db.all(`SELECT h.id, h.name, h.active, (SELECT COUNT(*) FROM students s WHERE s.hostel_id = h.id AND s.status = 'ACTIVE') AS students FROM hostels h ORDER BY h.active DESC, h.name`) });
}));
router.post('/admin/hostels', handle(async (req, res) => {
  const b = parse(z.object({ name: zText(1, 40) }), req.body);
  if (await db.get('SELECT 1 FROM hostels WHERE LOWER(name) = LOWER(?)', [b.name])) throw new HttpError(409, 'A hostel with this name already exists.');
  const id = await insertId('INSERT INTO hostels (name) VALUES (?)', [b.name]);
  await logActivity(actor(req).id, 'HOSTEL_ADDED', 'hostel', id, b.name);
  res.status(201).json({ id });
}));
router.patch('/admin/hostels/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ name: zText(1, 40).optional(), active: z.boolean().optional() }), req.body);
  if (b.name && await db.get('SELECT 1 FROM hostels WHERE LOWER(name) = LOWER(?) AND id != ?', [b.name, id])) throw new HttpError(409, 'A hostel with this name already exists.');
  await db.run('UPDATE hostels SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?', [b.name ?? null, b.active === undefined ? null : Number(b.active), id]);
  await logActivity(actor(req).id, 'HOSTEL_UPDATED', 'hostel', id, JSON.stringify(b));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------- staff */

router.get('/admin/staff', handle(async (_req, res) => {
  const month = dayKey().slice(0, 7);
  res.json({ rows: await db.all(`SELECT u.id, u.name, u.login_id, u.mobile, u.role, u.active, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.received_by = u.id AND o.month_key = ?) AS month_received,
      (SELECT COUNT(*) FROM orders o WHERE o.delivered_by = u.id AND substr(o.delivered_at,1,7) = ?) AS month_delivered,
      (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.paid_by = u.id AND o.payment_status = 'PAID' AND substr(o.paid_at,1,7) = ?) AS month_collected,
      (SELECT MAX(a.created_at) FROM activity a WHERE a.actor_id = u.id) AS last_active
    FROM users u WHERE u.role IN ('STAFF','ADMIN') ORDER BY u.active DESC, u.role, u.name`, [month, month, month]) });
}));
router.post('/admin/staff', handle(async (req, res) => {
  const b = parse(z.object({
    name: zText(2, 80),
    loginId: z.string().transform(normaliseLogin).pipe(z.string().min(3, 'Username must be at least 3 characters').max(30).regex(/^[A-Z0-9._-]+$/, 'Username can only have letters, numbers, . _ -')),
    mobile: zMobile.or(z.literal('')).default(''),
    password: zPassword(8),
    role: z.enum(['STAFF', 'ADMIN']).default('STAFF'),
  }), req.body);
  if (await db.get('SELECT 1 FROM users WHERE login_id = ?', [b.loginId])) throw new HttpError(409, 'This username is taken (it may be a student ID card no.).');
  const id = await insertId('INSERT INTO users (role, login_id, name, mobile, password_hash, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)',
    [b.role, b.loginId, b.name, b.mobile || null, bcrypt.hashSync(b.password, 10), nowIso()]);
  await logActivity(actor(req).id, 'STAFF_CREATED', 'user', b.loginId, `${b.name} · ${b.role}`);
  res.status(201).json({ id });
}));
router.patch('/admin/staff/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ active: z.boolean().optional(), name: zText(2, 80).optional(), mobile: zMobile.or(z.literal('')).optional() }), req.body);
  await db.tx(async () => {
    const u = await db.get<{ login_id: string; role: string }>(`SELECT login_id, role FROM users WHERE id = ? AND role IN ('STAFF','ADMIN')`, [id]);
    if (!u) throw new HttpError(404, 'Staff account not found.');
    if (b.active === false && id === actor(req).id) throw new HttpError(400, 'You cannot switch off your own account.');
    if (b.active === false && u.role === 'ADMIN') {
      // Lock the active admins (always in id order) so two admins can't switch each other off at the same moment.
      for (const a of await db.all<{ id: number }>(`SELECT id FROM users WHERE role = 'ADMIN' AND active = 1 ORDER BY id`)) await db.lockRow('users', a.id);
      if (await one(`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND active = 1`) <= 1) throw new HttpError(400, 'Keep at least one active admin.');
    }
    // Switching an account off also signs it out everywhere (token_version bump).
    await db.run('UPDATE users SET active = COALESCE(?, active), name = COALESCE(?, name), mobile = COALESCE(?, mobile), token_version = token_version + ? WHERE id = ?',
      [b.active === undefined ? null : Number(b.active), b.name ?? null, b.mobile === undefined ? null : b.mobile || null, b.active === false ? 1 : 0, id]);
    await logActivity(actor(req).id, b.active === false ? 'STAFF_DEACTIVATED' : b.active ? 'STAFF_REACTIVATED' : 'STAFF_UPDATED', 'user', u.login_id);
  });
  res.json({ ok: true });
}));
router.post('/admin/staff/:id/reset-password', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const u = await db.get<{ login_id: string }>(`SELECT login_id FROM users WHERE id = ? AND role IN ('STAFF','ADMIN')`, [id]);
  if (!u) throw new HttpError(404, 'Staff account not found.');
  const pass = tempPassword();
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 1, password_expires_at = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(pass, 10), tempPasswordExpiry(), id]);
  await logActivity(actor(req).id, 'PASSWORD_RESET', 'user', u.login_id);
  res.json({ tempPassword: pass });
}));

/* ----------------------------------------------------------- announcements */

router.get('/admin/announcements', handle(async (_req, res) => {
  res.json({ rows: await db.all(`SELECT a.*, h.name AS hostel_name, u.name AS created_by_name, CASE WHEN a.expires_on IS NOT NULL AND a.expires_on < ? THEN 1 ELSE 0 END AS expired
    FROM announcements a LEFT JOIN hostels h ON h.id = a.hostel_id LEFT JOIN users u ON u.id = a.created_by WHERE a.active = 1 ORDER BY a.id DESC LIMIT 100`, [dayKey()]) });
}));
router.post('/admin/announcements', handle(async (req, res) => {
  const b = parse(z.object({
    title: zText(3, 80),
    body: zText(3, 600),
    hostelId: z.union([z.literal(''), z.null(), z.coerce.number().int().positive()]).optional(),
    expiresOn: z.union([z.literal(''), z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
    notify: z.boolean().default(true),
  }), req.body);
  const hostelId = b.hostelId ? Number(b.hostelId) : null;
  const id = await db.tx(async () => {
    const id = await insertId('INSERT INTO announcements (title, body, hostel_id, expires_on, created_by, created_at) VALUES (?,?,?,?,?,?)',
      [b.title, b.body, hostelId, b.expiresOn || null, actor(req).id, nowIso()]);
    if (b.notify) {
      // One INSERT…SELECT: fast even for thousands of students.
      await db.run(`INSERT INTO notifications (user_id, title, body, created_at)
        SELECT s.user_id, ?, ?, ? FROM students s JOIN users u ON u.id = s.user_id WHERE s.status = 'ACTIVE' AND u.active = 1 ${hostelId ? 'AND s.hostel_id = ?' : ''}`,
        [`📢 ${b.title}`, b.body, nowIso(), ...(hostelId ? [hostelId] : [])]);
    }
    await logActivity(actor(req).id, 'ANNOUNCEMENT_POSTED', 'announcement', id, b.title);
    return id;
  });
  res.status(201).json({ id });
}));
router.delete('/admin/announcements/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  await db.run('UPDATE announcements SET active = 0 WHERE id = ?', [id]);
  await logActivity(actor(req).id, 'ANNOUNCEMENT_REMOVED', 'announcement', id);
  res.status(204).end();
}));

/* ----------------------------------------------------------------- reports */

const range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick an end date'),
  status: z.string().optional(), hostel: z.string().optional(), payment: z.string().optional(),
}).refine(r => r.from <= r.to, 'Start date must be before end date');

router.get('/admin/report', handle(async (req, res) => {
  const r = parse(range, req.query);
  const w = `day_key BETWEEN ? AND ?`;
  const p = [r.from, r.to];
  res.json(await together({
    totals: db.get(`SELECT COUNT(*) AS orders, COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1), 0) AS kg, COALESCE(SUM(clothes_count), 0) AS clothes,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled, COUNT(DISTINCT student_id) AS students,
        SUM(CASE WHEN returned_count IS NOT NULL AND returned_count != clothes_count THEN 1 ELSE 0 END) AS mismatches,
        COALESCE(ROUND(CAST(SUM(extra_kg) AS NUMERIC), 1), 0) AS extra_kg, SUM(CASE WHEN service = 'EXPRESS' THEN 1 ELSE 0 END) AS express
      FROM orders WHERE ${w}`, p),
    money: db.get(`SELECT COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN amount END), 0) AS collected,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND paid_method = 'CASH' THEN amount END), 0) AS cash,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND paid_method = 'UPI' THEN amount END), 0) AS upi,
        COALESCE(SUM(CASE WHEN payment_status = 'DUE' AND status != 'CANCELLED' THEN amount END), 0) AS due,
        COALESCE(SUM(CASE WHEN payment_status = 'WAIVED' THEN amount END), 0) AS waived
      FROM orders WHERE ${w}`, p),
    byService: db.all(`SELECT COALESCE(service_name, 'Wash & fold') AS name, COUNT(*) AS orders, SUM(clothes_count) AS clothes, ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1) AS kg,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN amount END), 0) AS collected
      FROM orders WHERE ${w} AND status != 'CANCELLED' GROUP BY COALESCE(service_name, 'Wash & fold') ORDER BY orders DESC`, p),
    byHostel: db.all(`SELECT hostel_name AS name, COUNT(*) AS orders, ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1) AS kg, SUM(clothes_count) AS clothes FROM orders WHERE ${w} AND status != 'CANCELLED' GROUP BY hostel_name ORDER BY orders DESC`, p),
    byStaff: db.all(`SELECT u.name, SUM(CASE WHEN o.received_by = u.id THEN 1 ELSE 0 END) AS received, SUM(CASE WHEN o.delivered_by = u.id THEN 1 ELSE 0 END) AS delivered
      FROM users u JOIN orders o ON (o.received_by = u.id OR o.delivered_by = u.id)
      WHERE o.${w} GROUP BY u.id, u.name ORDER BY received DESC`, p),
    topStudents: db.all(`SELECT u.name, st.id_card_no, COUNT(*) AS orders, ROUND(CAST(SUM(o.weight_kg) AS NUMERIC), 1) AS kg FROM orders o JOIN users u ON u.id = o.student_id JOIN students st ON st.user_id = o.student_id
      WHERE o.${w} AND o.status != 'CANCELLED' GROUP BY u.id, u.name, st.id_card_no ORDER BY kg DESC LIMIT 10`, p),
  }));
}));

/** Excel export that mirrors the old paper register, one row per order. */
router.get('/admin/export', handle(async (req, res) => {
  const r = parse(range, req.query);
  const { rows } = await listOrders({ from: r.from, to: r.to, status: r.status || undefined, hostel: r.hostel || undefined, payment: r.payment || undefined, limit: 5000 });
  if (!rows.length) throw new HttpError(404, 'No orders match these filters.');
  const t = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { timeZone: process.env.APP_TZ || 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
  const sheet = (rows as Record<string, unknown>[]).reverse().map(o => ({
    'Order No': o.order_no,
    'Card No': o.tag_no ?? '',
    'Date In': t(o.received_at),
    'ID Card No': o.id_card_no,
    'Name': o.student_name,
    'Mobile': o.mobile ?? '',
    'Hostel': o.hostel_name,
    'Room': o.room_no,
    'Clothes Given': o.clothes_count,
    'Weight (kg)': o.weight_kg,
    'Service': o.service_name ?? 'Wash & fold',
    'Express': o.service === 'EXPRESS' ? 'Yes' : '',
    'Status': o.status,
    'Received By': o.received_by_name,
    'Ready At': t(o.ready_at),
    'Delivered At': t(o.delivered_at),
    'Clothes Returned': o.returned_count ?? '',
    'Delivered By': o.delivered_by_name ?? '',
    'Extra kg': o.extra_kg,
    'Amount (₹)': o.amount,
    'Payment': o.payment_status,
    'Paid Via': o.paid_method ?? '',
    'Note': [o.note, o.cancel_reason].filter(Boolean).join(' · '),
  }));
  const header = Object.keys(sheet[0]);
  const buf = await writeXlsx([{ name: 'Register', header, rows: sheet.map(o => header.map(k => (o as Record<string, unknown>)[k])) }]);
  await logActivity(actor(req).id, 'EXPORTED', 'report', null, `${r.from} → ${r.to} · ${rows.length} orders`);
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="everjoy-register-${r.from}-to-${r.to}.xlsx"`);
  res.send(buf);
}));

/* ---------------------------------------------------------- activity, backup */

router.get('/admin/activity', handle(async (req, res) => {
  const q = parse(z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const like = likeContains(q.q ?? '');
  const where = q.q ? `WHERE LOWER(a.action) LIKE LOWER(?) ESCAPE '\\' OR LOWER(a.entity_id) LIKE LOWER(?) ESCAPE '\\' OR LOWER(a.detail) LIKE LOWER(?) ESCAPE '\\' OR LOWER(u.name) LIKE LOWER(?) ESCAPE '\\'` : '';
  // limit and offset are integers checked by zod above, so they are safe to put in the SQL.
  res.json({ rows: await db.all(`SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS actor_name, u.role AS actor_role
    FROM activity a LEFT JOIN users u ON u.id = a.actor_id ${where} ORDER BY a.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, q.q ? [like, like, like, like] : []) });
}));

/** Blob columns (photos in the files table) become base64 text so the backup is plain JSON. */
const jsonSafe = (row: Row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v]));

router.get('/admin/backup', handle(async (req, res) => {
  if (db.isFile) {
    // SQLite on disk: a consistent copy of the database file.
    const file = path.join(os.tmpdir(), `everjoy-backup-${Date.now()}.db`);
    await db.backupFile(file);
    // The session signing secret stays on the server: anyone holding a backup must not be able to sign in as admin.
    const { default: Sqlite } = await import('better-sqlite3');
    const copy = new Sqlite(file);
    try { copy.exec("DELETE FROM app_secrets; VACUUM;"); } finally { copy.close(); }
    await logActivity(actor(req).id, 'BACKUP_DOWNLOADED', 'system', null);
    res.download(file, `everjoy-lawndry-backup-${dayKey()}.db`, () => fs.rm(file, { force: true }, () => {}));
    return;
  }
  // Postgres (or an in-memory database): every table as JSON, read from one snapshot so rows that refer to each other match.
  const tables = await db.tx(async () => {
    if (db.dialect === 'postgres') await db.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const out: Record<string, Row[]> = {};
    for (const table of TABLES) out[table] = (await db.all(`SELECT * FROM ${table} ORDER BY 1`)).map(jsonSafe);
    return out;
  });
  const backup = JSON.stringify({ app: 'everjoy-lawndry', version: 1, exported_at: nowIso(), tables });
  await logActivity(actor(req).id, 'BACKUP_DOWNLOADED', 'system', null);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="everjoy-lawndry-backup-${dayKey()}.json"`);
  res.send(backup);
}));

/* ---------------------------------------------------------------- services */

// Everyone signed in can see the services and prices (students see them in Help).
router.get('/services', handle(async (req, res) => {
  if (!(req as AuthedRequest).user) throw new HttpError(401, 'Please sign in.');
  res.json({ rows: await listServices() });
}));
router.get('/admin/services', handle(async (_req, res) => res.json({ rows: await listServices(true) })));
router.post('/admin/services', handle(async (req, res) => {
  const b = parse(serviceSchema, req.body);
  if (await db.get('SELECT 1 AS ok FROM services WHERE lower(name) = lower(?)', [b.name])) throw new HttpError(409, 'A service with this name already exists.');
  const id = await insertId('INSERT INTO services (name, unit, rate, hosteler_rate, uses_allowance, active, sort, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [b.name, b.unit, b.rate, b.hosteler_rate, b.uses_allowance ? 1 : 0, b.active ? 1 : 0, b.sort, nowIso()]);
  await logActivity(actor(req).id, 'SERVICE_ADDED', 'service', id, `${b.name}: ₹${b.rate}/${b.unit === 'KG' ? 'kg' : 'piece'}, hostelers ₹${b.hosteler_rate}`);
  res.status(201).json({ id });
}));
router.patch('/admin/services/:id', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const before = await db.get<Row>('SELECT * FROM services WHERE id = ?', [id]);
  if (!before) throw new HttpError(404, 'Service not found.');
  const b = parse(serviceSchema, { ...before, uses_allowance: !!before.uses_allowance, active: !!before.active, ...(req.body as object) });
  if (await db.get('SELECT 1 AS ok FROM services WHERE lower(name) = lower(?) AND id != ?', [b.name, id])) throw new HttpError(409, 'A service with this name already exists.');
  if (!b.active && before.active && Number((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM services WHERE active = 1'))!.c) <= 1) throw new HttpError(400, 'Keep at least one service offered.');
  await db.run('UPDATE services SET name = ?, unit = ?, rate = ?, hosteler_rate = ?, uses_allowance = ?, active = ?, sort = ? WHERE id = ?',
    [b.name, b.unit, b.rate, b.hosteler_rate, b.uses_allowance ? 1 : 0, b.active ? 1 : 0, b.sort, id]);
  await logActivity(actor(req).id, 'SERVICE_UPDATED', 'service', id,
    `${before.name} → ${b.name}: ₹${before.rate}→₹${b.rate}, hostelers ₹${before.hosteler_rate}→₹${b.hosteler_rate}${b.active ? '' : ', hidden'}`);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ UPI QR */

/** The UPI QR image (e.g. from GPay/PhonePe Business) shown to students and at the counter. */
router.get('/upi-qr', handle(async (req, res) => {
  if (!(req as AuthedRequest).user) throw new HttpError(401, 'Please sign in.');
  const { upi_qr_file: name } = await getSettings();
  const row = name ? await db.get<{ mime: string; data: Buffer | Uint8Array }>('SELECT mime, data FROM files WHERE name = ?', [name]) : undefined;
  if (!row) throw new HttpError(404, 'No UPI QR has been uploaded.');
  res.type(row.mime).send(Buffer.from(row.data));
}));
/** What the pay screens need: UPI ID, name and whether a QR image was uploaded. */
router.get('/payment-info', handle(async (req, res) => {
  if (!(req as AuthedRequest).user) throw new HttpError(401, 'Please sign in.');
  const s = await getSettings();
  res.json({ upi_id: s.upi_id, upi_name: s.upi_name, has_upi_qr: !!s.upi_qr_file });
}));
router.post('/admin/upi-qr', photoUpload.single('qr'), handle(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the UPI QR image.');
  const name = await savePhoto(req.file);
  const before = (await getSettings()).upi_qr_file;
  await saveSettings(actor(req).id, { upi_qr_file: name });
  if (before) await db.run('DELETE FROM files WHERE name = ?', [before]);
  res.status(201).json({ ok: true });
}));
router.delete('/admin/upi-qr', handle(async (req, res) => {
  const before = (await getSettings()).upi_qr_file;
  await saveSettings(actor(req).id, { upi_qr_file: '' });
  if (before) await db.run('DELETE FROM files WHERE name = ?', [before]);
  res.status(204).end();
}));

/* ---------------------------------------------------------- hostel plans */

/**
 * Set the hostel plan end date for many students at once (e.g. new semester).
 * scope ALL = every hosteler, HOSTEL = one hostel, IDS = chosen students.
 */
router.post('/admin/students/validity', handle(async (req, res) => {
  const b = parse(z.object({
    validFrom: z.union([z.literal(''), zDate]).optional().default(''),
    validUntil: z.union([z.literal(''), zDate]),
    scope: z.enum(['ALL', 'HOSTEL', 'IDS']),
    hostelId: zId.optional(),
    ids: z.array(zId).max(5000).optional(),
  }), req.body);
  if (b.validFrom && b.validUntil && b.validFrom > b.validUntil) throw new HttpError(400, 'The plan start must be before its end.');
  const where: string[] = ["kind = 'HOSTELER'", "status = 'ACTIVE'"];
  const p: unknown[] = [b.validFrom || null, b.validUntil || null];
  if (b.scope === 'HOSTEL') {
    if (!b.hostelId) throw new HttpError(400, 'Choose a hostel.');
    where.push('hostel_id = ?'); p.push(b.hostelId);
  }
  if (b.scope === 'IDS') {
    if (!b.ids?.length) throw new HttpError(400, 'Choose at least one student.');
    where.push(`user_id IN (${b.ids.map(() => '?').join(',')})`); p.push(...b.ids);
  }
  const r = await db.run(`UPDATE students SET valid_from = ?, valid_until = ? WHERE ${where.join(' AND ')}`, p);
  await logActivity(actor(req).id, 'PLAN_DATES_SET', 'student', null, `${r.changes} students → ${b.validFrom || '…'} to ${b.validUntil || 'no end date'} (${b.scope})`);
  res.json({ changed: r.changes });
}));

/* ------------------------------------------------------------ Excel import */

const IMPORT_COLUMNS = {
  students: ['ID Card No', 'Full Name', 'Mobile', 'University Email', 'Hostel', 'Room', 'Valid From', 'Valid Until'],
  staff: ['Full Name', 'Username', 'Mobile', 'Role'],
} as const;
/** Columns a sheet must have; the others may be missing (older templates). */
const REQUIRED_COLUMNS = {
  students: ['ID Card No', 'Full Name', 'Mobile', 'Hostel', 'Room'],
  staff: ['Full Name', 'Username', 'Role'],
} as const;
type ImportType = keyof typeof IMPORT_COLUMNS;

/** A ready-made Excel file with the right headers, an example row and instructions. */
router.get('/admin/import/template/:type', handle(async (req, res) => {
  const type = parse(z.enum(['students', 'staff']), req.params.type) as ImportType;
  const example = type === 'students'
    ? [{ 'ID Card No': 'EJ2026101', 'Full Name': 'Ananya Rao', 'Mobile': '9876543210', 'University Email': 'ananya.rao@university.edu.in', 'Hostel': 'Girls Hostel 1', 'Room': '204', 'Valid From': '2027-01-01', 'Valid Until': '2027-06-30' }]
    : [{ 'Full Name': 'Suresh Kumar', 'Username': 'SURESH', 'Mobile': '9811122233', 'Role': 'STAFF' }];
  const help = type === 'students'
    ? [['How to fill this sheet'], ['One student per row. Keep the header row exactly as it is and delete the example row.'],
      ['ID Card No: as printed on the ID card. Students sign in with it.'], ['Mobile: 10 digits. Students use it to set their own password: Register with the same ID card no. and mobile.'],
      ['University Email: the student gets a sign-in code here the first time (and on each new phone). Without it, the office hands out a claim code instead.'],
      ['Hostel: must match a hostel name (a new name creates that hostel).'],
      ['Valid From / Valid Until: the semester of the hostel plan, as YYYY-MM-DD. Jan–Jun semester: 2027-01-01 to 2027-06-30. Jul–Dec semester: 2027-07-01 to 2027-12-31. Leave both empty for no dates.'],
      ['A student who is already registered is updated (hostel, room, valid until), not added twice.']]
    : [['How to fill this sheet'], ['One staff member per row. Keep the header row and delete the example row.'],
      ['Username: letters and numbers, used to sign in.'], ['Role: STAFF (counter) or ADMIN.'],
      ['After the upload you get a temporary password for each person; they choose their own at first sign-in.']];
  const header = [...IMPORT_COLUMNS[type]];
  const buf = await writeXlsx([
    { name: type === 'students' ? 'Students' : 'Staff', header, rows: example.map(e => header.map(h => (e as Record<string, string>)[h])), widths: header.map(() => 18) },
    { name: 'Instructions', rows: help, widths: [110] },
  ]);
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="everjoy-${type}-import-template.xlsx"`);
  res.send(buf);
}));

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024, fieldNameSize: 64, parts: 6, headerPairs: 50 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(new HttpError(400, 'Upload the Excel file (.xlsx) or a .csv file.'))),
});

/** Excel may turn 2027-05-31 into 5/31/27 or a serial number: normalise to YYYY-MM-DD. */
function excelDate(v: string) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{5}$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400_000).toISOString().slice(0, 10);   // Excel serial day
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);   // day/month/year, as written in India
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return v;
}

/**
 * Import students or staff from the template. All rows are checked first: if any row has a
 * problem, nothing is imported and every problem is listed with its row number.
 */
router.post('/admin/import/:type', sheetUpload.single('file'), handle(async (req, res) => {
  const type = parse(z.enum(['students', 'staff']), req.params.type) as ImportType;
  if (!req.file) throw new HttpError(400, 'Choose the filled-in Excel file.');
  const sheet = await readUpload(req.file.buffer, /\.csv$/i.test(req.file.originalname));
  if (!sheet.length) throw new HttpError(400, 'The sheet has no rows under the header.');
  const rows = sheet.map(r => r.cells);
  const hasFrom = !!rows[0] && 'valid from' in rows[0];
  const hasUntil = !!rows[0] && 'valid until' in rows[0];
  const rowNo = (i: number) => sheet[i].row;
  const missing = REQUIRED_COLUMNS[type].filter(h => !(h.toLowerCase() in rows[0]));
  if (missing.length) throw new HttpError(400, `Missing column(s): ${missing.join(', ')}. Use the template from this page.`);
  const errors: { row: number; message: string }[] = [];
  const col = (r: Record<string, string>, h: string) => r[h.toLowerCase()] ?? '';

  if (type === 'students') {
    const schema = z.object({
      idCardNo: zIdCard, name: zText(2, 80), mobile: zMobile, hostel: zText(1, 40), roomNo: zRoom,
      email: z.union([z.literal(''), z.string().trim().toLowerCase().max(120).email('not a valid email')]),
      validFrom: z.union([z.literal(''), zDate]), validUntil: z.union([z.literal(''), zDate]),
    }).refine(x => !x.validFrom || !x.validUntil || x.validFrom <= x.validUntil, { message: 'Valid From must be before Valid Until', path: ['validFrom'] });
    const parsed: (z.infer<typeof schema> & { row: number })[] = [];
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      const result = schema.safeParse({ idCardNo: col(r, 'ID Card No'), name: col(r, 'Full Name'), mobile: col(r, 'Mobile'), email: col(r, 'University Email'), hostel: col(r, 'Hostel'), roomNo: col(r, 'Room'), validFrom: excelDate(col(r, 'Valid From')), validUntil: excelDate(col(r, 'Valid Until')) });
      if (!result.success) { const iss = result.error.issues[0]; errors.push({ row: rowNo(i), message: `${String(iss.path[0] ?? '')}: ${iss.message}` }); return; }
      if (seen.has(result.data.idCardNo)) { errors.push({ row: rowNo(i), message: `ID card ${result.data.idCardNo} appears twice in the sheet` }); return; }
      if (result.data.email && seen.has(`@${result.data.email}`)) { errors.push({ row: rowNo(i), message: `Email ${result.data.email} appears twice in the sheet` }); return; }
      seen.add(result.data.idCardNo);
      if (result.data.email) seen.add(`@${result.data.email}`);
      parsed.push({ ...result.data, row: rowNo(i) });
    });
    for (const r of parsed) {
      const clash = await db.get<{ role: string; kind: string | null }>('SELECT u.role, st.kind FROM users u LEFT JOIN students st ON st.user_id = u.id WHERE u.login_id = ?', [r.idCardNo]);
      if (clash && clash.role !== 'STUDENT') errors.push({ row: r.row, message: `${r.idCardNo} is already a staff username` });
      else if (clash && clash.kind === 'WALKIN') errors.push({ row: r.row, message: `${r.idCardNo} belongs to a walk-in customer` });
      const current = await db.get<{ email: string | null }>('SELECT email FROM students WHERE id_card_no = ?', [r.idCardNo]);
      if (r.email && r.email !== (current?.email ?? '').toLowerCase()) {
        try { await checkStudentEmail(r.email); } catch (e) { errors.push({ row: r.row, message: (e as Error).message }); continue; }
        const other = await db.get<{ id_card_no: string }>('SELECT id_card_no FROM students WHERE lower(email) = ? AND id_card_no != ?', [r.email, r.idCardNo]);
        if (other) errors.push({ row: r.row, message: `${r.email} is already used by ${other.id_card_no}` });
      }
    }
    if (errors.length) return res.status(422).json({ error: `Nothing was imported. Fix ${errors.length} row(s) and upload again.`, details: { errors: errors.slice(0, 200) } });
    const result = await db.tx(async () => {
      let created = 0, updated = 0;
      const newHostels: string[] = [];
      // One-time claim codes for students who haven't set their password yet (shown once, stored hashed, 30 days).
      const codes: { idCardNo: string; name: string; code: string }[] = [];
      const claimExpires = new Date(Date.now() + 30 * 86400_000).toISOString();
      const newCode = () => { const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const c = Array.from({ length: 8 }, () => a[crypto.randomInt(a.length)]).join(''); return `${c.slice(0, 4)}-${c.slice(4)}`; };
      const hostelId = async (name: string) => {
        const h = await db.get<{ id: number }>('SELECT id FROM hostels WHERE lower(name) = lower(?)', [name]);
        if (h) return h.id;
        newHostels.push(name);
        return insertId('INSERT INTO hostels (name) VALUES (?)', [name]);
      };
      for (const r of parsed) {
        const hid = await hostelId(r.hostel);
        const existing = await db.get<{ user_id: number; claimable: number; email: string | null }>('SELECT user_id, claimable, email FROM students WHERE id_card_no = ?', [r.idCardNo]);
        if (existing) {
          // A sheet without the date columns leaves the plan dates as they are; an empty cell in a date column clears it.
          const sets = ['hostel_id = ?', 'room_no = ?', "kind = 'HOSTELER'"];
          const vals: unknown[] = [hid, r.roomNo];
          if (hasFrom) { sets.push('valid_from = ?'); vals.push(r.validFrom || null); }
          if (hasUntil) { sets.push('valid_until = ?'); vals.push(r.validUntil || null); }
          await db.run(`UPDATE students SET ${sets.join(', ')} WHERE user_id = ?`, [...vals, existing.user_id]);
          if (r.email && r.email !== (existing.email ?? '').toLowerCase()) {
            // New address from the office: confirmed again by the next sign-in code; trusted devices start over.
            await db.run('UPDATE students SET email = ?, email_verified_at = NULL WHERE user_id = ?', [r.email, existing.user_id]);
            await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [existing.user_id]);
          }
          if (existing.claimable) {
            // Not claimed yet: a fresh code replaces the old one (it may have been lost).
            const code = newCode();
            await db.run('UPDATE students SET claim_hash = ?, claim_expires_at = ? WHERE user_id = ?', [claimHash(code), claimExpires, existing.user_id]);
            codes.push({ idCardNo: r.idCardNo, name: r.name, code });
          }
          updated++;
          continue;
        }
        // No usable password: the student claims the account by registering with this ID card no. and mobile.
        const unusable = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);
        const userId = await insertId(`INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES ('STUDENT',?,?,?,?,?)`, [r.idCardNo, r.name, r.mobile, unusable, nowIso()]);
        // The student sets up the account with an emailed code (when email codes are on) or with this claim code from
        // the office. Every new account gets a claim code, so nobody is stuck if email codes are off.
        const code = newCode();
        await db.run(`INSERT INTO students (user_id, id_card_no, hostel_id, room_no, status, kind, valid_from, valid_until, claimable, claim_hash, claim_expires_at, email, reviewed_by, reviewed_at) VALUES (?,?,?,?,'ACTIVE','HOSTELER',?,?,1,?,?,?,?,?)`,
          [userId, r.idCardNo, hid, r.roomNo, r.validFrom || null, r.validUntil || null, code ? claimHash(code) : null, code ? claimExpires : null, r.email || null, actor(req).id, nowIso()]);
        if (code) codes.push({ idCardNo: r.idCardNo, name: r.name, code });
        created++;
      }
      await logActivity(actor(req).id, 'STUDENTS_IMPORTED', 'student', null, `${created} added, ${updated} updated${newHostels.length ? `, new hostels: ${newHostels.join(', ')}` : ''}`);
      return { created, updated, newHostels, codes };
    });
    return res.json(result);
  }

  // staff
  const schema = z.object({
    name: zText(2, 80),
    loginId: z.string().transform(normaliseLogin).pipe(z.string().min(3, 'Username must be at least 3 characters').max(30).regex(/^[A-Z0-9._-]+$/, 'Username can only have letters, numbers, . _ -')),
    mobile: zMobile.or(z.literal('')),
    role: z.string().transform(v => v.trim().toUpperCase() || 'STAFF').pipe(z.enum(['STAFF', 'ADMIN'], { error: 'Role must be STAFF or ADMIN' })),
  });
  const parsed: (z.infer<typeof schema> & { row: number })[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const result = schema.safeParse({ name: col(r, 'Full Name'), loginId: col(r, 'Username'), mobile: col(r, 'Mobile'), role: col(r, 'Role') });
    if (!result.success) { const iss = result.error.issues[0]; errors.push({ row: rowNo(i), message: `${String(iss.path[0] ?? '')}: ${iss.message}` }); return; }
    if (seen.has(result.data.loginId)) { errors.push({ row: rowNo(i), message: `Username ${result.data.loginId} appears twice in the sheet` }); return; }
    seen.add(result.data.loginId);
    parsed.push({ ...result.data, row: rowNo(i) });
  });
  for (const r of parsed) {
    if (await db.get('SELECT 1 AS ok FROM users WHERE login_id = ?', [r.loginId])) errors.push({ row: r.row, message: `Username ${r.loginId} is already taken` });
  }
  if (errors.length) return res.status(422).json({ error: `Nothing was imported. Fix ${errors.length} row(s) and upload again.`, details: { errors: errors.slice(0, 200) } });
  const accounts = await db.tx(async () => {
    const out: { name: string; username: string; role: string; tempPassword: string }[] = [];
    for (const r of parsed) {
      const pass = tempPassword();
      await insertId('INSERT INTO users (role, login_id, name, mobile, password_hash, must_change_password, password_expires_at, created_at) VALUES (?,?,?,?,?,1,?,?)',
        [r.role, r.loginId, r.name, r.mobile || null, await bcrypt.hash(pass, 10), tempPasswordExpiry(), nowIso()]);
      out.push({ name: r.name, username: r.loginId, role: r.role, tempPassword: pass });
    }
    await logActivity(actor(req).id, 'STAFF_IMPORTED', 'user', null, `${out.length} accounts`);
    return out;
  });
  res.json({ created: accounts.length, accounts });
}));

/* -------------------------------------------------------- staff work report */

/** What one staff member did in a period: orders, handovers, money, approvals, complaints. */
router.get('/admin/staff/:id/report', handle(async (req, res) => {
  const id = parse(zId, req.params.id);
  const r = parse(z.object({ from: zDate, to: zDate }).refine(x => x.from <= x.to, 'Start date must be before end date'), req.query);
  const person = await db.get<Row>(`SELECT id, name, login_id, mobile, role, active, created_at FROM users WHERE id = ? AND role IN ('STAFF','ADMIN')`, [id]);
  if (!person) throw new HttpError(404, 'Staff account not found.');
  // Timestamps are UTC ISO strings; compare whole days with a small margin and filter by campus day in JS where it matters.
  const fromIso = `${shiftDayKey(r.from, -1)}T18:30:00.000Z`;
  const toIso = `${r.to}T18:30:00.000Z`;
  const [taken, delivered, money, approvals, complaints, roomChanges, lastActive, byDay] = await Promise.all([
    db.get<Row>(`SELECT COUNT(*) AS orders, COALESCE(SUM(clothes_count),0) AS clothes, COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1),0) AS kg
      FROM orders WHERE received_by = ? AND day_key BETWEEN ? AND ? AND status != 'CANCELLED'`, [id, r.from, r.to]),
    db.get<Row>(`SELECT COUNT(*) AS orders, COALESCE(SUM(returned_count),0) AS clothes,
        COALESCE(SUM(CASE WHEN returned_count IS NOT NULL AND returned_count != clothes_count THEN 1 ELSE 0 END),0) AS mismatches
      FROM orders WHERE delivered_by = ? AND delivered_at >= ? AND delivered_at < ?`, [id, fromIso, toIso]),
    db.get<Row>(`SELECT COALESCE(SUM(CASE WHEN paid_method = 'CASH' THEN amount END),0) AS cash, COALESCE(SUM(CASE WHEN paid_method = 'UPI' THEN amount END),0) AS upi,
        COUNT(*) AS payments FROM orders WHERE paid_by = ? AND payment_status = 'PAID' AND paid_at >= ? AND paid_at < ?`, [id, fromIso, toIso]),
    db.get<Row>(`SELECT COALESCE(SUM(CASE WHEN action = 'STUDENT_APPROVED' THEN 1 ELSE 0 END),0) AS approved, COALESCE(SUM(CASE WHEN action = 'STUDENT_REJECTED' THEN 1 ELSE 0 END),0) AS rejected,
        COALESCE(SUM(CASE WHEN action = 'WALKIN_ADDED' THEN 1 ELSE 0 END),0) AS walkins, COALESCE(SUM(CASE WHEN action = 'PASSWORD_RESET' THEN 1 ELSE 0 END),0) AS resets
      FROM activity WHERE actor_id = ? AND created_at >= ? AND created_at < ?`, [id, fromIso, toIso]),
    db.get<Row>(`SELECT COUNT(DISTINCT complaint_id) AS handled, COALESCE(SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END),0) AS resolved
      FROM complaint_updates WHERE by_user = ? AND at >= ? AND at < ?`, [id, fromIso, toIso]),
    db.get<Row>(`SELECT COUNT(*) AS c FROM activity WHERE actor_id = ? AND action IN ('ROOM_CHANGE_APPROVED','ROOM_CHANGE_REJECTED') AND created_at >= ? AND created_at < ?`, [id, fromIso, toIso]),
    db.get<Row>('SELECT MAX(created_at) AS at FROM activity WHERE actor_id = ?', [id]),
    db.all<Row>(`SELECT day_key AS day, COUNT(*) AS orders, COALESCE(ROUND(CAST(SUM(weight_kg) AS NUMERIC), 1),0) AS kg FROM orders
      WHERE received_by = ? AND day_key BETWEEN ? AND ? AND status != 'CANCELLED' GROUP BY day_key ORDER BY day_key`, [id, r.from, r.to]),
  ]);
  res.json({ person, taken, delivered, money, approvals, complaints, room_changes: Number(roomChanges?.c ?? 0), last_active: lastActive?.at ?? null, by_day: byDay });
}));

function shiftDayKey(key: string, days: number) {
  const d = new Date(`${key}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
