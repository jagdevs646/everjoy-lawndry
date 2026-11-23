import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, insertId, logActivity } from '../db.js';
import { AuthedRequest, clearLimit, clearSessionCookie, limited, loadUser, startSession } from '../auth.js';
import { getSettings } from '../rules.js';
import { studentProfile } from '../queries.js';
import { HttpError, handle, nowIso, parse, zText } from '../util.js';

export const router = Router();

export const normaliseLogin = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '');
export const zIdCard = z.string().transform(normaliseLogin).pipe(z.string().min(3, 'ID card no. looks too short').max(30, 'ID card no. looks too long').regex(/^[A-Z0-9/\-]+$/, 'ID card no. can only have letters, numbers, - and /'));
export const zMobile = z.string().transform(v => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '')).pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'));
export const zRoom = z.string().trim().toUpperCase().min(1, 'Enter your room no.').max(12, 'Room no. is too long');
export const zPassword = (min: number) => z.string().min(min, `Password must be at least ${min} characters`).max(100);

const ip = (req: { ip?: string; socket: { remoteAddress?: string } }) => req.ip || req.socket.remoteAddress || 'unknown';

/** A UNIQUE constraint failed (Postgres 23505, or SQLite). */
const isUniqueViolation = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE';
};

const ALREADY_REGISTERED = 'This ID card no. is already registered. Sign in instead, or ask the counter to reset your password.';

router.get('/public/info', handle(async (_req, res) => {
  const s = await getSettings();
  res.json({
    hostels: await db.all('SELECT id, name FROM hostels WHERE active = 1 ORDER BY name'),
    max_kg_per_order: s.max_kg_per_order,
    counter_hours: s.counter_hours,
  });
}));

router.post('/auth/login', handle(async (req, res) => {
  const body = parse(z.object({ loginId: z.string().min(1, 'Enter your ID card no. or username'), password: z.string().min(1, 'Enter your password') }), req.body);
  const loginId = normaliseLogin(body.loginId);
  const key = `login:${ip(req)}:${loginId}`;
  const accountKey = `login-account:${loginId}`;   // per account, whatever the IP, so spoofed or rotating IPs can't guess forever
  if (limited(key, 8, 15 * 60_000) || limited(accountKey, 25, 15 * 60_000)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes, or ask the counter to reset your password.');
  const u = await db.get<{ id: number; password_hash: string; active: number; token_version: number }>(
    'SELECT id, password_hash, active, token_version FROM users WHERE login_id = ?', [loginId]);
  if (!u || !bcrypt.compareSync(body.password, u.password_hash)) throw new HttpError(401, 'Wrong ID / username or password.');
  if (!u.active) throw new HttpError(403, 'This account is switched off. Please contact the laundry counter.');
  clearLimit(key);
  clearLimit(accountKey);
  const token = startSession(req, res, u.id, u.token_version);
  res.json({ user: await loadUser(u.id), token });
}));

router.post('/auth/signup', handle(async (req, res) => {
  // Generous: a whole campus can share one Wi-Fi IP during orientation week. Staff approval is the real gate.
  if (limited(`signup:${ip(req)}`, 120, 10 * 60_000)) throw new HttpError(429, 'Too many sign-ups from this network right now. Try again in a few minutes.');
  const b = parse(z.object({
    idCardNo: zIdCard,
    name: zText(2, 80),
    mobile: zMobile,
    hostelId: z.coerce.number().int().positive('Choose your hostel'),
    roomNo: zRoom,
    password: zPassword(6),
  }), req.body);
  if (!await db.get('SELECT 1 AS ok FROM hostels WHERE id = ? AND active = 1', [b.hostelId])) throw new HttpError(400, 'Choose your hostel.');
  if (await db.get('SELECT 1 AS ok FROM users WHERE login_id = ?', [b.idCardNo])) throw new HttpError(409, ALREADY_REGISTERED);
  const passwordHash = bcrypt.hashSync(b.password, 10);
  let id: number;
  try {
    id = await db.tx(async () => {
      const userId = await insertId(`INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES ('STUDENT',?,?,?,?,?)`,
        [b.idCardNo, b.name, b.mobile, passwordHash, nowIso()]);
      await db.run('INSERT INTO students (user_id, id_card_no, hostel_id, room_no) VALUES (?,?,?,?)', [userId, b.idCardNo, b.hostelId, b.roomNo]);
      await logActivity(userId, 'STUDENT_SIGNUP', 'student', b.idCardNo, `${b.name} · room ${b.roomNo}`);
      return userId;
    });
  } catch (e) {
    // Two sign-ups with the same ID card at the same moment: the second one loses at the UNIQUE constraint.
    if (isUniqueViolation(e)) throw new HttpError(409, ALREADY_REGISTERED);
    throw e;
  }
  const token = startSession(req, res, id, 0);
  res.status(201).json({ user: await loadUser(id), token });
}));

router.post('/auth/logout', handle((_req, res) => { clearSessionCookie(res); res.status(204).end(); }));

router.get('/auth/me', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) return res.json({ user: null });
  res.json({ user, profile: user.role === 'STUDENT' ? await studentProfile(user.id) : await db.get('SELECT id, name, mobile, login_id, role FROM users WHERE id = ?', [user.id]) });
}));

router.post('/auth/password', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const b = parse(z.object({ current: z.string().min(1, 'Enter your current password'), next: zPassword(user.role === 'STUDENT' ? 6 : 8) }), req.body);
  const tokenVersion = await db.tx(async () => {
    await db.lockRow('users', user.id);   // two password changes at once must not hand out the same token version
    const u = (await db.get<{ password_hash: string; token_version: number }>('SELECT password_hash, token_version FROM users WHERE id = ?', [user.id]))!;
    if (!bcrypt.compareSync(b.current, u.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    if (b.current === b.next) throw new HttpError(400, 'Choose a new password that is different from the current one.');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [bcrypt.hashSync(b.next, 10), user.id]);
    await logActivity(user.id, 'PASSWORD_CHANGED', 'user', user.login_id);
    return u.token_version + 1;
  });
  const token = startSession(req, res, user.id, tokenVersion);  // keep this device signed in, sign out the others
  res.json({ user: await loadUser(user.id), token });
}));

router.get('/notifications', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const rows = await db.all('SELECT id, title, body, order_id, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [user.id]);
  const unread = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]))!.c;
  res.json({ rows, unread });
}));

router.post('/notifications/read', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), user.id]);
  res.status(204).end();
}));
