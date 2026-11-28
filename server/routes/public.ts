import crypto from 'node:crypto';
import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, insertId, logActivity } from '../db.js';
import { AuthedRequest, clearLimit, clearSessionCookie, hit, isTrustedDevice, limited, loadUser, overLimit, startSession, trustDevice, unhit } from '../auth.js';
import { checkStudentEmail, resendChallenge, startChallenge, studentOtpOn, useChallenge } from '../otp.js';
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
    // Registration asks for the university email when sign-in codes are on.
    email_codes: await studentOtpOn(),
    email_domain: s.student_email_domain,
    dropoff_from: s.dropoff_from, dropoff_to: s.dropoff_to, pickup_from: s.pickup_from, pickup_to: s.pickup_to,
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

/** Start a session after sign-in or a confirmed code. Students who typed a code also get this device trusted. */
async function signedIn(req: Request, res: Response, userId: number, tokenVersion: number, opts: { trust?: boolean; status?: number; extra?: object } = {}) {
  const token = startSession(req, res, userId, tokenVersion);
  const deviceToken = opts.trust ? trustDevice(req, res, userId, tokenVersion) : undefined;
  res.status(opts.status ?? 200).json({ user: await loadUser(userId), token, ...(deviceToken ? { deviceToken } : {}), ...(opts.extra ?? {}) });
}

/**
 * Limit how often codes are emailed from one network (the per-inbox limit and daily cap live in otp.ts).
 * A whole campus may share one Wi-Fi address, so sign-in codes get a generous limit; registration codes,
 * which can be sent to any address typed in, get a tighter one.
 */
function codeSendLimit(req: Request, kind: 'login' | 'signup') {
  const key = `otp-${kind}-ip:${ip(req)}`;
  if (overLimit(key, kind === 'login' ? 200 : 120)) throw new HttpError(429, 'Too many codes asked for from this network. Wait 15 minutes, or ask at the counter.');
  hit(key, 15 * 60_000);
}

router.post('/auth/login', handle(async (req, res) => {
  const body = parse(z.object({ loginId: z.string().trim().min(1, 'Enter your ID card no. or username').max(64, 'That ID looks too long'), password: z.string().min(1, 'Enter your password').max(128, 'That password is too long') }), req.body);
  const loginId = normaliseLogin(body.loginId);
  const key = `login:${ip(req)}:${loginId}`;
  const ipKey = `login-ip:${ip(req)}`;              // one network guessing across many accounts (password spraying)
  const accountKey = `login-account:${loginId}`;   // per account, whatever the IP, so spoofed or rotating IPs can't guess forever
  if (overLimit(key, 8) || overLimit(ipKey, 40) || overLimit(accountKey, 25)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes, or ask the counter to reset your password.');
  // Count the attempt now (before the slow password check), so a burst of parallel requests can't all slip
  // under the limit. A correct password takes its count back below.
  const window = 15 * 60_000;
  hit(key, window); hit(ipKey, window); hit(accountKey, window);
  const u = await db.get<{ id: number; role: string; password_hash: string; active: number; token_version: number; claimable: number | null; password_expires_at: string | null; email: string | null }>(
    'SELECT u.id, u.role, u.password_hash, u.active, u.token_version, u.password_expires_at, st.claimable, st.email FROM users u LEFT JOIN students st ON st.user_id = u.id WHERE u.login_id = ?', [loginId]);
  // Always run bcrypt, even for unknown IDs, so the answer time doesn't reveal which IDs exist.
  const ok = await bcrypt.compare(body.password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) {
    throw new HttpError(401, u?.claimable
      ? 'Your account was added by the laundry office. Choose "Have a claim code?" to set it up.'
      : 'Wrong ID / username or password.');
  }
  unhit(ipKey); unhit(accountKey);
  if (u.password_expires_at && u.password_expires_at < nowIso()) throw new HttpError(401, 'This temporary password has expired. Ask the counter for a new one.');
  if (!u.active) throw new HttpError(403, 'This account is switched off. Please contact the laundry counter.');
  clearLimit(key);
  clearLimit(accountKey);
  // A student on a phone or browser that hasn't confirmed a code yet: email a code first.
  if (u.role === 'STUDENT' && u.email && await studentOtpOn() && !isTrustedDevice(req, u.id, u.token_version)) {
    codeSendLimit(req, 'login');
    return res.json(await startChallenge('LOGIN', u.email, u.id, { v: u.token_version }));
  }
  await signedIn(req, res, u.id, u.token_version);
}));

const claimError = 'Check the ID and code, or ask at the counter.';
const ticketDigest = (ticket: string) => crypto.createHash('sha256').update(ticket).digest('hex');

router.post('/auth/claim', handle(async (req, res) => {
  const b = parse(z.object({ identifier: z.string().trim().min(1).max(120), code: z.string().max(40) }), req.body);
  if (limited(`claim-ip:${ip(req)}`, 120, 3600000)) throw new HttpError(429, 'Too many tries. Wait an hour.');
  const st = await db.get<{ user_id: number; id_card_no: string; claim_hash: string; claim_expires_at: string }>(
    `SELECT st.user_id, st.id_card_no, st.claim_hash, st.claim_expires_at FROM students st JOIN users u ON u.id = st.user_id
     WHERE st.claimable = 1 AND st.left_at IS NULL AND u.active = 1 AND (st.id_card_no = ? OR lower(st.email) = ?)`,
    [normaliseLogin(b.identifier), b.identifier.toLowerCase()]);
  if (limited(`claim:${st?.id_card_no ?? normaliseLogin(b.identifier)}`, 6, 3600000)) throw new HttpError(429, 'Too many tries. Wait an hour.');
  const matches = claimCodeMatches(b.code, st?.claim_hash ?? '0'.repeat(64));
  if (!matches || !st || !st.claim_expires_at || st.claim_expires_at < nowIso()) throw new HttpError(400, claimError);
  const ticket = crypto.randomBytes(32).toString('hex');
  const updated = await db.run('UPDATE students SET claim_ticket_hash = ?, claim_ticket_until = ? WHERE user_id = ? AND claimable = 1 AND claim_hash = ?',
    [ticketDigest(ticket), new Date(Date.now() + 12 * 60000).toISOString(), st.user_id, st.claim_hash]);
  if (!updated.changes) throw new HttpError(400, claimError);
  res.json({ ticket });
}));

router.post('/auth/claim/password', handle(async (req, res) => {
  const b = parse(z.object({ ticket: z.string().length(64), password: zPassword(6) }), req.body);
  const hash = ticketDigest(b.ticket);
  const st = await db.get<{ user_id: number; id_card_no: string }>('SELECT user_id, id_card_no FROM students WHERE claim_ticket_hash = ? AND claim_ticket_until >= ?', [hash, nowIso()]);
  if (!st) throw new HttpError(400, claimError);
  const version = await claimAccount(st.user_id, await bcrypt.hash(b.password, 10), st.id_card_no, false, hash);
  await signedIn(req, res, st.user_id, version, { trust: true, extra: { claimed: true } });
}));

const zEmail = z.string().trim().toLowerCase().max(120).email('Enter your university email address');

router.post('/auth/signup', handle(async (req, res) => {
  // Generous: a whole campus can share one Wi-Fi IP during orientation week. Staff approval is the real gate.
  if (limited(`signup:${ip(req)}`, 120, 10 * 60_000)) throw new HttpError(429, 'Too many sign-ups from this network right now. Try again in a few minutes.');
  const b = parse(z.object({
    idCardNo: zIdCard,
    name: zText(2, 80),
    mobile: zMobile,
    email: z.union([z.literal(''), zEmail]).optional().default(''),
    hostelId: z.coerce.number().int().positive('Choose your hostel').max(2147483647),
    roomNo: zRoom,
    password: zPassword(6),
    selfRegistration: z.boolean().optional(),
    claimCode: z.string().trim().max(40).optional().default(''),
  }), req.body);
  const otp = await studentOtpOn();

  // Students imported from Excel by the office "claim" their account. With a university email on file
  // they confirm a code sent there; otherwise they need the one-time claim code the office handed out.
  const imported = await db.get<{ user_id: number; mobile: string | null; token_version: number; claim_hash: string | null; claim_expires_at: string | null; email: string | null }>(
    'SELECT st.user_id, u.mobile, u.token_version, st.claim_hash, st.claim_expires_at, st.email FROM students st JOIN users u ON u.id = st.user_id WHERE st.id_card_no = ? AND st.claimable = 1', [b.idCardNo]);
  if (imported) {
    if (b.selfRegistration) throw new HttpError(409, 'Open “Have a claim code?” to activate your office account.', { code: 'CLAIM_CODE' });
    const claimKey = `claim:${b.idCardNo}`;
    if (overLimit(claimKey, 6)) throw new HttpError(429, 'Too many tries. Wait an hour, or ask at the counter.');
    hit(claimKey, 60 * 60_000);   // every attempt counts, right or wrong
    // With an email on file and codes on, the emailed code is used (unless the student typed the office's claim code).
    if (imported.email && otp && !b.claimCode) {
      if (imported.mobile !== b.mobile) throw new HttpError(409, 'This ID card no. was added by the laundry office with a different mobile number. Check it, or ask at the counter.', { code: 'CLAIM_MOBILE' });
      codeSendLimit(req, 'login');
      return res.status(202).json(await startChallenge('CLAIM', imported.email, imported.user_id, { passwordHash: await bcrypt.hash(b.password, 10), v: imported.token_version }));
    }
    if (!imported.claim_hash) {
      throw new HttpError(409, 'Email codes are off right now and the office has no claim code for you. Ask at the counter to set up your account.', { code: 'CLAIM_COUNTER' });
    }
    const codeOk = !!imported.claim_hash && !!b.claimCode && claimCodeMatches(b.claimCode, imported.claim_hash)
      && (!imported.claim_expires_at || imported.claim_expires_at >= nowIso());
    if (!codeOk || imported.mobile !== b.mobile) {
      throw new HttpError(409, 'This ID card no. was added by the laundry office. Enter your mobile number and the claim code they gave you, or ask at the counter.', { code: 'CLAIM_CODE' });
    }
    const version = await claimAccount(imported.user_id, await bcrypt.hash(b.password, 10), b.idCardNo, false, undefined, imported.claim_hash!);
    return signedIn(req, res, imported.user_id, version, { trust: true, extra: { claimed: true } });
  }

  if (!await db.get('SELECT 1 AS ok FROM hostels WHERE id = ? AND active = 1', [b.hostelId])) throw new HttpError(400, 'Choose your hostel.');
  if (await db.get('SELECT 1 AS ok FROM users WHERE login_id = ?', [b.idCardNo])) throw new HttpError(409, ALREADY_REGISTERED);
  if (otp && !b.email) throw new HttpError(400, 'Enter your university email. Your sign-in codes are sent there.');
  if (b.email) {
    await checkStudentEmail(b.email);
    if (await db.get('SELECT 1 AS ok FROM students WHERE lower(email) = ?', [b.email])) throw new HttpError(409, 'This email is already used by another account. Ask at the counter if it is yours.');
  }
  const passwordHash = await bcrypt.hash(b.password, 10);
  const details = { idCardNo: b.idCardNo, name: b.name, mobile: b.mobile, email: b.email, hostelId: b.hostelId, roomNo: b.roomNo, passwordHash };
  if (otp) {
    // The account is created only after the student types the code from that email.
    codeSendLimit(req, 'signup');
    return res.status(202).json(await startChallenge('SIGNUP', b.email, null, details));
  }
  const id = await createStudent(details, false);
  await signedIn(req, res, id, 0, { status: 201 });
}));

type NewStudent = { idCardNo: string; name: string; mobile: string; email: string; hostelId: number; roomNo: string; passwordHash: string };
async function createStudent(d: NewStudent, emailVerified: boolean) {
  if (await db.get('SELECT 1 AS ok FROM users WHERE login_id = ?', [d.idCardNo])) throw new HttpError(409, ALREADY_REGISTERED);
  try {
    return await db.tx(async () => {
      const userId = await insertId(`INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES ('STUDENT',?,?,?,?,?)`,
        [d.idCardNo, d.name, d.mobile, d.passwordHash, nowIso()]);
      await db.run('INSERT INTO students (user_id, id_card_no, hostel_id, room_no, email, email_verified_at) VALUES (?,?,?,?,?,?)',
        [userId, d.idCardNo, d.hostelId, d.roomNo, d.email || null, emailVerified ? nowIso() : null]);
      await logActivity(userId, 'STUDENT_SIGNUP', 'student', d.idCardNo, `${d.name} · room ${d.roomNo}`);
      return userId;
    });
  } catch (e) {
    // Two sign-ups with the same ID card (or email) at the same moment: the second one loses at a UNIQUE constraint.
    if (isUniqueViolation(e)) throw new HttpError(409, 'This ID card no. or email is already registered. Sign in instead, or ask at the counter.');
    throw e;
  }
}

/** Set the password of an imported account and open it. Returns the new token version. */
async function claimAccount(userId: number, passwordHash: string, idCardNo: string, emailVerified: boolean, ticketHash?: string, expectedCodeHash?: string) {
  return db.tx(async () => {
    await db.lockRow('users', userId);
    const st = await db.get<{ claimable: number; claim_ticket_hash: string; claim_ticket_until: string; claim_expires_at: string; claim_hash: string }>(
      'SELECT st.claimable, st.claim_ticket_hash, st.claim_ticket_until, st.claim_expires_at, st.claim_hash FROM students st JOIN users u ON u.id = st.user_id WHERE u.active = 1 AND st.left_at IS NULL AND st.user_id = ?', [userId]);
    if (ticketHash && (!st || st.claim_ticket_hash !== ticketHash || st.claim_ticket_until < nowIso() || st.claim_expires_at < nowIso())) throw new HttpError(400, claimError);
    if (expectedCodeHash && st?.claim_hash !== expectedCodeHash) throw new HttpError(400, claimError);
    if (!st?.claimable) throw new HttpError(409, 'This account is already set up. Sign in instead, or ask the counter to reset your password.');
    await db.run('UPDATE users SET password_hash = ?, password_expires_at = NULL, token_version = token_version + 1 WHERE id = ?', [passwordHash, userId]);
    const profile = ticketHash ? await studentProfile(userId) : null;
    const incomplete = profile && (!profile.mobile || !profile.photo || (!profile.email && await studentOtpOn()));
    await db.run(`UPDATE students SET claimed_at = ?, complete_profile = ?, claim_ticket_hash = NULL, claim_ticket_until = NULL, claimable = 0, claim_hash = NULL, claim_expires_at = NULL${emailVerified ? ', email_verified_at = ?' : ''} WHERE user_id = ?`, [nowIso(), incomplete ? 1 : 0, ...(emailVerified ? [nowIso()] : []), userId]);
    await logActivity(userId, 'STUDENT_CLAIMED', 'student', idCardNo, emailVerified ? 'Set up with a code from the university email' : 'Set up with the office claim code');
    return (await db.get<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', [userId]))!.token_version;
  });
}

/**
 * Forgot password (students with a university email on file): a code is emailed; with it they choose a
 * new password. Staff and students without an email ask at the counter, where any account can be reset.
 */
router.post('/auth/forgot', handle(async (req, res) => {
  const b = parse(z.object({ loginId: z.string().trim().min(1, 'Enter your ID card no.').max(64) }), req.body);
  if (!(await studentOtpOn())) throw new HttpError(409, 'Ask at the laundry counter. Staff can reset your password.', { code: 'ASK_COUNTER' });
  const u = await db.get<{ id: number; token_version: number; email: string | null; active: number }>(
    `SELECT u.id, u.token_version, u.active, st.email FROM users u JOIN students st ON st.user_id = u.id WHERE u.login_id = ? AND st.claimable = 0 AND st.left_at IS NULL`, [normaliseLogin(b.loginId)]);
  if (!u || !u.email || !u.active) throw new HttpError(404, 'No account with a university email for this ID card no. Ask at the laundry counter to reset your password.');
  codeSendLimit(req, 'login');
  res.json(await startChallenge('RESET', u.email, u.id, { v: u.token_version }));
}));

/** The student typed the code from their email. */
router.post('/auth/otp', handle(async (req, res) => {
  const b = parse(z.object({ challenge: z.string().min(10).max(80), code: z.string().trim().min(4).max(12), newPassword: zPassword(6).optional() }), req.body);
  // Each code allows only 5 tries; this per-network cap only slows mass guessing (campus Wi-Fi is shared, so it is generous).
  if (limited(`otp-check:${ip(req)}`, 300, 15 * 60_000)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const c = await useChallenge(b.challenge, b.code, b.newPassword === undefined ? ['RESET'] : []);
  if (c.purpose === 'SIGNUP') {
    const id = await createStudent(c.payload as unknown as NewStudent, true);
    return signedIn(req, res, id, 0, { status: 201, trust: true });
  }
  const u = await db.get<{ id: number; active: number; token_version: number; login_id: string }>('SELECT id, active, token_version, login_id FROM users WHERE id = ?', [c.user_id]);
  if (!u || !u.active) throw new HttpError(403, 'This account is switched off. Please contact the laundry counter.');
  // A code sent before a password reset, email change or sign-out-everywhere no longer counts.
  const v = (c.payload as { v?: number } | null)?.v;
  if (v !== undefined && v !== u.token_version) throw new HttpError(410, 'This code is no longer valid. Start again.');
  if (c.purpose === 'RESET') {
    if (!b.newPassword) throw new HttpError(400, 'Choose a new password.');
    const hash = await bcrypt.hash(b.newPassword, 10);
    const version = await db.tx(async () => {
      await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_expires_at = NULL, token_version = token_version + 1 WHERE id = ?', [hash, u.id]);
      await logActivity(u.id, 'PASSWORD_RESET_BY_EMAIL', 'student', u.login_id);
      return (await db.get<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', [u.id]))!.token_version;
    });
    return signedIn(req, res, u.id, version, { trust: true });
  }
  if (c.purpose === 'EMAIL') {
    const email = String((c.payload as { email: string }).email);
    if (await db.get('SELECT 1 AS ok FROM students WHERE lower(email) = ? AND user_id != ?', [email, u.id])) throw new HttpError(409, 'This email is already used by another account.');
    const r = await db.run('UPDATE students SET email = ?, email_verified_at = ? WHERE user_id = ? AND email IS NULL', [email, nowIso(), u.id]);
    if (r.changes !== 1) throw new HttpError(409, 'An email is already on your account. Ask at the counter to change it.');
    await logActivity(u.id, 'EMAIL_ADDED', 'student', u.login_id, email);
    return signedIn(req, res, u.id, u.token_version, { trust: true });
  }
  if (c.purpose === 'CLAIM') {
    const version = await claimAccount(u.id, String((c.payload as { passwordHash: string }).passwordHash), u.login_id, true);
    return signedIn(req, res, u.id, version, { trust: true, extra: { claimed: true } });
  }
  // LOGIN: confirming the code also confirms the email address.
  await db.run('UPDATE students SET email_verified_at = COALESCE(email_verified_at, ?) WHERE user_id = ?', [nowIso(), u.id]);
  await signedIn(req, res, u.id, u.token_version, { trust: true });
}));

router.post('/auth/otp/resend', handle(async (req, res) => {
  const b = parse(z.object({ challenge: z.string().min(10).max(80) }), req.body);
  if (limited(`otp-resend:${ip(req)}`, 20, 15 * 60_000)) throw new HttpError(429, 'Too many codes asked for. Wait 15 minutes.');
  res.json(await resendChallenge(b.challenge));
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
