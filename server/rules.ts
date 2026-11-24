import crypto from 'node:crypto';
import { z } from 'zod';
import { db, insertId, logActivity, nextCounter, notify } from './db.js';
import { HttpError, MAX_ID, dayKey, monthKey, nowIso, parse, round2 } from './util.js';
import { slipKey } from './auth.js';

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
  card_series: z.array(z.object({
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{0,3}$/, 'Card letters: up to 3 letters (or none)')
      .refine(v => v !== 'EJ', 'EJ is used for order numbers. Choose other letters for cards.'),
    from: z.coerce.number().int().min(0).max(999999),
    to: z.coerce.number().int().min(0).max(999999),
  }).refine(s => s.from <= s.to, 'In a card series, "from" must not be bigger than "to"')).max(20),
  counter_hours: z.string().trim().max(120),
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
  counter_hours: 'Mon–Sat, 8:00 AM – 7:00 PM',
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
  // Older installs stored over_limit_action; BLOCK meant "no paid extra".
  if (stored.allow_paid_extra === undefined && stored.over_limit_action) stored.allow_paid_extra = stored.over_limit_action === 'CHARGE';
  const merged = { ...defaultSettings, ...stored };
  return Object.fromEntries(Object.keys(defaultSettings).map(k => [k, (merged as Record<string, unknown>)[k]])) as Settings;
}

export async function saveSettings(actorId: number, input: unknown): Promise<Settings> {
  return db.tx(async () => {
    const before = await getSettings();
    const next = parse(settingsSchema, { ...before, ...(input as object) });
    if (next.semester_start && next.semester_end && next.semester_start > next.semester_end) throw new HttpError(400, 'The semester start must be before its end.');
    const changed = (Object.keys(next) as (keyof Settings)[]).filter(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    for (const k of changed) {
      await db.run('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
        [k, JSON.stringify(next[k]), nowIso(), actorId]);
    }
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

/** "a 1002", "A-1002" → "A1002". */
export const normaliseCard = (v: string) => v.trim().toUpperCase().replace(/[\s-]/g, '').replace(/^([A-Z]{0,3})0+(?=\d)/, '$1');   // A012 = A12

/**
 * Check a basket card no. against the admin's card series (if any). Returns the clean card no.,
 * or null when none was given and none is required.
 */
export function checkCard(s: Settings, raw: string | undefined | null) {
  const v = normaliseCard(String(raw ?? ''));
  if (!v) {
    if (s.card_required) throw new HttpError(422, 'Enter the basket card no. (e.g. A1002).');
    return null;
  }
  if (!/^[A-Z]{0,3}\d{1,6}$/.test(v)) throw new HttpError(422, `“${v}” doesn't look like a card no. Use letters then numbers, e.g. A1002.`);
  if (s.card_series.length) {
    const m = /^([A-Z]{0,3})(\d+)$/.exec(v)!;
    const n = Number(m[2]);
    const ok = s.card_series.some(x => x.prefix === m[1] && n >= x.from && n <= x.to);
    if (!ok) throw new HttpError(422, `Card ${v} is not in the card series set by the admin (${s.card_series.map(x => `${x.prefix}${x.from}–${x.prefix}${x.to}`).join(', ')}).`);
  }
  return v;
}

/** Which open order (if any) is using this card right now. */
export async function cardInUse(card: string, exceptOrderId = 0) {
  return db.get<{ id: number; order_no: string; status: string }>(
    `SELECT id, order_no, status FROM orders WHERE tag_no = ? AND status IN ('RECEIVED','WASHING','READY') AND id != ?`, [card, exceptOrderId]);
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
  tagNo: z.string().trim().max(20).optional().default(''), // basket card no. written on the physical card
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
  const student = await studentForOrder(input.studentId);
  if (student.status === 'PENDING') throw new HttpError(409, `${student.name}'s registration is not approved yet. Verify the ID card and approve first.`);
  if (student.status !== 'ACTIVE' || !student.active) throw new HttpError(409, `${student.name}'s account is ${student.status.toLowerCase()}. Orders cannot be taken.`);
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
  const hours = express ? s.express_turnaround_hours : s.regular_turnaround_hours;
  return {
    student: { id: student.id, name: student.name, id_card_no: student.id_card_no, hostel_name: student.hostel_name, room_no: student.room_no, mobile: student.mobile },
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
    expected_at: new Date(Date.now() + hours * 3600_000).toISOString(),
    usage_after: {
      orders: usage.orders + (within > 0 ? 1 : 0),
      kg: round2(usage.kg + within),
      order_limit: s.monthly_order_limit,
      kg_limit: s.monthly_kg_limit,
    },
  };
}

/* ------------------------------------------------------------------ orders */

const orderNo = (n: number) => `EJ-${n}`;

export async function createOrder(actorId: number, input: OrderInput, requestId?: string) {
  return db.tx(async () => {
    // Serialise orders per student so the active/monthly limits hold under concurrent requests.
    await db.lockRow('users', Number(input.studentId));
    if (requestId) {
      const existing = await db.get<{ id: number; order_no: string }>('SELECT id, order_no FROM orders WHERE request_id = ?', [requestId]);
      if (existing) return { ...existing, duplicate: true };
    }
    const q = await quote(input);
    const no = orderNo(await nextCounter('order_no', 1001));
    const at = nowIso();
    const token = crypto.randomBytes(16).toString('base64url');
    const note = String(orderInput.parse(input).note || '') || null;
    const id = await insertId(`INSERT INTO orders (order_no, student_id, hostel_name, room_no, mobile, weight_kg, clothes_count, service, note,
        within_kg, extra_kg, amount, payment_status, qr_token, request_id, received_by, received_at, day_key, month_key, expected_at, updated_at,
        service_id, service_name, unit, rate, charge_note, plan_hosteler, tag_no)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      no, q.student.id, q.student.hostel_name, q.student.room_no, q.student.mobile, q.weight_kg, q.clothes_count, q.express ? 'EXPRESS' : 'REGULAR', note,
      q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? 'DUE' : 'NONE', token, requestId ?? null, actorId, at, dayKey(), monthKey(), q.expected_at, at,
      q.service.id, q.service.name, q.service.unit, q.service.rate, q.charge_note, q.plan.hosteler ? 1 : 0, q.tag_no,
    ]);
    const what = `${q.service.name}, ${q.clothes_count} clothes${q.weight_kg ? `, ${q.weight_kg} kg` : ''}${q.tag_no ? `, card ${q.tag_no}` : ''}`;
    await addEvent(id, 'RECEIVED', what, actorId);
    await notify(q.student.id, `Order ${no} received`, `${what}. Your digital slip is ready — keep it till pickup.${q.amount > 0 ? ` Amount due ₹${q.amount}.` : ''}`, id);
    await logActivity(actorId, 'ORDER_CREATED', 'order', no, `${q.student.id_card_no}, ${what}${q.amount ? `, ₹${q.amount}` : ''}`);
    return { id, order_no: no, duplicate: false };
  });
}

export async function addEvent(orderId: number, type: string, note: string | null, byUser: number | null) {
  await db.run('INSERT INTO order_events (order_id, type, note, by_user, at) VALUES (?,?,?,?,?)', [orderId, type, note, byUser, nowIso()]);
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
      if (status === 'RECEIVED' && !opts.allowBackToReceived) throw new HttpError(403, `${o.order_no} is already ${o.status.toLowerCase()}. Only the admin can move it back to received.`);
      const now = nowIso();
      await db.run('UPDATE orders SET status = ?, ready_at = ?, updated_at = ? WHERE id = ?', [status, status === 'READY' ? now : o.ready_at, now, id]);
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
    await db.run('UPDATE orders SET payment_status = ?, paid_method = ?, paid_ref = ?, paid_at = ?, paid_by = ?, updated_at = ? WHERE id = ?',
      [method === 'WAIVED' ? 'WAIVED' : 'PAID', method, ref || null, nowIso(), actorId, nowIso(), id]);
    await addEvent(id, method === 'WAIVED' ? 'PAYMENT_WAIVED' : 'PAID', method === 'WAIVED' ? ref || null : `₹${o.amount} via ${method}${ref ? `, ${ref}` : ''}`, actorId);
    await notify(o.student_id, method === 'WAIVED' ? `Payment waived for ${o.order_no}` : `Payment received for ${o.order_no}`, method === 'WAIVED' ? 'No payment is needed for this order.' : `₹${o.amount} received via ${method}. Thank you!`, id);
    await logActivity(actorId, method === 'WAIVED' ? 'PAYMENT_WAIVED' : 'PAYMENT_RECORDED', 'order', o.order_no, method === 'WAIVED' ? ref : `₹${o.amount} ${method} ${ref}`.trim());
  });
}

export async function deliverOrder(actorId: number, id: number, returnedCount: number, note: string) {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const s = await getSettings();
    const o = await getOrderRow(id);
    if (o.status === 'DELIVERED') throw new HttpError(409, `${o.order_no} was already handed over. Do not give clothes again.`);
    if (o.status === 'CANCELLED') throw new HttpError(409, `${o.order_no} was cancelled.`);
    if (s.pay_before_pickup && o.payment_status === 'DUE') throw new HttpError(409, `Collect ₹${o.amount} before handing over ${o.order_no}.`);
    if (returnedCount !== o.clothes_count && !note.trim()) throw new HttpError(422, `Count mismatch: ${o.clothes_count} given, ${returnedCount} returned. Add a note explaining why.`);
    const at = nowIso();
    if (o.status !== 'READY') await addEvent(id, 'READY', 'Marked ready at handover', actorId);
    await db.run(`UPDATE orders SET status = 'DELIVERED', ready_at = COALESCE(ready_at, ?), delivered_by = ?, delivered_at = ?, returned_count = ?, updated_at = ? WHERE id = ?`,
      [at, actorId, at, returnedCount, at, id]);
    await addEvent(id, 'DELIVERED', `${returnedCount} of ${o.clothes_count} clothes returned${note ? `, ${note}` : ''}`, actorId);
    await notify(o.student_id, `${o.order_no} handed over`, `${returnedCount} clothes returned. ${returnedCount !== o.clothes_count ? 'Count differed from drop-off — raise a complaint if something is missing.' : 'Thank you for using Everjoy Lawndry!'}`, id);
    await logActivity(actorId, 'ORDER_DELIVERED', 'order', o.order_no, `${returnedCount}/${o.clothes_count} clothes${note ? `, ${note}` : ''}`);
  });
}

export async function cancelOrder(actorId: number, id: number, reason: string) {
  await db.tx(async () => {
    await db.lockRow('orders', id);
    const o = await getOrderRow(id);
    if (!OPEN.includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()} and cannot be cancelled.`);
    await db.run(`UPDATE orders SET status = 'CANCELLED', cancel_reason = ?, payment_status = CASE WHEN payment_status = 'DUE' THEN 'NONE' ELSE payment_status END, updated_at = ? WHERE id = ?`, [reason, nowIso(), id]);
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
    await db.run(`UPDATE orders SET weight_kg = ?, clothes_count = ?, within_kg = ?, extra_kg = ?, amount = ?, payment_status = ?, charge_note = ?, updated_at = ? WHERE id = ?`,
      [q.weight_kg, q.clothes_count, q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? (o.payment_status === 'WAIVED' ? 'WAIVED' : 'DUE') : 'NONE', q.charge_note, nowIso(), id]);
    const detail = `${o.clothes_count}→${q.clothes_count} clothes, ${o.weight_kg}→${q.weight_kg} kg, ${reason}`;
    await addEvent(id, 'CORRECTED', detail, actorId);
    await notify(o.student_id, `${o.order_no} details corrected`, `Now ${q.clothes_count} clothes, ${q.weight_kg} kg. Reason: ${reason}`, id);
    await logActivity(actorId, 'ORDER_CORRECTED', 'order', o.order_no, detail);
  });
}
