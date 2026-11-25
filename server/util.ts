import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** Laundry runs on campus local time. Month limits and "today" use this zone, not UTC. */
export const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';

export class HttpError extends Error {
  /** `details` is sent to the client with the message (e.g. the choices for an over-limit order). */
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

export const nowIso = () => new Date().toISOString();

/** YYYY-MM-DD for the given instant in campus time. */
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export const monthKey = (date = new Date()) => dayKey(date).slice(0, 7);

/** UTC instant of the most recent campus midnight, for comparing against stored ISO timestamps. */
export function startOfLocalDayIso(date = new Date()) {
  const asLocal = new Date(date.toLocaleString('en-US', { timeZone: APP_TZ }));
  const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = asLocal.getTime() - asUtc.getTime();
  return new Date(Date.parse(`${dayKey(date)}T00:00:00.000Z`) - offsetMs).toISOString();
}

/** "2026-11-24" + n days → "2026-11-26" (calendar days, no time zone involved). */
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant of a campus-local date and time, e.g. ("2026-11-26", "19:00") in Asia/Kolkata → 13:30Z. */
export function localDateTimeIso(day: string, hhmm: string) {
  const guess = Date.parse(`${day}T${hhmm}:00.000Z`);
  const at = new Date(guess);
  const asLocal = new Date(at.toLocaleString('en-US', { timeZone: APP_TZ }));
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (asLocal.getTime() - asUtc.getTime())).toISOString();
}

/** Monday of the week a day belongs to (for weekly charts). */
export function weekStart(day: string) {
  const d = new Date(`${day}T12:00:00.000Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parse a request body/query with zod; the first issue becomes a readable 400. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    // A custom check with params.whole writes its own full sentence.
    const whole = issue.code === 'custom' && (issue as { params?: { whole?: boolean } }).params?.whole;
    throw new HttpError(400, field && !whole && !issue.message.toLowerCase().includes(field.toLowerCase()) ? `${label(field)}: ${issue.message}` : issue.message);
  }
  return result.data;
}
const label = (field: string) => field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

/** Wrap a handler so thrown errors (sync or async) become JSON responses. */
export function handle<Req extends Request = Request>(fn: (req: Req, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => fn(req as Req, res)).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  const e = err as { code?: string; message?: string; type?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Photo must be smaller than 5 MB.' });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  // Database constraint and input errors are the caller's problem, not a server crash.
  // Postgres: 23505 unique_violation, class 22 data exceptions (bad number, NUL byte, out of range).
  // SQLite: SQLITE_CONSTRAINT_UNIQUE, SQLITE_MISMATCH.
  if (e?.code === '23505' || e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return res.status(409).json({ error: 'That already exists. Refresh and check, then try again.' });
  }
  if ((typeof e?.code === 'string' && /^22[0-9A-Z]{3}$/.test(e.code)) || e?.code === 'SQLITE_MISMATCH') {
    return res.status(400).json({ error: 'Some of the information sent is not valid.' });
  }
  // Database unreachable (Neon waking up, network blip): ask the client to retry instead of signing out.
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '57P03', '08006', '08001', '08003'].includes(String(e?.code)) || /timeout exceeded|Connection terminated/i.test(String(e?.message))) {
    console.error(err);
    return res.status(503).json({ error: 'The laundry server is busy. Please try again in a moment.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

export const zText = (min: number, max: number) => z.string().trim().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`);
/** Database ids are 32-bit integers on Postgres; anything larger can't exist. */
export const MAX_ID = 2_147_483_647;
export const zId = z.coerce.number().int().positive().max(MAX_ID);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-05-31').refine(v => {
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}, 'That date does not exist (check day and month)');

/** A LIKE pattern for "contains q" that treats %, _ and \ in user input literally (use with ESCAPE '\'). */
export const likeContains = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
