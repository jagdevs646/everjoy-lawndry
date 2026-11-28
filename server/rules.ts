import { assertOrderPrefix } from './workspaces.js';
import { currentWorkspace, inWorkspace, outsideWorkspace, workspaceId, type Workspace } from './workspace-context.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, insertId, logActivity, nextCounter, notify } from './db.js';
import { HttpError, MAX_ID, addDays, awaitingSql, codeKey, dayKey, looseKey, localDateTimeIso, monthKey, nowIso, parse, round2 } from './util.js';
import { slipKey } from './auth.js';
import { orderForSign, recordSignoff, resetDropoff, statementFor, type Origin, type Proof } from './signoff.js';

/* ---------------------------------------------------------------- settings */

export const settingsSchema = z.object({
  max_kg_per_order: z.coerce.number().min(0.5).max(50),           // free washing limit per order (valid hostelers)
  max_active_orders: z.coerce.number().int().min(0).max(20),        // 0 = no limit
  monthly_order_limit: z.coerce.number().int().min(0).max(100),     // 0 = no limit (free washing orders)
  monthly_kg_limit: z.coerce.number().min(0).max(500),              // 0 = no limit (free washing kg)
  allow_paid_extra: z.boolean(),                                    // over a free limit: let staff charge instead of refusing
  extra_rate_per_kg: z.coerce.number().min(0).max(10000),           // price of each kg over a free limit
  express_enabled: z.boolean(),
  express_fee: z.coerce.number().min(0).max(10000),
  regular_turnaround_hours: z.coerce.number().min(1).max(720),
  express_turnaround_hours: z.coerce.number().min(1).max(720),
  pay_before_pickup: z.boolean(),
  upi_id: z.string().trim().max(80),
  upi_name: z.string().trim().max(80),
  upi_qr_file: z.string().trim().max(80),                           // uploaded UPI QR image (files table), '' = none
  semester_start: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-01-01')]), // given to newly approved students
  semester_end: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-06-30')]), // given to newly approved students
  student_email_otp: z.boolean(),                                   // new phones/browsers need a code from the university email
  student_email_domain: z.string().trim().toLowerCase().max(80).regex(/^@?[a-z0-9.-]*$/, 'Enter a domain like university.edu.in'),
  card_required: z.boolean(),                                       // a basket card no. is needed for every order
  // Card series: anything before and after the number (letters, words, signs), e.g. A1–A3000, BLUE-001–BLUE-500, 1/H–200/H.
  card_series: z.array(z.object({
    prefix: z.string().max(40).default(''),
    suffix: z.string().max(40).default(''),
    from: z.coerce.number().int().min(0).max(999999),
    to: z.coerce.number().int().min(0).max(999999),
    pad: z.coerce.number().int().min(0).max(6).default(0),           // digits with leading zeros: 4 → A0001
    // Cards of this series that must not be given: lost, damaged, taken out of use.
    blocked: z.array(z.object({
      from: z.coerce.number().int().min(0).max(999999),
      to: z.coerce.number().int().min(0).max(999999),
      reason: z.enum(['LOST', 'DAMAGED', 'REMOVED', 'OTHER']).default('OTHER'),
      note: z.string().trim().max(80).default(''),
    })).max(300).default([]),
  }).transform(x => ({
    prefix: tidyCardText(x.prefix).trimStart(), suffix: tidyCardText(x.suffix).trimEnd(), from: x.from, to: x.to, pad: x.pad, blocked: x.blocked,
  })).superRefine((x, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message, params: { whole: true } });
    if (x.prefix.length > 12 || x.suffix.length > 12) bad('Card series: up to 12 characters before and after the number.');
    if (/[\u0000-\u001f\u007f<>"`\\]/.test(x.prefix + x.suffix)) bad('Card series: these signs can’t be used: < > " ` \\');
    if (x.from > x.to) bad(`Card series ${x.prefix}…${x.suffix}: “from” must not be bigger than “to”.`);
    for (const b of x.blocked) {
      if (b.from > b.to || b.from < x.from || b.to > x.to) bad(`Cards not to use (${formatCard(x, b.from)}${b.to !== b.from ? ` – ${formatCard(x, b.to)}` : ''}) must be inside the series ${seriesLabel(x)}.`);
    }
  })).max(20).superRefine((list, ctx) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const same = seriesClash(list[i], list[j]);
      if (same) ctx.addIssue({ code: 'custom', params: { whole: true }, message: `Card series ${seriesLabel(list[i])} and ${seriesLabel(list[j])} can give the same card no. (${same}). Change the letters or the numbers so they can’t be mixed up.` });
    }
  }),
  // Order no. style, like an invoice no.: anything before and after the number, and date parts ({YYYY} {YY} {MM} {FY}).
  order_no_format: z.object({
    prefix: z.string().max(40).default('EJ-'),
    suffix: z.string().max(40).default(''),
    pad: z.coerce.number().int().min(0).max(8).default(0),          // digits with leading zeros: 4 → 0001
    start: z.coerce.number().int().min(1).max(99999999).default(1001),
    reset: z.enum(['NEVER', 'YEARLY', 'FY', 'MONTHLY']).default('NEVER'),   // numbers start again from "start"
  }).transform(x => ({ ...x, prefix: tidyCardText(x.prefix).trimStart(), suffix: tidyCardText(x.suffix).trimEnd() })).superRefine((x, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message, params: { whole: true } });
    const all = x.prefix + x.suffix;
    if (x.prefix.length > 20 || x.suffix.length > 20) bad('Order no.: up to 20 characters before and after the number.');
    if (/[\u0000-\u001f\u007f<>"`\\:]/.test(all)) bad('Order no.: these signs can’t be used: < > " ` \\ :');
    const unknown = (all.match(/\{[^}]*\}?/g) ?? []).filter(t => !ORDER_DATE_PARTS.includes(t));
    if (unknown.length) bad(`Order no.: ${unknown[0]} is not a date part. Use {YYYY}, {YY}, {MM} or {FY}.`);
    const has = (...t: string[]) => t.some(p => all.includes(p));
    if (x.reset === 'YEARLY' && !has('{YYYY}', '{YY}')) bad('Order numbers start again every year, so put the year ({YYYY} or {YY}) in the order no. Otherwise numbers would repeat.');
    if (x.reset === 'FY' && !has('{FY}')) bad('Order numbers start again every financial year, so put {FY} (e.g. 26-27) in the order no. Otherwise numbers would repeat.');
    if (x.reset === 'MONTHLY' && !(has('{MM}') && has('{YYYY}', '{YY}', '{FY}'))) bad('Order numbers start again every month, so put the month and year ({MM} and {YY}) in the order no. Otherwise numbers would repeat.');
  }),
  counter_hours: z.string().trim().max(120),
  // Counter timings (campus time). Students give laundry in the drop-off hours and collect in the pickup hours.
  dropoff_from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 18:00'),
  dropoff_to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 20:00'),
  pickup_from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 19:00'),
  pickup_to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 21:00'),
  ready_after_days: z.coerce.number().int().min(0).max(14),          // regular: ready on day of drop-off + N, at pickup time
  express_ready_after_days: z.coerce.number().int().min(0).max(14),
  auto_status: z.boolean(),                                           // move orders to washing / ready by themselves
  auto_washing_hours: z.coerce.number().min(1).max(168),             // "washing" this long after drop-off
  sign_dropoff: z.boolean(),                                          // ask the student to confirm every drop-off (signature or app)
  sign_pickup: z.boolean(),                                           // hand-over needs the student's signature or phone confirmation
});
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  max_kg_per_order: 7,
  max_active_orders: 2,
  monthly_order_limit: 0,
  monthly_kg_limit: 0,
  allow_paid_extra: true,
  extra_rate_per_kg: 20,
  express_enabled: false,
  express_fee: 0,
  regular_turnaround_hours: 48,
  express_turnaround_hours: 24,
  pay_before_pickup: true,
  upi_id: '',
  upi_name: 'Everjoy Lawndry',
  upi_qr_file: '',
  semester_start: '',
  semester_end: '',
  student_email_otp: true,
  student_email_domain: '',
  card_required: false,
  card_series: [],
  order_no_format: { prefix: 'EJ-', suffix: '', pad: 0, start: 1001, reset: 'NEVER' },
  counter_hours: 'Mon–Sat, 8:00 AM – 7:00 PM',
  dropoff_from: '18:00',
  dropoff_to: '20:00',
  pickup_from: '19:00',
  pickup_to: '21:00',
  ready_after_days: 2,
  express_ready_after_days: 1,
  auto_status: true,
  auto_washing_hours: 24,
  sign_dropoff: true,
  sign_pickup: true,
};

/** When an order taken now will be ready: N days after today, at the start of pickup hours. */
export function readyTime(s: Settings, express: boolean, now = new Date()) {
  const days = express ? s.express_ready_after_days : s.ready_after_days;
  let at = localDateTimeIso(addDays(dayKey(now), days), s.pickup_from);
  if (Date.parse(at) <= now.getTime()) at = localDateTimeIso(addDays(dayKey(now), days + 1), s.pickup_from);
  return at;
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM workspace_settings WHERE workspace_id = ?', [workspaceId()]);
  const stored = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
  // Older installs stored over_limit_action; BLOCK meant "no paid extra".
  if (stored.allow_paid_extra === undefined && stored.over_limit_action) stored.allow_paid_extra = stored.over_limit_action === 'CHARGE';
  const merged = { ...defaultSettings, ...stored };
  // Series saved before prefix/suffix/leading zeros existed.
  merged.order_no_format = { ...defaultSettings.order_no_format, ...(merged.order_no_format ?? {}) };
  merged.card_series = (merged.card_series ?? []).map((x: Partial<CardSeries>) => ({ prefix: x.prefix ?? '', suffix: x.suffix ?? '', from: Number(x.from), to: Number(x.to), pad: x.pad ?? 0, blocked: x.blocked ?? [] }));
  return Object.fromEntries(Object.keys(defaultSettings).map(k => [k, (merged as Record<string, unknown>)[k]])) as Settings;
}

export async function saveSettings(actorId: number, input: unknown): Promise<Settings> {
  return db.tx(async () => {
    const before = await getSettings();
    const next = parse(settingsSchema, { ...before, ...(input as object) });
    if (next.semester_start && next.semester_end && next.semester_start > next.semester_end) throw new HttpError(400, 'The semester start must be before its end.');
    if (JSON.stringify(before.order_no_format) !== JSON.stringify(next.order_no_format))
      await assertOrderPrefix(workspaceId(), next.order_no_format.prefix, next.order_no_format.suffix);
    const lookAlike = next.card_series.find(x => cardLooksLikeOrderNo(x, next.order_no_format));
    if (lookAlike) throw new HttpError(400, `Card series ${seriesLabel(lookAlike)} looks like your order numbers (${formatOrderNo(next.order_no_format, next.order_no_format.start)}). Use other letters or signs for cards, so a card is never mixed up with an order.`);
    const changed = (Object.keys(next) as (keyof Settings)[]).filter(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    for (const k of changed) {
      await db.run('INSERT INTO workspace_settings (workspace_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
        [workspaceId(), k, JSON.stringify(next[k]), nowIso(), actorId]);
    }
    // Switching drop-off confirmation off: orders waiting for a code now count as received.
    if (before.sign_dropoff && !next.sign_dropoff) await db.run(`UPDATE orders SET dropoff_needed = 0 WHERE workspace_id = ${workspaceId()} AND (${awaitingSql()})`);
    const show = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
    if (changed.length) await logActivity(actorId, 'SETTINGS_CHANGED', 'settings', null, changed.map(k => `${k}: ${show(before[k])} → ${show(next[k])}`).join('; '));
    return next;
  });
}

/* ---------------------------------------------------------------- services */

export type Service = { id: number; name: string; unit: 'KG' | 'PIECE'; rate: number; hosteler_rate: number; uses_allowance: number; active: number; sort: number };

export const serviceSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(40),
  unit: z.enum(['KG', 'PIECE']),
  rate: z.coerce.number().min(0).max(100000),
  hosteler_rate: z.coerce.number().min(0).max(100000),
  uses_allowance: z.boolean().default(false),
  active: z.boolean().default(true),
  sort: z.coerce.number().int().min(0).max(999).default(0),
});

export async function listServices(includeHidden = false) {
  return db.all<Service>(`SELECT id, name, unit, rate, hosteler_rate, uses_allowance, active, sort FROM services ${includeHidden ? '' : 'WHERE active = 1'} ORDER BY active DESC, sort, id`);
}

export async function getService(id?: number | null): Promise<Service> {
  const s = id
    ? await db.get<Service>('SELECT id, name, unit, rate, hosteler_rate, uses_allowance, active, sort FROM services WHERE id = ?', [id])
    : await db.get<Service>('SELECT id, name, unit, rate, hosteler_rate, uses_allowance, active, sort FROM services WHERE active = 1 ORDER BY uses_allowance DESC, sort, id LIMIT 1');
  if (!s) throw new HttpError(404, 'That service is not available.');
  return s;
}

/* ------------------------------------------------------------------- usage */

/**
 * Free-washing usage this month: only orders of services that use the allowance, and only their
 * free part (within_kg). Paid extra kg and paid services don't use up the free limit.
 */
export async function monthUsage(studentId: number, excludeOrderId = 0) {
  const row = (await db.get<{ orders: number; kg: number }>(`SELECT COUNT(*) AS orders, COALESCE(SUM(o.within_kg), 0) AS kg FROM orders o
    WHERE o.student_id = ? AND o.month_key = ? AND o.status != 'CANCELLED' AND o.id != ? AND o.within_kg > 0`, [studentId, monthKey(), excludeOrderId]))!;
  const active = Number((await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM orders WHERE student_id = ? AND status IN ('RECEIVED','WASHING','READY') AND id != ?`, [studentId, excludeOrderId]))!.c);
  const orders = Number(row.orders);
  const kg = Number(row.kg);
  const s = await getSettings();
  return {
    month: monthKey(),
    orders,
    kg: round2(kg),
    active,
    order_limit: s.monthly_order_limit,
    kg_limit: s.monthly_kg_limit,
    kg_left: s.monthly_kg_limit ? Math.max(0, round2(s.monthly_kg_limit - kg)) : null,
    orders_left: s.monthly_order_limit ? Math.max(0, s.monthly_order_limit - orders) : null,
  };
}

/* ------------------------------------------------------------------- quote */

/* ------------------------------------------------------------ basket cards */

export type CardBlock = { from: number; to: number; reason: 'LOST' | 'DAMAGED' | 'REMOVED' | 'OTHER'; note: string };
export type CardSeries = { prefix: string; suffix: string; from: number; to: number; pad: number; blocked?: CardBlock[] };
const BLOCK_REASON: Record<CardBlock['reason'], string> = { LOST: 'lost', DAMAGED: 'damaged', REMOVED: 'taken out of use', OTHER: 'not to be used' };

/** Upper case, one space between words. */
function tidyCardText(v: string) { return v.toUpperCase().replace(/\s+/g, ' '); }

/** Only the letters and digits: "blue / 0012-h" → "BLUE0012H". Staff can type a card no. with or without its signs and spaces. */
export function looseCard(v: string) { return looseKey(v); }

/** One text "fits" the other if they are equal apart from extra digits on the inside (A and A1, -B and 1-B). */
function textFits(x: string, y: string, atEnd: boolean) {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const rest = atEnd ? long.slice(0, long.length - short.length) : long.slice(short.length);
  return (atEnd ? long.endsWith(short) : long.startsWith(short)) && /^\d*$/.test(rest);
}

/** How a card of this series is written: what comes before, the number (with leading zeros if set), what comes after. */
export function formatCard(x: CardSeries, n: number) { return `${x.prefix}${String(n).padStart(x.pad, '0')}${x.suffix}`; }

export function seriesLabel(x: CardSeries) { return `${formatCard(x, x.from)} – ${formatCard(x, x.to)}`; }

/** The number of the card in this series that `loose` (already looseCard-ed) stands for, or null. */
function seriesNumber(x: CardSeries, loose: string) {
  const lp = looseCard(x.prefix), ls = looseCard(x.suffix);
  if (loose.length <= lp.length + ls.length || !loose.startsWith(lp) || !loose.endsWith(ls)) return null;
  const mid = loose.slice(lp.length, loose.length - ls.length);
  if (!/^\d{1,9}$/.test(mid)) return null;
  const n = Number(mid);
  return n >= x.from && n <= x.to ? n : null;
}

/** A card both series accept (so staff could mix them up), or null. */
function seriesClash(a: CardSeries, b: CardSeries) {
  const [pa, pb, sa, sb] = [a.prefix, b.prefix, a.suffix, b.suffix].map(looseCard);
  if (!textFits(pa, pb, false) || !textFits(sa, sb, true)) return null;
  if (pa === pb && sa === sb) return Math.max(a.from, b.from) <= Math.min(a.to, b.to) ? formatCard(a, Math.max(a.from, b.from)) : null;
  // Rare (e.g. "H" and "H1"): try every card of the smaller series.
  const [p, q] = a.to - a.from <= b.to - b.from ? [a, b] : [b, a];
  for (let n = p.from; n <= p.to; n++) if (seriesNumber(q, looseCard(formatCard(p, n))) !== null) return formatCard(p, n);
  return null;
}

/** The card written the way its series writes it ("a-12" → "A-0012"), or null if no series has it. */
export function matchSeries(series: CardSeries[], raw: string) {
  const hit = findSeriesCard(series, raw);
  return hit ? hit.card : null;
}

/** The series and number a typed card belongs to, or null. */
export function findSeriesCard(series: CardSeries[], raw: string) {
  const loose = looseCard(raw);
  for (const x of series) {
    const n = seriesNumber(x, loose);
    if (n !== null) return { x, n, card: formatCard(x, n) };
  }
  return null;
}

/** Why a card of this series can't be given (lost, damaged…), or null. */
export function cardBlock(x: CardSeries, n: number) {
  const b = (x.blocked ?? []).find(r => n >= r.from && n <= r.to);
  return b ? `${BLOCK_REASON[b.reason]}${b.note ? ` (${b.note})` : ''}` : null;
}

/** "A5000" for the series A1–A3000: right letters, number outside the range. */
function outOfRange(series: CardSeries[], raw: string) {
  const loose = looseCard(raw);
  for (const x of series) {
    const lp = looseCard(x.prefix), ls = looseCard(x.suffix);
    if (loose.length > lp.length + ls.length && loose.startsWith(lp) && loose.endsWith(ls) && /^\d{1,9}$/.test(loose.slice(lp.length, loose.length - ls.length))) return x;
  }
  return null;
}

/** Without a series: "a 1002", "A-1002" → "A1002" (and A012 = A12). */
export const normaliseCard = (v: string) => v.trim().toUpperCase().replace(/[\s-]/g, '').replace(/^([A-Z]{0,3})0+(?=\d)/, '$1');

/** Every way a typed card no. may have been saved: in its series' format, or plain (from before a series was set). */
export function cardCandidates(series: CardSeries[], raw: string) {
  const out = new Set<string>();
  const m = matchSeries(series, raw);
  if (m) out.add(m);
  const plain = normaliseCard(raw);
  if (plain && plain.length <= 40) out.add(plain);
  return [...out];
}

/**
 * Check a basket card no. against the admin's card series (if any). Returns the card no. written the
 * series' way, or null when none was given and none is required.
 */
export function checkCard(s: Settings, raw: string | undefined | null) {
  const typed = String(raw ?? '').trim();
  if (!looseCard(typed)) {
    if (s.card_required) throw new HttpError(422, `Enter the basket card no. (e.g. ${s.card_series[0] ? formatCard(s.card_series[0], s.card_series[0].from) : 'A1002'}).`);
    return null;
  }
  if (s.card_series.length) {
    const hit = findSeriesCard(s.card_series, typed);
    if (!hit) {
      const near = outOfRange(s.card_series, typed);
      if (near) throw new HttpError(422, `Card ${tidyCardText(typed)} is outside the series ${seriesLabel(near)}. Check the no. on the card.`);
      throw new HttpError(422, `Card ${tidyCardText(typed)} is not in the card series set by the admin (${s.card_series.map(seriesLabel).join(', ')}).`);
    }
    const blocked = cardBlock(hit.x, hit.n);
    if (blocked) throw new HttpError(422, `Card ${hit.card} can't be given: it is marked ${blocked}. Use another card.`);
    return hit.card;
  }
  const v = normaliseCard(typed);
  if (cardLooksLikeOrderNo({ prefix: v, suffix: '', from: 0, to: 0, pad: 0 }, s.order_no_format, true)) throw new HttpError(422, `${v} looks like an order no. Type the no. written on the basket card.`);
  if (v.length > 30 || /[\u0000-\u001f\u007f<>"`\\]/.test(v)) throw new HttpError(422, `“${v}” doesn't look like a card no.`);
  return v;
}

/** Which open order (if any) has this card right now, however the card was written (A-0012 = A12). */
export async function cardInUse(card: string, exceptOrderId = 0) {
  return db.get<{ id: number; order_no: string; status: string; tag_no: string }>(
    `SELECT id, order_no, status, tag_no FROM orders WHERE tag_key = ? AND status IN ('RECEIVED','WASHING','READY') AND id != ?`, [codeKey(card), exceptOrderId]);
}

/** The first card of a series that is free: not on a basket waiting to be collected, and not marked lost/damaged. */
export async function nextFreeCard(x: CardSeries) {
  const used = new Set((await db.all<{ k: string }>(`SELECT tag_key AS k FROM orders WHERE tag_key IS NOT NULL AND status IN ('RECEIVED','WASHING','READY')`)).map(r => r.k));
  for (let n = x.from; n <= x.to; n++) {
    const card = formatCard(x, n);
    if (!used.has(codeKey(card)) && !cardBlock(x, n)) return card;
  }
  return null;
}

/** A database uniqueness error (two counters saving at the same moment). */
export const isUniqueError = (e: unknown) => /unique|duplicate key/i.test(String((e as Error)?.message));

/* ---------------------------------------------------------- order numbers */

export type OrderNoFormat = Settings['order_no_format'];
export const ORDER_DATE_PARTS = ['{YYYY}', '{YY}', '{MM}', '{FY}'];

/** Indian financial year of a day: 2026-11-25 → "26-27" (April to March). */
function financialYear(day: string) {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  const a = m >= 4 ? y : y - 1;
  return `${String(a % 100).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`;
}
function fillDate(t: string, day: string) {
  return t.replace(/\{YYYY\}/g, day.slice(0, 4)).replace(/\{YY\}/g, day.slice(2, 4)).replace(/\{MM\}/g, day.slice(5, 7)).replace(/\{FY\}/g, financialYear(day));
}
/** "EJ-" + 1042 → "EJ-1042"; "INV/{FY}/" + 7 (4 digits) → "INV/26-27/0007". */
export function formatOrderNo(f: OrderNoFormat, n: number, day = dayKey()) {
  return `${fillDate(f.prefix, day)}${String(n).padStart(f.pad, '0')}${fillDate(f.suffix, day)}`;
}
/** Each style (and each year/month when numbers start again) has its own counter. The first style keeps the old one. */
function orderCounter(f: OrderNoFormat, day: string) {
  if (f.prefix === 'EJ-' && f.suffix === '' && f.reset === 'NEVER') return 'order_no';
  const period = f.reset === 'YEARLY' ? day.slice(0, 4) : f.reset === 'MONTHLY' ? day.slice(0, 7) : f.reset === 'FY' ? financialYear(day) : '';
  return `order_no:${f.prefix}|${f.suffix}|${period}`;
}

/**
 * The next order no. An order no. is like an invoice no.: it is never given twice. If the admin's style
 * would give a no. that was used before (even written a little differently), that number is skipped.
 */
async function nextOrderNo(f: OrderNoFormat) {
  const day = dayKey();
  const name = orderCounter(f, day);
  for (let i = 0; i < 10000; i++) {
    let n = await nextCounter(name, f.start);
    if (n < f.start) { await db.run('UPDATE workspace_counters SET value = ? WHERE workspace_id = ? AND name = ?', [f.start, workspaceId(), name]); n = f.start; }
    const no = formatOrderNo(f, n, day);
    if (!(await outsideWorkspace(() => db.get('SELECT id FROM orders WHERE order_key = ?', [codeKey(no)])))) return no;
  }
  throw new HttpError(500, 'No free order no. was found. Ask the admin to change the order no. style.');
}

/** What the next order no. will be, without using it up (for the admin's screen). */
export async function peekOrderNo(f: OrderNoFormat) {
  const day = dayKey();
  const row = await db.get<{ value: number }>('SELECT value FROM workspace_counters WHERE workspace_id = ? AND name = ?', [workspaceId(), orderCounter(f, day)]);
  let n = row ? Math.max(Number(row.value) + 1, f.start) : f.start;
  for (let i = 0; i < 1000 && (await outsideWorkspace(() => db.get('SELECT id FROM orders WHERE order_key = ?', [codeKey(formatOrderNo(f, n, day))]))); i++) n++;
  return { no: formatOrderNo(f, n, day), n };
}

/** Order nos. that a typed code could be: the code itself, or just the number part in today's style (or the old EJ- style). */
export function orderKeys(f: OrderNoFormat, raw: string) {
  const k = codeKey(raw);
  const keys = new Set([k]);
  if (/^\d{1,9}$/.test(k)) { keys.add(codeKey(formatOrderNo(f, Number(k)))); keys.add(`EJ${k}`); }
  return [...keys].filter(Boolean);
}

/**
 * Could a card of this series be read as an order no.? (A card "EJ12" next to order "EJ-12" would confuse
 * staff and students.) With `exact`, the series' prefix is one typed card no.
 */
export function cardLooksLikeOrderNo(x: CardSeries, f: OrderNoFormat, exact = false) {
  const day = dayKey();
  const op = looseKey(fillDate(f.prefix, day)), os = looseKey(fillDate(f.suffix, day));
  if (exact) {
    const k = looseKey(x.prefix);
    return (op.length + os.length > 0) && k.length > op.length + os.length && k.startsWith(op) && k.endsWith(os) && /^\d+$/.test(k.slice(op.length, k.length - os.length));
  }
  return textFits(looseKey(x.prefix), op, false) && textFits(looseKey(x.suffix), os, true);
}

/* -------------------------------------------------------- rotating slip QR */

/**
 * The slip QR changes every 30 seconds: EJ2:<order id>.<time step>.<signature>. The signature is an
 * HMAC keyed by the order's secret QR token, which only the student's phone has. A screenshot stops
 * working within about two minutes, so it can't be passed around to collect someone's laundry.
 */
export const QR_STEP_SECONDS = 30;
export const qrSignature = (qrToken: string, orderId: number, step: number) =>
  crypto.createHmac('sha256', slipKey(qrToken)).update(`${orderId}.${step}`).digest('base64url').slice(0, 16);

export const orderInput = z.object({
  studentId: z.coerce.number().int().positive().max(MAX_ID),
  serviceId: z.coerce.number().int().positive().max(MAX_ID).optional(),
  weightKg: z.coerce.number({ error: 'Enter the weight in kg' }).min(0, 'Weight cannot be negative').max(50, 'Weight looks too high (over 50 kg)'),
  clothesCount: z.coerce.number({ error: 'Enter the number of clothes' }).int('Clothes count must be a whole number').min(1, 'Count at least 1 piece of clothing').max(300, 'Clothes count looks too high'),
  express: z.boolean().optional(),
  service: z.enum(['REGULAR', 'EXPRESS']).optional(),   // older clients: EXPRESS = express
  acceptExtra: z.boolean().default(false),               // staff chose "charge for the extra kg"
  note: z.string().trim().max(200).optional().default(''),
  tagNo: z.string().trim().max(60).optional().default(''), // basket card no. written on the physical card
});
export type OrderInput = z.input<typeof orderInput>;

type StudentRow = { id: number; name: string; mobile: string; active: number; status: string; room_no: string; hostel_name: string; id_card_no: string; kind: string; valid_until: string | null; valid_from: string | null };

export async function studentForOrder(studentId: number): Promise<StudentRow> {
  const s = await db.get<StudentRow>(`SELECT u.id, u.name, u.mobile, u.active, st.status, st.room_no, st.id_card_no, st.kind, st.valid_until, st.valid_from, h.name AS hostel_name
    FROM users u JOIN students st ON st.user_id = u.id JOIN hostels h ON h.id = st.hostel_id WHERE u.id = ?`, [studentId]);
  if (!s) throw new HttpError(404, 'Student not found.');
  return s;
}

/** A current hosteler gets the hostel prices and the free washing allowance. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2027-06-30" → "30 Jun 2027" */
export const niceDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** A current hosteler (inside the plan's dates) gets the hostel prices and the free washing allowance. */
export function planStatus(s: { kind: string; valid_until: string | null; valid_from?: string | null }) {
  if (s.kind === 'WALKIN') return { hosteler: false, label: 'Walk-in customer, normal prices' };
  const today = dayKey();
  const from = s.valid_from || null;
  const until = s.valid_until || null;
  if (from && from > today) return { hosteler: false, label: `Hostel plan starts ${niceDate(from)}, normal prices till then` };
  if (until && until < today) return { hosteler: false, label: `Hostel plan ended ${niceDate(until)}, normal prices` };
  if (from && until) return { hosteler: true, label: `Hostel plan ${niceDate(from)} – ${niceDate(until)}` };
  return { hosteler: true, label: until ? `Hostel plan valid till ${niceDate(until)}` : 'Hostel plan' };
}

/**
 * The single place where laundry rules and prices are decided. The counter screen shows this
 * result and the server re-runs it inside the create transaction, so the saved order always
 * matches the rules.
 *
 * Over a free limit (kg per order, monthly kg or monthly orders) the order is refused with a
 * 422 carrying the two choices (remove the extra kg, or charge for it) until staff pass
 * acceptExtra = true. Admin can turn the paid choice off.
 */
/** How an existing order was priced when it was taken (used when correcting it). */
export type PriceSnapshot = { hosteler: boolean; rate: number | null; unit: 'KG' | 'PIECE' | null };

export async function quote(raw: OrderInput, excludeOrderId = 0, snapshot?: PriceSnapshot) {
  const input = orderInput.parse(raw);
  const s = await getSettings();
  if (currentWorkspace().status === 'PAUSED') throw new HttpError(409, 'This workspace is paused for new orders.');
  const student = await studentForOrder(input.studentId);
  if (student.status === 'PENDING') throw new HttpError(409, `${student.name}'s registration is not approved yet. Verify the ID card and approve first.`);
  if (!student.active) throw new HttpError(409, `${student.name}'s account is switched off (removed from the hostel list). The admin can restore it under Students → Left hostel.`);
  if (student.status !== 'ACTIVE') throw new HttpError(409, `${student.name}'s account is ${student.status.toLowerCase()}. Orders cannot be taken.`);
  const current = await getService(input.serviceId);
  // A correction keeps the order's own service even if the admin has hidden it since.
  if (!current.active && !excludeOrderId) throw new HttpError(422, `${current.name} is not offered right now.`);
  const service = snapshot?.unit ? { ...current, unit: snapshot.unit } : current;

  // Basket card: right format, in the admin's series, and not on another order that isn't collected yet.
  const tagNo = excludeOrderId ? null : checkCard(s, input.tagNo);
  if (tagNo) {
    const busy = await cardInUse(tagNo);
    if (busy) throw new HttpError(409, `Card ${tagNo} is still on ${busy.order_no} (${busy.status.toLowerCase()}, not collected). Use another card.`, { code: 'CARD_IN_USE' });
  }

  const express = input.express ?? input.service === 'EXPRESS';
  if (express && !s.express_enabled) throw new HttpError(422, 'Express service is switched off.');
  const weight = round2(input.weightKg);
  if ((service.unit === 'KG' || service.uses_allowance) && weight <= 0) throw new HttpError(422, 'Weight must be more than 0 kg.');

  const usage = await monthUsage(student.id, excludeOrderId);
  if (s.max_active_orders && usage.active >= s.max_active_orders) throw new HttpError(422, `${student.name} already has ${usage.active} order(s) in progress (limit ${s.max_active_orders}). Collect them first.`);

  // A correction keeps the plan and price the order was taken with (the plan may have ended since).
  const plan = snapshot ? { hosteler: snapshot.hosteler, label: snapshot.hosteler ? 'Hostel plan' : 'Normal prices' } : planStatus(student);
  const qty = service.unit === 'KG' ? weight : input.clothesCount;
  const unitRate = snapshot?.rate ?? (plan.hosteler ? service.hosteler_rate : service.rate);
  let within = 0;
  let extra = 0;
  let notes: string[] = [];
  if (!plan.hosteler) notes.push(plan.label);

  if (plan.hosteler && service.uses_allowance) {
    // How much of this order is free: the per-order limit, the monthly kg left, and the monthly order count.
    let allowed = s.max_kg_per_order;
    const reasons: string[] = [`${s.max_kg_per_order} kg per order`];
    if (s.monthly_kg_limit) {
      allowed = Math.min(allowed, usage.kg_left ?? allowed);
      if ((usage.kg_left ?? 0) < s.max_kg_per_order) reasons.push(`${usage.kg_left} kg left this month`);
    }
    if (s.monthly_order_limit && usage.orders >= s.monthly_order_limit) {
      allowed = 0;
      reasons.push(`monthly limit of ${s.monthly_order_limit} free orders reached`);
    }
    allowed = Math.max(0, round2(allowed));
    within = Math.min(weight, allowed);
    extra = round2(weight - within);
    if (extra > 0) {
      const limitText = reasons.length > 1 ? reasons.slice(1).join(', ') : reasons[0];
      const extraCharge = round2(extra * s.extra_rate_per_kg);
      if (!s.allow_paid_extra) {
        throw new HttpError(422, allowed > 0 ? `Over the free limit (${limitText}). Remove ${extra} kg to keep it within ${allowed} kg.` : `No free washing left (${limitText}).`,
          { code: 'OVER_LIMIT', extra_kg: extra, keep_kg: allowed, can_charge: false });
      }
      if (!input.acceptExtra) {
        throw new HttpError(422, allowed > 0
          ? `Over the free limit by ${extra} kg (${limitText}). Remove ${extra} kg, or charge ₹${extraCharge} for the extra.`
          : `No free washing left (${limitText}). Charge ₹${extraCharge} for ${extra} kg, or don't take the order.`,
          { code: 'OVER_LIMIT', extra_kg: extra, keep_kg: allowed, extra_charge: extraCharge, rate: s.extra_rate_per_kg, can_charge: true });
      }
      notes.push(`${extra} kg over the free limit at ₹${s.extra_rate_per_kg}/kg`);
    }
  }

  const base = round2(qty * unitRate);
  const extraCharge = round2(extra * s.extra_rate_per_kg);
  const expressFee = express ? s.express_fee : 0;
  const amount = round2(base + extraCharge + expressFee);
  const expectedAt = readyTime(s, express);
  return {
    student: { id: student.id, name: student.name, id_card_no: student.id_card_no, hostel_name: student.hostel_name, room_no: student.room_no, mobile: student.mobile, kind: student.kind },
    plan,
    tag_no: tagNo,
    service: { id: service.id, name: service.name, unit: service.unit, rate: unitRate },
    weight_kg: weight,
    clothes_count: input.clothesCount,
    express,
    within_kg: round2(within),
    extra_kg: extra,
    amount,
    breakdown: { service: base, extra: extraCharge, express: expressFee },
    charge_note: notes.join('; ') || null,
    expected_at: expectedAt,
    usage_after: {
      orders: usage.orders + (within > 0 ? 1 : 0),
      kg: round2(usage.kg + within),
      order_limit: s.monthly_order_limit,
      kg_limit: s.monthly_kg_limit,
    },
  };
}

/* ------------------------------------------------------------------ orders */

export async function createOrder(actorId: number, input: OrderInput, requestId?: string) {
  return db.tx(async () => {
    // Serialise orders per student so the active/monthly limits hold under concurrent requests.
    await db.lockRow('users', Number(input.studentId));
    if (requestId) {
      const existing = await db.get<{ id: number; order_no: string }>('SELECT id, order_no FROM orders WHERE request_id = ?', [requestId]);
      if (existing) return { ...existing, duplicate: true };
    }
    const q = await quote(input);
    const settings = await getSettings();
    const no = await nextOrderNo(settings.order_no_format);
    const at = nowIso();
    const token = crypto.randomBytes(16).toString('base64url');
    const note = String(orderInput.parse(input).note || '') || null;
    const id = await insertId(`INSERT INTO orders (workspace_id, order_no, student_id, hostel_name, room_no, mobile, weight_kg, clothes_count, service, note,
        within_kg, extra_kg, amount, payment_status, qr_token, request_id, received_by, received_at, day_key, month_key, expected_at, updated_at,
        service_id, service_name, unit, rate, charge_note, plan_hosteler, tag_no, order_key, tag_key, dropoff_needed)
      VALUES (${workspaceId()}, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      no, q.student.id, q.student.hostel_name, q.student.room_no, q.student.mobile, q.weight_kg, q.clothes_count, q.express ? 'EXPRESS' : 'REGULAR', note,
      q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? 'DUE' : 'NONE', token, requestId ?? null, actorId, at, dayKey(), monthKey(), q.expected_at, at,
      q.service.id, q.service.name, q.service.unit, q.service.rate, q.charge_note, q.plan.hosteler ? 1 : 0, q.tag_no, codeKey(no), q.tag_no ? codeKey(q.tag_no) : null,
      // Students confirm the drop-off with the code on their phone; walk-in customers have no app.
      settings.sign_dropoff && q.student.kind !== 'WALKIN' ? 1 : 0,
    ]).catch((e: unknown) => {
      if (q.tag_no && isUniqueError(e)) throw new HttpError(409, `Card ${q.tag_no} was just given to another basket. Use another card.`, { code: 'CARD_IN_USE' });
      throw e;
    });
    const what = `${q.service.name}, ${q.clothes_count} clothes${q.weight_kg ? `, ${q.weight_kg} kg` : ''}${q.tag_no ? `, card ${q.tag_no}` : ''}`;
    await addEvent(id, 'RECEIVED', what, actorId);
    await notify(q.student.id, `Order ${no} received`, `${what}. Your digital slip is ready — keep it till pickup.${q.amount > 0 ? ` Amount due ₹${q.amount}.` : ''}`, id);
    await logActivity(actorId, 'ORDER_CREATED', 'order', no, `${q.student.id_card_no}, ${what}${q.amount ? `, ₹${q.amount}` : ''}`);
    return { id, order_no: no, duplicate: false };
  });
}

export async function addEvent(orderId: number, type: string, note: string | null, byUser: number | null) {
  await db.run(`INSERT INTO order_events (workspace_id, order_id, type, note, by_user, at) VALUES (${workspaceId()}, ?,?,?,?,?)`, [orderId, type, note, byUser, nowIso()]);
}

type OrderRow = { id: number; order_no: string; student_id: number; status: string; payment_status: string; amount: number; clothes_count: number; ready_at: string | null };
export async function getOrderRow(id: number) {
  const o = await db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o) throw new HttpError(404, 'Order not found.');
  return o;
}

const OPEN = ['RECEIVED', 'WASHING', 'READY'];

export async function setStatus(actorId: number, ids: number[], status: 'RECEIVED' | 'WASHING' | 'READY', opts: { allowBackToReceived?: boolean } = { allowBackToReceived: true }) {
  return db.tx(async () => {
    // Lock every order up front, in id order, so two overlapping batch updates can't deadlock on Postgres.
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) await db.lockRow('orders', id);
    let changed = 0;
    for (const id of ids) {
      const o = await getOrderRow(id);
      if (!OPEN.includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()} and cannot be changed.`);
      if (o.status === status) continue;
      if (await db.get(`SELECT id FROM orders WHERE id = ? AND ${awaitingSql()}`, [id])) {
        throw new HttpError(409, `${o.order_no} is not confirmed by the student yet. Ask for the code on their phone first: until then it does not count as received.`, { code: 'NOT_CONFIRMED' });
      }
      if (status === 'RECEIVED' && !opts.allowBackToReceived) throw new HttpError(403, `${o.order_no} is already ${o.status.toLowerCase()}. Only the admin can move it back to received.`);
      const now = nowIso();
      await db.run(`UPDATE orders SET status = ?, ready_at = ?, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`, [status, status === 'READY' ? now : o.ready_at, now, id]);
      await addEvent(id, status, null, actorId);
      if (status === 'READY') await notify(o.student_id, `${o.order_no} is ready for pickup`, `Show your slip QR at the counter.${o.payment_status === 'DUE' ? ` Please pay ₹${o.amount} before pickup.` : ''}`, id);
      changed++;
    }
    if (changed) await logActivity(actorId, 'ORDER_STATUS', 'order', ids.length === 1 ? (await getOrderRow(ids[0])).order_no : `${changed} orders`, status);
    return changed;
  });
}

export async function recordPayment(actorId: number, id: number, method: 'CASH' | 'UPI' | 'WAIVED', ref = '') {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (o.payment_status !== 'DUE') throw new HttpError(409, `${o.order_no} has no payment due.`);
    await db.run(`UPDATE orders SET payment_status = ?, paid_method = ?, paid_ref = ?, paid_at = ?, paid_by = ?, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`,
      [method === 'WAIVED' ? 'WAIVED' : 'PAID', method, ref || null, nowIso(), actorId, nowIso(), id]);
    await addEvent(id, method === 'WAIVED' ? 'PAYMENT_WAIVED' : 'PAID', method === 'WAIVED' ? ref || null : `₹${o.amount} via ${method}${ref ? `, ${ref}` : ''}`, actorId);
    await notify(o.student_id, method === 'WAIVED' ? `Payment waived for ${o.order_no}` : `Payment received for ${o.order_no}`, method === 'WAIVED' ? 'No payment is needed for this order.' : `₹${o.amount} received via ${method}. Thank you!`, id);
    await logActivity(actorId, method === 'WAIVED' ? 'PAYMENT_WAIVED' : 'PAYMENT_RECORDED', 'order', o.order_no, method === 'WAIVED' ? ref : `₹${o.amount} ${method} ${ref}`.trim());
  });
}

/** Checks before clothes leave the counter (also used before asking the student to confirm on their phone). */
export async function checkHandover(id: number, returnedCount: number, note: string, paying = false) {
  const s = await getSettings();
  const o = await getOrderRow(id);
  if (o.status === 'DELIVERED') throw new HttpError(409, `${o.order_no} was already handed over. Do not give clothes again.`);
  if (o.status === 'CANCELLED') throw new HttpError(409, `${o.order_no} was cancelled.`);
  if (s.pay_before_pickup && o.payment_status === 'DUE' && !paying) throw new HttpError(409, `Collect ₹${o.amount} before handing over ${o.order_no}.`);
  if (returnedCount !== o.clothes_count && !note.trim()) throw new HttpError(422, `Count mismatch: ${o.clothes_count} given, ${returnedCount} returned. Add a note explaining why.`);
  return { s, o };
}

/**
 * Hand the clothes back. With "student confirms collection" on (default), `proof` is needed: the student's
 * finger signature on the counter screen, their confirmation in the app, or (admin only) an override with a reason.
 */
export async function deliverOrder(actorId: number, id: number, returnedCount: number, note: string, proof?: Proof, origin?: Origin) {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const { s, o } = await checkHandover(id, returnedCount, note);
    if (s.sign_pickup && !proof) throw new HttpError(409, 'Ask the student for the code on their phone before you hand the clothes over.', { code: 'SIGN_NEEDED' });
    const at = nowIso();
    if (o.status !== 'READY') await addEvent(id, 'READY', 'Marked ready at handover', actorId);
    await db.run(`UPDATE orders SET status = 'DELIVERED', ready_at = COALESCE(ready_at, ?), delivered_by = ?, delivered_at = ?, returned_count = ?, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`,
      [at, actorId, at, returnedCount, at, id]);
    await addEvent(id, 'DELIVERED', `${returnedCount} of ${o.clothes_count} clothes returned${note ? `, ${note}` : ''}`, actorId);
    if (proof) {
      const so = await orderForSign(id);
      await recordSignoff({ o: so, kind: 'PICKUP', proof, staffId: actorId, at, statement: statementFor('PICKUP', so, at, returnedCount, note.trim()), origin, returned: returnedCount });
    }
    await db.run(`DELETE FROM confirm_requests WHERE workspace_id = ${workspaceId()} AND (order_id = ?)`, [id]);
    await notify(o.student_id, `${o.order_no} handed over`, `${returnedCount} clothes returned. ${returnedCount !== o.clothes_count ? 'Count differed from drop-off — raise a complaint if something is missing.' : 'Thank you for using Everjoy Lawndry!'}`, id);
    await logActivity(actorId, 'ORDER_DELIVERED', 'order', o.order_no, `${returnedCount}/${o.clothes_count} clothes${note ? `, ${note}` : ''}`);
  });
}

export async function cancelOrder(actorId: number, id: number, reason: string) {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (!OPEN.includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()} and cannot be cancelled.`);
    await db.run(`UPDATE orders SET status = 'CANCELLED', cancel_reason = ?, payment_status = CASE WHEN payment_status = 'DUE' THEN 'NONE' ELSE payment_status END, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`, [reason, nowIso(), id]);
    await db.run(`DELETE FROM confirm_requests WHERE workspace_id = ${workspaceId()} AND (order_id = ?)`, [id]);
    await addEvent(id, 'CANCELLED', reason, actorId);
    await notify(o.student_id, `${o.order_no} cancelled`, reason, id);
    await logActivity(actorId, 'ORDER_CANCELLED', 'order', o.order_no, reason);
  });
}

/** Admin correction of a wrongly entered weight or count. Re-runs the rules so price and limits stay consistent. */
export async function correctOrder(actorId: number, id: number, weightKg: number, clothesCount: number, reason: string) {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await db.get<OrderRow & { weight_kg: number; service: 'REGULAR' | 'EXPRESS'; payment_status: string; service_id: number | null;
      plan_hosteler: number | null; rate: number | null; unit: 'KG' | 'PIECE' | null }>('SELECT * FROM orders WHERE id = ?', [id]);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (!OPEN.includes(o.status)) throw new HttpError(409, 'Only orders still in progress can be corrected.');
    if (o.payment_status === 'PAID') throw new HttpError(409, 'This order is already paid; cancel and recreate it instead.');
    // Same per-student lock as createOrder, so a correction and a new order can't both pass the monthly limits.
    await db.lockRow('users', o.student_id);
    // A deliberate correction: weight over the free limit is charged rather than refused.
    // Orders from before plans existed were all hostel orders.
    const snapshot: PriceSnapshot = { hosteler: o.plan_hosteler === null || o.plan_hosteler === undefined ? true : !!Number(o.plan_hosteler), rate: o.rate ?? null, unit: o.unit ?? null };
    const q = await quote({ studentId: o.student_id, serviceId: o.service_id ?? undefined, weightKg, clothesCount, express: o.service === 'EXPRESS', acceptExtra: true, note: '' }, id, snapshot);
    await db.run(`UPDATE orders SET weight_kg = ?, clothes_count = ?, within_kg = ?, extra_kg = ?, amount = ?, payment_status = ?, charge_note = ?, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ?)`,
      [q.weight_kg, q.clothes_count, q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? (o.payment_status === 'WAIVED' ? 'WAIVED' : 'DUE') : 'NONE', q.charge_note, nowIso(), id]);
    const detail = `${o.clothes_count}→${q.clothes_count} clothes, ${o.weight_kg}→${q.weight_kg} kg, ${reason}`;
    await db.run(`DELETE FROM confirm_requests WHERE workspace_id = ${workspaceId()} AND (order_id = ?)`, [id]);   // the student would confirm old numbers
    await addEvent(id, 'CORRECTED', detail, actorId);
    // The student confirmed the old count/weight: that confirmation no longer describes this order.
    const ack = (o as unknown as { dropoff_ack: string | null }).dropoff_ack;
    if (ack && (Number(o.clothes_count) !== q.clothes_count || Number(o.weight_kg) !== q.weight_kg)) await resetDropoff(o, actorId, nowIso());
    await notify(o.student_id, `${o.order_no} details corrected`, `Now ${q.clothes_count} clothes, ${q.weight_kg} kg. Reason: ${reason}`, id);
    await logActivity(actorId, 'ORDER_CORRECTED', 'order', o.order_no, detail);
  });
}


/* --------------------------------------------------------- automatic status */

/**
 * Orders move along by themselves (admin can switch this off): "washing" once they have been at the
 * counter for the set hours, and "ready for pickup" at their ready time (pickup hours on the ready day).
 * Staff can still change a status by hand at any time. Each order changes only once per step, even if
 * two servers or requests run this at the same moment.
 */
export async function runAutoAdvance(now = new Date()) {
  const s = await getSettings();
  if (!s.auto_status) return { washing: 0, ready: 0 };
  const at = now.toISOString();
  let washing = 0;
  let ready = 0;
  const toReady = await db.all<{ id: number; order_no: string; student_id: number; payment_status: string; amount: number }>(
    `SELECT id, order_no, student_id, payment_status, amount FROM orders WHERE status IN ('RECEIVED','WASHING') AND expected_at <= ? AND NOT ${awaitingSql()} ORDER BY id LIMIT 500`, [at]);
  for (const o of toReady) {
    const r = await db.run(`UPDATE orders SET status = 'READY', ready_at = ?, updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ? AND status IN ('RECEIVED','WASHING'))`, [at, at, o.id]);
    if (r.changes !== 1) continue;
    ready++;
    await addEvent(o.id, 'READY', 'Automatic: ready time reached', null);
    await notify(o.student_id, `${o.order_no} is ready for pickup`, `Collect it in pickup hours (${s.pickup_from}–${s.pickup_to}) with your slip QR.${o.payment_status === 'DUE' ? ` Please pay ₹${o.amount} before pickup.` : ''}`, o.id);
  }
  const washingBefore = new Date(now.getTime() - s.auto_washing_hours * 3600_000).toISOString();
  const toWash = await db.all<{ id: number }>(`SELECT id FROM orders WHERE status = 'RECEIVED' AND received_at <= ? AND NOT ${awaitingSql()} ORDER BY id LIMIT 500`, [washingBefore]);
  for (const o of toWash) {
    const r = await db.run(`UPDATE orders SET status = 'WASHING', updated_at = ? WHERE workspace_id = ${workspaceId()} AND (id = ? AND status = 'RECEIVED')`, [at, o.id]);
    if (r.changes !== 1) continue;
    washing++;
    await addEvent(o.id, 'WASHING', 'Automatic', null);
  }
  if (washing || ready) await logActivity(null, 'AUTO_STATUS', 'order', null, `${washing} to washing, ${ready} ready for pickup`);
  return { washing, ready };
}

let lastAuto = 0;
let autoRunning = false;
/** Run the automatic step at most once a minute (called on requests, so it also works when the free server just woke up). */
export function maybeAutoAdvance() {
  if (autoRunning || Date.now() - lastAuto < 60_000) return;
  lastAuto = Date.now();
  autoRunning = true;
  outsideWorkspace(async () => {
    const workspaces = await db.all<Workspace>('SELECT * FROM workspaces ORDER BY id');
    for (const workspace of workspaces) await inWorkspace(workspace, () => runAutoAdvance());
  }).catch(e => console.error('Automatic status step failed:', (e as Error).message)).finally(() => { autoRunning = false; });
}
