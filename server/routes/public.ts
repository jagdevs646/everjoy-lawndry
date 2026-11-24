import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, insertId, logActivity } from '../db.js';
import { AuthedRequest, clearLimit, clearSessionCookie, hit, limited, loadUser, overLimit, startSession, unhit } from '../auth.js';
import { getSettings } from '../rules.js';
import { studentProfile } from '../queries.js';
import { HttpError, handle, nowIso, parse, zText } from '../util.js';

export const router = Router();

export const normaliseLogin = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '');
export const zIdCard = z.string().transform(normaliseLogin).pipe(z.string().min(3, 'ID card no. looks too short').max(30, 'ID card no. looks too long').regex(/^[A-Z0-9/\-]+$/, 'ID card no. can only have letters, numbers, - and /')
  .refine(v => !v.startsWith('WALKIN-'), 'That is not a valid ID card no.'));
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

/** A real bcrypt hash of a random string: unknown IDs still cost one bcrypt compare. */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

/** Claim codes are stored as sha256; compare in constant time. Spaces and dashes don't matter. */
export const claimHash = (code: string) => crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
function claimCodeMatches(code: string, hash: string) {
  const a = Buffer.from(claimHash(code), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/auth/login', handle(async (req, res) => {
  const body = parse(z.object({ loginId: z.string().trim().min(1, 'Enter your ID card no. or username').max(64, 'That ID looks too long'), password: z.string().min(1, 'Enter your password').max(128, 'That password is too long') }), req.body);
  const loginId = normaliseLogin(body.loginId);
  const key = `login:${ip(req)}:${loginId}`;
  const ipKey = `login-ip:${ip(req)}`;              // one network guessing across many accounts (password spraying)
  const accountKey = `login-account:${loginId}`;   // per account, whatever the IP, so spoofed or rotating IPs can't guess forever
  // Only wrong passwords count, so someone typing the right password is never blocked by others' failures from elsewhere
  // for long: the account limit is high and short, the per-device limit is the tight one.
  if (overLimit(key, 8) || overLimit(ipKey, 40) || overLimit(accountKey, 25)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes, or ask the counter to reset your password.');
  // Count the attempt now (before the slow password check), so a burst of parallel requests can't all slip
  // under the limit. A correct password takes its count back below.
  const window = 15 * 60_000;
  hit(key, window); hit(ipKey, window); hit(accountKey, window);
  const u = await db.get<{ id: number; password_hash: string; active: number; token_version: number; claimable: number | null; password_expires_at: string | null }>(
    'SELECT u.id, u.password_hash, u.active, u.token_version, u.password_expires_at, st.claimable FROM users u LEFT JOIN students st ON st.user_id = u.id WHERE u.login_id = ?', [loginId]);
  // Always run bcrypt, even for unknown IDs, so the answer time doesn't reveal which IDs exist.
  const ok = await bcrypt.compare(body.password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) {
    throw new HttpError(401, u?.claimable
      ? 'Your account was added by the laundry office. Tap "Register with your ID card" and enter your ID card no., mobile number and the claim code from the office.'
      : 'Wrong ID / username or password.');
  }
  unhit(ipKey); unhit(accountKey);
  if (u.password_expires_at && u.password_expires_at < nowIso()) throw new HttpError(401, 'This temporary password has expired. Ask the counter for a new one.');
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
    hostelId: z.coerce.number().int().positive('Choose your hostel').max(2147483647),
    roomNo: zRoom,
    password: zPassword(6),
    claimCode: z.string().trim().max(40).optional().default(''),
  }), req.body);
  // Students imported from Excel by the office "claim" their account: same ID card no. and the mobile
  // number from the sheet. They choose their password; their hostel and room stay as imported.
  const imported = await db.get<{ user_id: number; mobile: string | null; token_version: number; claim_hash: string | null; claim_expires_at: string | null }>(
    'SELECT st.user_id, u.mobile, u.token_version, st.claim_hash, st.claim_expires_at FROM students st JOIN users u ON u.id = st.user_id WHERE st.id_card_no = ? AND st.claimable = 1', [b.idCardNo]);
  if (imported) {
    // ID card no. and mobile are not secret (classmates know both), so the office's one-time claim code is required too.
    const claimKey = `claim:${b.idCardNo}`;
    if (overLimit(claimKey, 8)) throw new HttpError(429, 'Too many tries. Wait an hour, or ask at the counter.');
    const codeOk = !!imported.claim_hash && !!b.claimCode && claimCodeMatches(b.claimCode, imported.claim_hash)
      && (!imported.claim_expires_at || imported.claim_expires_at >= nowIso());
    if (!codeOk || imported.mobile !== b.mobile) {
      hit(claimKey, 60 * 60_000);
      throw new HttpError(409, 'This ID card no. was added by the laundry office. Enter your mobile number and the claim code they gave you, or ask at the counter.', { code: 'CLAIM_CODE' });
    }
    await db.tx(async () => {
      await db.lockRow('users', imported.user_id);
      await db.run('UPDATE users SET password_hash = ?, password_expires_at = NULL, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(b.password, 10), imported.user_id]);
      await db.run('UPDATE students SET claimable = 0, claim_hash = NULL, claim_expires_at = NULL WHERE user_id = ?', [imported.user_id]);
      await logActivity(imported.user_id, 'STUDENT_CLAIMED', 'student', b.idCardNo, 'Set password for an imported account');
    });
    const token = startSession(req, res, imported.user_id, imported.token_version + 1);
    return res.status(200).json({ user: await loadUser(imported.user_id), token, claimed: true });
  }
  if (!await db.get('SELECT 1 AS ok FROM hostels WHERE id = ? AND active = 1', [b.hostelId])) throw new HttpError(400, 'Choose your hostel.');
  if (await db.get('SELECT 1 AS ok FROM users WHERE login_id = ?', [b.idCardNo])) throw new HttpError(409, ALREADY_REGISTERED);
  const passwordHash = await bcrypt.hash(b.password, 10);
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

/** Sign out. The session token is cancelled on the server too, so a copied token stops working (this signs the account out everywhere). */
router.post('/auth/logout', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (user) await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [user.id]);
  clearSessionCookie(res);
  res.status(204).end();
}));

router.get('/auth/me', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) return res.json({ user: null });
  res.json({ user, profile: user.role === 'STUDENT' ? await studentProfile(user.id) : await db.get('SELECT id, name, mobile, login_id, role FROM users WHERE id = ?', [user.id]) });
}));

router.post('/auth/password', handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const b = parse(z.object({ current: z.string().min(1, 'Enter your current password'), next: zPassword(user.role === 'STUDENT' ? 6 : 8) }), req.body);
  const pwKey = `pwchange:${user.id}`;
  if (overLimit(pwKey, 5)) throw new HttpError(429, 'Too many wrong attempts. Wait 15 minutes.');
  hit(pwKey, 15 * 60_000);   // counted before bcrypt; cleared after a successful change
  const tokenVersion = await db.tx(async () => {
    await db.lockRow('users', user.id);   // two password changes at once must not hand out the same token version
    const u = (await db.get<{ password_hash: string; token_version: number }>('SELECT password_hash, token_version FROM users WHERE id = ?', [user.id]))!;
    if (!(await bcrypt.compare(b.current, u.password_hash))) throw new HttpError(400, 'Current password is wrong.');
    if (b.current === b.next) throw new HttpError(400, 'Choose a new password that is different from the current one.');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_expires_at = NULL, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(b.next, 10), user.id]);
    await logActivity(user.id, 'PASSWORD_CHANGED', 'user', user.login_id);
    return u.token_version + 1;
  });
  clearLimit(pwKey);
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
