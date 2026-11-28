import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { HttpError } from './util.js';

export type Role = 'ADMIN' | 'STAFF' | 'STUDENT';
export type AuthUser = { workspace_id: number; id: number; role: Role; name: string; login_id: string; must_change_password: boolean; complete_profile?: boolean; student_status?: string };
export type AuthedRequest = Request & { user: AuthUser };

/**
 * Signing secret for sessions. Use JWT_SECRET if set; otherwise generate a random secret once
 * and keep it in the database (app_secrets, key 'jwt'), so a forgotten setting never falls back
 * to a value anyone could read in the source code, and every server sharing the database
 * (e.g. several hosted instances, or a restart on a fresh disk) signs with the same secret.
 */
let SECRET: string | null = null;

/** Load (or create once) the signing secret. Call after db.open() and migrate(), before serving requests. */
export async function initAuthSecret() {
  if (process.env.JWT_SECRET) { SECRET = process.env.JWT_SECRET; return; }
  const read = async () => (await db.get<{ value: string }>('SELECT value FROM app_secrets WHERE key = ?', ['jwt']))?.value;
  let saved = await read();
  if (!saved) {
    // Two servers starting at once may both get here: DO NOTHING keeps the first, and re-reading makes them agree.
    await db.run('INSERT INTO app_secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', ['jwt', crypto.randomBytes(48).toString('hex')]);
    saved = await read();
  }
  if (!saved) throw new Error('Could not load or create the session signing secret.');
  SECRET = saved;
}

function secret() {
  if (!SECRET) throw new Error('Session signing secret not loaded yet. Call initAuthSecret() at startup.');
  return SECRET;
}

const COOKIE = 'ej_session';
const MAX_AGE_DAYS = 30;  // students stay signed in on their own phone

const issueToken = (userId: number, tokenVersion: number) => jwt.sign({ sub: userId, v: tokenVersion, typ: 'session' }, secret(), { expiresIn: `${MAX_AGE_DAYS}d` });

export function setSessionCookie(res: Response, userId: number, tokenVersion: number) {
  res.cookie(COOKIE, issueToken(userId, tokenVersion), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_DAYS * 86400_000,
    path: '/',
  });
}
export const clearSessionCookie = (res: Response) => res.clearCookie(COOKIE, { path: '/' });

/** The Android/iOS app identifies itself with this header and keeps a bearer token instead of a cookie. */
export const isAppClient = (req: Request) => req.headers['x-ej-client'] === 'app';

/**
 * Start a session. The website gets the httpOnly cookie. The app runs on a different
 * origin, where WebViews don't reliably keep third-party cookies, so it gets the same
 * signed token to send as `Authorization: Bearer …`. Returns the token for app clients only.
 */
export function startSession(req: Request, res: Response, userId: number, tokenVersion: number): string | undefined {
  if (isAppClient(req)) return issueToken(userId, tokenVersion);
  setSessionCookie(res, userId, tokenVersion);
  return undefined;
}

/**
 * CORS for the app only. The bundled app is served from the Capacitor local origin
 * (https://localhost on Android, capacitor://localhost on iOS) and calls this API cross-origin
 * with a bearer token. No credentials (cookies) are allowed cross-origin, so the website's
 * cookie session can never be used from another origin.
 */
const APP_ORIGINS = new Set((process.env.APP_ORIGINS || 'https://localhost,capacitor://localhost,http://localhost').split(',').map(s => s.trim()).filter(Boolean));
export function appCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ej, x-ej-client, x-ej-device, x-ej-workspace');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function loadUser(id: number, version?: number): Promise<AuthUser | null> {
  const u = await db.get<{ workspace_id: number; id: number; role: Role; name: string; login_id: string; active: number; must_change_password: number; token_version: number; complete_profile: number; student_status: string | null }>(
    `SELECT u.workspace_id, u.id, u.role, u.name, u.login_id, u.active, u.must_change_password, u.token_version, s.complete_profile, s.status AS student_status
    FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.id = ?`, [id]);
  if (!u || !u.active) return null;
  if (version !== undefined && version !== u.token_version) return null;  // password changed / reset → old sessions die
  return { workspace_id: u.workspace_id, id: u.id, role: u.role, name: u.name, login_id: u.login_id, must_change_password: !!u.must_change_password, ...(u.complete_profile ? { complete_profile: true } : {}), ...(u.student_status ? { student_status: u.student_status } : {}) };
}

/** Attach req.user when a valid bearer token (app) or session cookie (website) is present. */
export async function session(req: Request, _res: Response, next: NextFunction) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  const token = bearer || readCookie(req, COOKIE);
  if (token) {
    const key = secret();  // outside the try: a missing initAuthSecret() is a startup bug, not a signed-out user
    let p: { sub: number; v: number; typ?: string };
    try {
      p = jwt.verify(token, key) as unknown as { sub: number; v: number; typ?: string };
    } catch {
      return next();   // expired or tampered token: treat as signed out
    }
    if (p.typ === 'device') return next();   // a trusted-device token is not a session
    // A database error here is NOT "signed out": let it become a 500/503 so apps keep their token and retry.
    try {
      const user = await loadUser(Number(p.sub), p.v);
      if (user) (req as AuthedRequest).user = user;
    } catch (e) {
      return next(e);
    }
  }
  next();
}

/**
 * CSRF guard. The session cookie is SameSite=Lax and every state-changing call
 * must carry a custom header, which a cross-site form or image cannot send.
 */
export function csrf(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-ej'] !== '1') return next(new HttpError(403, 'Request blocked. Reload the page and try again.'));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthedRequest).user;
    if (!user) return next(new HttpError(401, 'Please sign in.'));
    if (!roles.includes(user.role)) return next(new HttpError(403, 'You do not have access to this.'));
    next();
  };
}

/*
 * Trusted devices. After a student types the email code on a phone or browser, that device gets a
 * signed "device token" (httpOnly cookie on the website, secure storage in the app). It names the
 * user and the account's token_version, so signing out, a password change or a reset untrusts every
 * device at once. It is not a session: the password is still needed.
 */
const DEVICE_COOKIE = 'ej_device';
const DEVICE_DAYS = 30;

export function trustDevice(req: Request, res: Response, userId: number, tokenVersion: number): string | undefined {
  const t = jwt.sign({ sub: userId, v: tokenVersion, typ: 'device' }, secret(), { expiresIn: `${DEVICE_DAYS}d` });
  if (isAppClient(req)) return t;
  res.cookie(DEVICE_COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: DEVICE_DAYS * 86400_000, path: '/' });
  return undefined;
}

export function isTrustedDevice(req: Request, userId: number, tokenVersion: number) {
  const t = String(req.headers['x-ej-device'] || '') || readCookie(req, DEVICE_COOKIE);
  if (!t) return false;
  try {
    const p = jwt.verify(t, secret()) as unknown as { sub: number; v: number; typ?: string };
    return p.typ === 'device' && Number(p.sub) === userId && p.v === tokenVersion;
  } catch {
    return false;
  }
}

/**
 * The key a student's phone uses to sign the rotating slip QR. It is derived from the order's
 * secret QR token with the server secret, so the token itself (shown inside the old fixed QR, and
 * possibly in old screenshots) is never enough to make a valid QR.
 */
export const slipKey = (qrToken: string) => crypto.createHmac('sha256', secret()).update(`slipqr:${qrToken}`).digest('base64url');

/* Tiny in-memory limiter: enough for one server; resets on restart. */
const hits = new Map<string, { n: number; until: number }>();
export function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return false; }
  h.n++;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  return h.n > max;
}
export const clearLimit = (key: string) => hits.delete(key);
/** True when `key` already had `max` hits in its window (does not count this call). */
export function overLimit(key: string, max: number) {
  const h = hits.get(key);
  return !!h && h.until >= Date.now() && h.n >= max;
}
/** Take back one hit (an attempt that turned out to be a correct password). */
export function unhit(key: string) {
  const h = hits.get(key);
  if (h && h.n > 0) h.n--;
}
/** Count one hit (e.g. one failed password) against `key`. */
export function hit(key: string, windowMs: number) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) hits.set(key, { n: 1, until: now + windowMs });
  else h.n++;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
}

/**
 * A temporary password (reset by staff, first admin sign-in) only lets the person choose a new one.
 * Everything else waits until they have, so a temporary password handed over at the counter can't be
 * used to work in the account.
 */
const OPEN_WHILE_CHANGING = new Set(['/auth/me', '/auth/password', '/auth/logout', '/public/info', '/health']);
export function mustChangePassword(req: Request, _res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user?.must_change_password && !OPEN_WHILE_CHANGING.has(req.path)) {
    return next(new HttpError(403, 'Choose a new password first.', { code: 'MUST_CHANGE_PASSWORD' }));
  }
  next();
}
