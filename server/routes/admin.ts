import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import { z } from 'zod';
import { db, isMemoryDb, logActivity } from '../db.js';
import { AuthedRequest, requireRole } from '../auth.js';
import { getSettings, saveSettings } from '../rules.js';
import { announcementsFor, listOrders } from '../queries.js';
import { HttpError, dayKey, handle, nowIso, parse, startOfLocalDayIso, zId, zText } from '../util.js';
import { normaliseLogin, zMobile, zPassword } from './public.js';
import { tempPassword } from './ops.js';

export const router = Router();
router.use('/admin', requireRole('ADMIN'));
// Announcements are read by everyone signed in, written by admin only.
router.get('/announcements', handle((req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const hostel = user.role === 'STUDENT' ? (db.prepare('SELECT hostel_id FROM students WHERE user_id = ?').get(user.id) as { hostel_id: number }).hostel_id : null;
  res.json({ rows: announcementsFor(hostel) });
}));

const actor = (req: unknown) => (req as AuthedRequest).user;
const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
const daysAgo = (n: number) => dayKey(new Date(Date.now() - n * 86400_000));

/* ---------------------------------------------------------------- overview */

router.get('/admin/overview', handle((_req, res) => {
  const today = dayKey();
  const month = today.slice(0, 7);
  const series = db.prepare(`SELECT day_key AS day, COUNT(*) AS orders, ROUND(SUM(weight_kg),1) AS kg FROM orders
    WHERE day_key >= ? AND status != 'CANCELLED' GROUP BY day_key ORDER BY day_key`).all(daysAgo(13)) as { day: string; orders: number; kg: number }[];
  const byDay = new Map(series.map(r => [r.day, r]));
  const days = Array.from({ length: 14 }, (_, i) => daysAgo(13 - i)).map(day => byDay.get(day) ?? { day, orders: 0, kg: 0 });
  const hostels = db.prepare(`SELECT hostel_name AS name, COUNT(*) AS orders, ROUND(SUM(weight_kg),1) AS kg FROM orders
    WHERE month_key = ? AND status != 'CANCELLED' GROUP BY hostel_name ORDER BY orders DESC`).all(month);
  const s = getSettings();
  res.json({
    today: {
      orders: one(`SELECT COUNT(*) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      kg: one(`SELECT COALESCE(ROUND(SUM(weight_kg),1),0) AS c FROM orders WHERE day_key = ? AND status != 'CANCELLED'`, today),
      delivered: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'DELIVERED' AND delivered_at >= ?`, startOfLocalDayIso()),
    },
    month: {
      orders: one(`SELECT COUNT(*) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
      kg: one(`SELECT COALESCE(ROUND(SUM(weight_kg),1),0) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
      revenue: one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE month_key = ? AND payment_status = 'PAID'`, month),
      students: one(`SELECT COUNT(DISTINCT student_id) AS c FROM orders WHERE month_key = ? AND status != 'CANCELLED'`, month),
    },
    open: {
      in_progress: one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING')`),
      ready: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY'`),
      late: one(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('RECEIVED','WASHING') AND expected_at < ?`, nowIso()),
      uncollected: one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'READY' AND ready_at < ?`, new Date(Date.now() - 3 * 86400_000).toISOString()),
      dues: one(`SELECT COALESCE(SUM(amount),0) AS c FROM orders WHERE payment_status = 'DUE' AND status != 'CANCELLED'`),
      pending_students: one(`SELECT COUNT(*) AS c FROM students WHERE status = 'PENDING'`),
      complaints: one(`SELECT COUNT(*) AS c FROM complaints WHERE status != 'RESOLVED'`),
    },
    totals: {
      students: one(`SELECT COUNT(*) AS c FROM students WHERE status = 'ACTIVE'`),
      staff: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'STAFF' AND active = 1`),
    },
    days,
    hostels,
    setup: [
      { key: 'hostels', label: 'Add your hostels', done: one('SELECT COUNT(*) AS c FROM hostels WHERE active = 1') > 0 },
      { key: 'staff', label: 'Create a staff account for the counter', done: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'STAFF'`) > 0 },
      { key: 'rules', label: 'Review rules & pricing', done: one('SELECT COUNT(*) AS c FROM settings') > 0 },
      { key: 'password', label: 'Change the default admin password', done: one(`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND must_change_password = 1`) === 0 },
    ],
    upi_configured: !!s.upi_id,
    recent: db.prepare(`SELECT a.action, a.entity_id, a.detail, a.created_at, u.name AS actor_name FROM activity a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 8`).all(),
  });
}));

/* ---------------------------------------------------------------- settings */

router.get('/admin/settings', handle((_req, res) => res.json(getSettings())));
router.put('/admin/settings', handle((req, res) => res.json(saveSettings(actor(req).id, req.body))));

/* ----------------------------------------------------------------- hostels */

router.get('/admin/hostels', handle((_req, res) => {
  res.json({ rows: db.prepare(`SELECT h.id, h.name, h.active, (SELECT COUNT(*) FROM students s WHERE s.hostel_id = h.id AND s.status = 'ACTIVE') AS students FROM hostels h ORDER BY h.active DESC, h.name`).all() });
}));
router.post('/admin/hostels', handle((req, res) => {
  const b = parse(z.object({ name: zText(1, 40) }), req.body);
  if (db.prepare('SELECT 1 FROM hostels WHERE name = ?').get(b.name)) throw new HttpError(409, 'A hostel with this name already exists.');
  const id = db.prepare('INSERT INTO hostels (name) VALUES (?)').run(b.name).lastInsertRowid;
  logActivity(actor(req).id, 'HOSTEL_ADDED', 'hostel', id, b.name);
  res.status(201).json({ id });
}));
router.patch('/admin/hostels/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ name: zText(1, 40).optional(), active: z.boolean().optional() }), req.body);
  if (b.name && db.prepare('SELECT 1 FROM hostels WHERE name = ? AND id != ?').get(b.name, id)) throw new HttpError(409, 'A hostel with this name already exists.');
  db.prepare('UPDATE hostels SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?').run(b.name ?? null, b.active === undefined ? null : Number(b.active), id);
  logActivity(actor(req).id, 'HOSTEL_UPDATED', 'hostel', id, JSON.stringify(b));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------- staff */

router.get('/admin/staff', handle((_req, res) => {
  res.json({ rows: db.prepare(`SELECT u.id, u.name, u.login_id, u.mobile, u.role, u.active, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.received_by = u.id AND o.month_key = ?) AS month_received,
      (SELECT COUNT(*) FROM orders o WHERE o.delivered_by = u.id AND substr(o.delivered_at,1,7) = ?) AS month_delivered
    FROM users u WHERE u.role IN ('STAFF','ADMIN') ORDER BY u.active DESC, u.role, u.name`).all(dayKey().slice(0, 7), dayKey().slice(0, 7)) });
}));
router.post('/admin/staff', handle((req, res) => {
  const b = parse(z.object({
    name: zText(2, 80),
    loginId: z.string().transform(normaliseLogin).pipe(z.string().min(3, 'Username must be at least 3 characters').max(30).regex(/^[A-Z0-9._-]+$/, 'Username can only have letters, numbers, . _ -')),
    mobile: zMobile.or(z.literal('')).default(''),
    password: zPassword(8),
    role: z.enum(['STAFF', 'ADMIN']).default('STAFF'),
  }), req.body);
  if (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(b.loginId)) throw new HttpError(409, 'This username is taken (it may be a student ID card no.).');
  const id = db.prepare('INSERT INTO users (role, login_id, name, mobile, password_hash, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(b.role, b.loginId, b.name, b.mobile || null, bcrypt.hashSync(b.password, 10), nowIso()).lastInsertRowid;
  logActivity(actor(req).id, 'STAFF_CREATED', 'user', b.loginId, `${b.name} · ${b.role}`);
  res.status(201).json({ id });
}));
router.patch('/admin/staff/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const b = parse(z.object({ active: z.boolean().optional(), name: zText(2, 80).optional(), mobile: zMobile.or(z.literal('')).optional() }), req.body);
  const u = db.prepare(`SELECT login_id, role FROM users WHERE id = ? AND role IN ('STAFF','ADMIN')`).get(id) as { login_id: string; role: string } | undefined;
  if (!u) throw new HttpError(404, 'Staff account not found.');
  if (b.active === false && id === actor(req).id) throw new HttpError(400, 'You cannot switch off your own account.');
  if (b.active === false && u.role === 'ADMIN' && one(`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND active = 1`) <= 1) throw new HttpError(400, 'Keep at least one active admin.');
  db.prepare('UPDATE users SET active = COALESCE(?, active), name = COALESCE(?, name), mobile = COALESCE(?, mobile), token_version = token_version + CASE WHEN ? = 0 THEN 1 ELSE 0 END WHERE id = ?')
    .run(b.active === undefined ? null : Number(b.active), b.name ?? null, b.mobile === undefined ? null : b.mobile || null, b.active === false ? 0 : 1, id);
  logActivity(actor(req).id, b.active === false ? 'STAFF_DEACTIVATED' : b.active ? 'STAFF_REACTIVATED' : 'STAFF_UPDATED', 'user', u.login_id);
  res.json({ ok: true });
}));
router.post('/admin/staff/:id/reset-password', handle((req, res) => {
  const id = parse(zId, req.params.id);
  const u = db.prepare(`SELECT login_id FROM users WHERE id = ? AND role IN ('STAFF','ADMIN')`).get(id) as { login_id: string } | undefined;
  if (!u) throw new HttpError(404, 'Staff account not found.');
  const pass = `${tempPassword()}${Math.floor(Math.random() * 10)}`;   // ≥ 8 chars for staff
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(pass, 10), id);
  logActivity(actor(req).id, 'PASSWORD_RESET', 'user', u.login_id);
  res.json({ tempPassword: pass });
}));

/* ----------------------------------------------------------- announcements */

router.get('/admin/announcements', handle((_req, res) => {
  res.json({ rows: db.prepare(`SELECT a.*, h.name AS hostel_name, u.name AS created_by_name, (a.expires_on IS NOT NULL AND a.expires_on < ?) AS expired
    FROM announcements a LEFT JOIN hostels h ON h.id = a.hostel_id LEFT JOIN users u ON u.id = a.created_by WHERE a.active = 1 ORDER BY a.id DESC LIMIT 100`).all(dayKey()) });
}));
router.post('/admin/announcements', handle((req, res) => {
  const b = parse(z.object({
    title: zText(3, 80),
    body: zText(3, 600),
    hostelId: z.union([z.literal(''), z.null(), z.coerce.number().int().positive()]).optional(),
    expiresOn: z.union([z.literal(''), z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
    notify: z.boolean().default(true),
  }), req.body);
  const hostelId = b.hostelId ? Number(b.hostelId) : null;
  const id = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO announcements (title, body, hostel_id, expires_on, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(b.title, b.body, hostelId, b.expiresOn || null, actor(req).id, nowIso()).lastInsertRowid);
    if (b.notify) {
      // One INSERT…SELECT: fast even for thousands of students.
      db.prepare(`INSERT INTO notifications (user_id, title, body, created_at)
        SELECT s.user_id, ?, ?, ? FROM students s JOIN users u ON u.id = s.user_id WHERE s.status = 'ACTIVE' AND u.active = 1 ${hostelId ? 'AND s.hostel_id = ?' : ''}`)
        .run(...[`📢 ${b.title}`, b.body, nowIso(), ...(hostelId ? [hostelId] : [])]);
    }
    logActivity(actor(req).id, 'ANNOUNCEMENT_POSTED', 'announcement', id, b.title);
    return id;
  })();
  res.status(201).json({ id });
}));
router.delete('/admin/announcements/:id', handle((req, res) => {
  const id = parse(zId, req.params.id);
  db.prepare('UPDATE announcements SET active = 0 WHERE id = ?').run(id);
  logActivity(actor(req).id, 'ANNOUNCEMENT_REMOVED', 'announcement', id);
  res.status(204).end();
}));

/* ----------------------------------------------------------------- reports */

const range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick an end date'),
  status: z.string().optional(), hostel: z.string().optional(), payment: z.string().optional(),
}).refine(r => r.from <= r.to, 'Start date must be before end date');

router.get('/admin/report', handle((req, res) => {
  const r = parse(range, req.query);
  const w = `day_key BETWEEN @from AND @to`;
  const p = { from: r.from, to: r.to };
  res.json({
    totals: db.prepare(`SELECT COUNT(*) AS orders, COALESCE(ROUND(SUM(weight_kg),1),0) AS kg, COALESCE(SUM(clothes_count),0) AS clothes,
        SUM(status = 'DELIVERED') AS delivered, SUM(status = 'CANCELLED') AS cancelled, COUNT(DISTINCT student_id) AS students,
        SUM(returned_count IS NOT NULL AND returned_count != clothes_count) AS mismatches,
        COALESCE(ROUND(SUM(extra_kg),1),0) AS extra_kg, SUM(service = 'EXPRESS') AS express
      FROM orders WHERE ${w}`).get(p),
    money: db.prepare(`SELECT COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN amount END),0) AS collected,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND paid_method = 'CASH' THEN amount END),0) AS cash,
        COALESCE(SUM(CASE WHEN payment_status = 'PAID' AND paid_method = 'UPI' THEN amount END),0) AS upi,
        COALESCE(SUM(CASE WHEN payment_status = 'DUE' AND status != 'CANCELLED' THEN amount END),0) AS due,
        COALESCE(SUM(CASE WHEN payment_status = 'WAIVED' THEN amount END),0) AS waived
      FROM orders WHERE ${w}`).get(p),
    byHostel: db.prepare(`SELECT hostel_name AS name, COUNT(*) AS orders, ROUND(SUM(weight_kg),1) AS kg, SUM(clothes_count) AS clothes FROM orders WHERE ${w} AND status != 'CANCELLED' GROUP BY hostel_name ORDER BY orders DESC`).all(p),
    byStaff: db.prepare(`SELECT u.name, SUM(o.received_by = u.id) AS received, SUM(o.delivered_by = u.id) AS delivered FROM users u JOIN orders o ON (o.received_by = u.id OR o.delivered_by = u.id)
      WHERE o.${w} GROUP BY u.id ORDER BY received DESC`).all(p),
    topStudents: db.prepare(`SELECT u.name, st.id_card_no, COUNT(*) AS orders, ROUND(SUM(o.weight_kg),1) AS kg FROM orders o JOIN users u ON u.id = o.student_id JOIN students st ON st.user_id = o.student_id
      WHERE o.${w} AND o.status != 'CANCELLED' GROUP BY o.student_id ORDER BY kg DESC LIMIT 10`).all(p),
  });
}));

/** Excel export that mirrors the old paper register, one row per order. */
router.get('/admin/export', handle((req, res) => {
  const r = parse(range, req.query);
  const { rows } = listOrders({ from: r.from, to: r.to, status: r.status || undefined, hostel: r.hostel || undefined, payment: r.payment || undefined, limit: 5000 });
  if (!rows.length) throw new HttpError(404, 'No orders match these filters.');
  const t = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { timeZone: process.env.APP_TZ || 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
  const sheet = (rows as Record<string, unknown>[]).reverse().map(o => ({
    'Order No': o.order_no,
    'Date In': t(o.received_at),
    'ID Card No': o.id_card_no,
    'Name': o.student_name,
    'Mobile': o.mobile ?? '',
    'Hostel': o.hostel_name,
    'Room': o.room_no,
    'Clothes Given': o.clothes_count,
    'Weight (kg)': o.weight_kg,
    'Service': o.service,
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
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheet);
  ws['!cols'] = Object.keys(sheet[0]).map(k => ({ wch: Math.max(10, k.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Register');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  logActivity(actor(req).id, 'EXPORTED', 'report', null, `${r.from} → ${r.to} · ${rows.length} orders`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="everjoy-register-${r.from}-to-${r.to}.xlsx"`);
  res.send(buf);
}));

/* ---------------------------------------------------------- activity, backup */

router.get('/admin/activity', handle((req, res) => {
  const q = parse(z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const where = q.q ? `WHERE a.action LIKE @like OR a.entity_id LIKE @like OR a.detail LIKE @like OR u.name LIKE @like` : '';
  res.json({ rows: db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS actor_name, u.role AS actor_role
    FROM activity a LEFT JOIN users u ON u.id = a.actor_id ${where} ORDER BY a.id DESC LIMIT @limit OFFSET @offset`).all({ like: `%${q.q ?? ''}%`, limit: q.limit, offset: q.offset }) });
}));

router.get('/admin/backup', handle(async (req, res) => {
  if (isMemoryDb) throw new HttpError(400, 'Backups are not available for an in-memory database.');
  const file = path.join(os.tmpdir(), `everjoy-backup-${Date.now()}.db`);
  await db.backup(file);
  logActivity(actor(req).id, 'BACKUP_DOWNLOADED', 'system', null);
  res.download(file, `everjoy-lawndry-backup-${dayKey()}.db`, () => fs.rm(file, { force: true }, () => {}));
}));
