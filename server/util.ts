import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** Laundry runs on campus local time. Month limits and "today" use this zone, not UTC. */
export const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
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

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parse a request body/query with zod; the first issue becomes a readable 400. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new HttpError(400, field && !issue.message.toLowerCase().includes(field.toLowerCase()) ? `${label(field)}: ${issue.message}` : issue.message);
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
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const e = err as { code?: string; message?: string; type?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Photo must be smaller than 5 MB.' });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

export const zText = (min: number, max: number) => z.string().trim().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`);
export const zId = z.coerce.number().int().positive();
