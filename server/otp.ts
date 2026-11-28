import { workspaceId } from './workspace-context.js';
/*
 * Email sign-in codes for students.
 *
 * A "challenge" is one pending step that needs the 6-digit code from the student's university email:
 *   LOGIN   password was right, this phone/browser isn't trusted yet
 *   CLAIM   an account imported by the office is being set up (password chosen, waiting for the code)
 *   SIGNUP  a new registration, created only after the email is confirmed
 * The code is stored hashed, expires in 10 minutes and allows 5 tries. The challenge id is a random
 * token the client holds; it is useless without the emailed code.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError, nowIso } from './util.js';
import { maskEmail, mailUsable, sendMail } from './mail.js';
import { getSettings } from './rules.js';
import { hit, overLimit } from './auth.js';

/** Codes that are not for signing in (registration, account set-up, adding an email) may use at most this many emails a day. */
const DAILY_OTHER_CAP = Number(process.env.MAIL_DAILY_CAP_OTHER || 150);
/** After this many wrong codes for one address, no codes for an hour. */
const LOCK_AFTER = 10;

/** Same inbox, different spellings: ignore case, "+tags" and Gmail dots for limits. */
export function inboxKey(email: string) {
  const [user = '', domain = ''] = email.toLowerCase().split('@');
  const base = user.split('+')[0];
  return `${domain === 'gmail.com' || domain === 'googlemail.com' ? base.replace(/\./g, '') : base}@${domain}`;
}

async function checkSendAllowed(email: string, purpose: Purpose) {
  const key = inboxKey(email);
  const lock = await db.get<{ locked_until: string | null }>('SELECT locked_until FROM otp_failures WHERE email = ?', [key]);
  if (lock?.locked_until && lock.locked_until > nowIso()) throw new HttpError(429, 'Too many wrong codes for this email. Try again in an hour, or ask at the counter.');
  // Per inbox, counting resends too: protects people's inboxes from being flooded.
  if (overLimit(`otp-mail:${key}`, 6)) throw new HttpError(429, 'Too many codes sent to this email. Wait 15 minutes, or ask at the counter.');
  if (purpose !== 'LOGIN') {
    const day = nowIso().slice(0, 10);
    const used = await db.get<{ n: number }>("SELECT n FROM mail_counts WHERE day = ? AND kind = 'OTHER'", [day]);
    if (Number(used?.n ?? 0) >= DAILY_OTHER_CAP) throw new HttpError(503, 'Too many registration emails today. Try again tomorrow, or ask at the counter.', { code: 'OTP_UNAVAILABLE' });
  }
}

async function countSend(email: string, purpose: Purpose) {
  hit(`otp-mail:${inboxKey(email)}`, 15 * 60_000);
  await db.run('INSERT INTO mail_counts (day, kind, n) VALUES (?,?,1) ON CONFLICT(day, kind) DO UPDATE SET n = mail_counts.n + 1',
    [nowIso().slice(0, 10), purpose === 'LOGIN' ? 'LOGIN' : 'OTHER']);
}

export type Purpose = 'LOGIN' | 'CLAIM' | 'SIGNUP' | 'EMAIL' | 'RESET';
type Challenge = { id: string; purpose: Purpose; user_id: number | null; email: string; code_hash: string; payload: string | null; attempts: number; sends: number; last_sent_at: string; expires_at: string };

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 4;
const RESEND_AFTER_MS = 30_000;

const hash = (id: string, code: string) => crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Students must confirm new devices with an email code (setting on, email can be sent). */
export async function studentOtpOn() {
  return (await getSettings()).student_email_otp && mailUsable();
}

/** Is this a valid university email under the admin's domain rule (if any)? */
export async function checkStudentEmail(email: string) {
  const domain = (await getSettings()).student_email_domain.trim().toLowerCase().replace(/^@/, '');
  if (!domain) return;
  const at = email.toLowerCase().split('@')[1] ?? '';
  if (at !== domain && !at.endsWith(`.${domain}`)) throw new HttpError(400, `Use your university email (ending in @${domain}).`);
}

async function deliver(email: string, code: string, purpose: Purpose) {
  const what = purpose === 'LOGIN' ? 'sign in on a new phone or browser' : purpose === 'CLAIM' ? 'set up your laundry account' : purpose === 'EMAIL' ? 'add this email to your laundry account' : purpose === 'RESET' ? 'choose a new password for your laundry account' : 'confirm your email for the laundry account';
  await sendMail({
    to: email,
    subject: `${code} is your Everjoy Lawndry code`,
    text: `Your code to ${what} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without it.\n\nEverjoy Lawndry`,
    html: `<p>Your code to ${what} is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without it.</p><p>Everjoy Lawndry</p>`,
  });
}

/** Start a challenge and email its code. Returns what the client needs to show the code screen. */
export async function startChallenge(purpose: Purpose, email: string, userId: number | null, payload?: unknown) {
  await checkSendAllowed(email, purpose);
  const id = crypto.randomBytes(24).toString('base64url');
  const code = newCode();
  const at = nowIso();
  // Old challenges are useless after expiry; keep the table small.
  await db.run(`DELETE FROM login_challenges WHERE workspace_id = ${workspaceId()} AND (expires_at < ?)`, [new Date(Date.now() - 86400_000).toISOString()]);
  await db.run(`INSERT INTO login_challenges (workspace_id, id, purpose, user_id, email, code_hash, payload, attempts, sends, last_sent_at, expires_at, created_at)
    VALUES (${workspaceId()}, ?,?,?,?,?,?,0,1,?,?,?)`, [id, purpose, userId, email, hash(id, code), payload === undefined ? null : JSON.stringify(payload), at, new Date(Date.now() + CODE_TTL_MS).toISOString(), at]);
  try {
    await deliver(email, code, purpose);
  } catch {
    await db.run(`DELETE FROM login_challenges WHERE workspace_id = ${workspaceId()} AND (id = ?)`, [id]);
    throw new HttpError(503, 'Could not send the email code right now. Try again in a minute, or ask at the counter.', { code: 'OTP_UNAVAILABLE' });
  }
  await countSend(email, purpose);
  return { otp_required: true as const, challenge: id, email_hint: maskEmail(email), purpose };
}

/** Send a fresh code for the same challenge (limited). */
export async function resendChallenge(id: string) {
  const c = await db.get<Challenge>('SELECT * FROM login_challenges WHERE id = ?', [id]);
  if (!c || c.expires_at < nowIso()) throw new HttpError(410, 'This code has expired. Start again.');
  if (c.sends >= MAX_SENDS) throw new HttpError(429, 'Too many codes sent. Start again in a few minutes.');
  if (Date.now() - Date.parse(c.last_sent_at) < RESEND_AFTER_MS) throw new HttpError(429, 'Wait 30 seconds before asking for another code.');
  await checkSendAllowed(c.email, c.purpose);
  const code = newCode();
  // The 5 tries cover the whole challenge: a new code does not give new tries.
  await db.run(`UPDATE login_challenges SET code_hash = ?, sends = sends + 1, last_sent_at = ?, expires_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`,
    [hash(id, code), nowIso(), new Date(Date.now() + CODE_TTL_MS).toISOString(), id]);
  try { await deliver(c.email, code, c.purpose); } catch { throw new HttpError(503, 'Could not send the email code right now. Try again in a minute.', { code: 'OTP_UNAVAILABLE' }); }
  await countSend(c.email, c.purpose);
  return { otp_required: true as const, challenge: id, email_hint: maskEmail(c.email), purpose: c.purpose };
}

/**
 * Check a code. A right code uses the challenge up (it can't be used twice); a wrong one counts
 * toward the 5 tries. Returns the challenge with its payload.
 */
export async function useChallenge(id: string, code: string, needsMore: Purpose[] = []) {
  const c = await db.get<Challenge>('SELECT * FROM login_challenges WHERE id = ?', [id]);
  if (!c || c.expires_at < nowIso()) throw new HttpError(410, 'This code has expired. Start again.');
  // e.g. a password reset needs the new password with the code; don't use the code up without it.
  if (needsMore.includes(c.purpose)) throw new HttpError(400, 'Choose a new password.');
  if (c.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Start again.');
  const want = Buffer.from(c.code_hash, 'hex');
  const got = Buffer.from(hash(id, code.replace(/\D/g, '')), 'hex');
  if (!crypto.timingSafeEqual(want, got)) {
    // Counted with a single atomic update, so parallel guesses can't share one "try".
    await db.run(`UPDATE login_challenges SET attempts = attempts + 1 WHERE workspace_id = ${workspaceId()} AND (id = ?)`, [id]);
    // And per inbox across challenges: 10 wrong codes lock this email out of new codes for an hour.
    const key = inboxKey(c.email);
    await db.run(`INSERT INTO otp_failures (email, failures, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(email) DO UPDATE SET failures = otp_failures.failures + 1, updated_at = excluded.updated_at`, [key, nowIso()]);
    await db.run('UPDATE otp_failures SET locked_until = ?, failures = 0 WHERE email = ? AND failures >= ?', [new Date(Date.now() + 3600_000).toISOString(), key, LOCK_AFTER]);
    const left = MAX_ATTEMPTS - c.attempts - 1;
    throw new HttpError(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Start again.');
  }
  // Single use: only the request that actually deletes the row (with this code and tries left) goes on.
  const r = await db.run(`DELETE FROM login_challenges WHERE workspace_id = ${workspaceId()} AND (id = ? AND code_hash = ? AND attempts < ?)`, [id, c.code_hash, MAX_ATTEMPTS]);
  if (r.changes !== 1) throw new HttpError(410, 'This code was already used. Start again.');
  await db.run('DELETE FROM otp_failures WHERE email = ?', [inboxKey(c.email)]);
  return { ...c, payload: c.payload ? JSON.parse(c.payload) as Record<string, unknown> : null };
}
