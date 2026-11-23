import crypto from 'node:crypto';
import { z } from 'zod';
import { db, insertId, logActivity, nextCounter, notify } from './db.js';
import { HttpError, dayKey, monthKey, nowIso, parse, round2 } from './util.js';

/* ---------------------------------------------------------------- settings */

export const settingsSchema = z.object({
  max_kg_per_order: z.coerce.number().min(0.5).max(50),
  max_active_orders: z.coerce.number().int().min(0).max(20),        // 0 = no limit
  monthly_order_limit: z.coerce.number().int().min(0).max(100),     // 0 = no limit
  monthly_kg_limit: z.coerce.number().min(0).max(500),              // 0 = no limit
  over_limit_action: z.enum(['BLOCK', 'CHARGE']),
  regular_rate_per_kg: z.coerce.number().min(0).max(10000),         // within the monthly limit
  extra_rate_per_kg: z.coerce.number().min(0).max(10000),           // beyond the monthly limit (CHARGE)
  express_enabled: z.boolean(),
  express_fee: z.coerce.number().min(0).max(10000),
  regular_turnaround_hours: z.coerce.number().min(1).max(720),
  express_turnaround_hours: z.coerce.number().min(1).max(720),
  pay_before_pickup: z.boolean(),
  upi_id: z.string().trim().max(80),
  upi_name: z.string().trim().max(80),
  counter_hours: z.string().trim().max(120),
});
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  max_kg_per_order: 7,
  max_active_orders: 2,
  monthly_order_limit: 0,
  monthly_kg_limit: 0,
  over_limit_action: 'BLOCK',
  regular_rate_per_kg: 0,
  extra_rate_per_kg: 0,
  express_enabled: false,
  express_fee: 0,
  regular_turnaround_hours: 48,
  express_turnaround_hours: 24,
  pay_before_pickup: true,
  upi_id: '',
  upi_name: 'Everjoy Lawndry',
  counter_hours: 'Mon–Sat, 8:00 AM – 7:00 PM',
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
  return { ...defaultSettings, ...stored };
}

export async function saveSettings(actorId: number, input: unknown): Promise<Settings> {
  return db.tx(async () => {
    const before = await getSettings();
    const next = parse(settingsSchema, { ...before, ...(input as object) });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    for (const k of changed) {
      await db.run('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
        [k, JSON.stringify(next[k]), nowIso(), actorId]);
    }
    if (changed.length) await logActivity(actorId, 'SETTINGS_CHANGED', 'settings', null, changed.map(k => `${k}: ${before[k]} → ${next[k]}`).join('; '));
    return next;
  });
}

/* ------------------------------------------------------------------- usage */

export async function monthUsage(studentId: number, excludeOrderId = 0) {
  const row = (await db.get<{ orders: number; kg: number }>(`SELECT COUNT(*) AS orders, COALESCE(SUM(weight_kg), 0) AS kg FROM orders
    WHERE student_id = ? AND month_key = ? AND status != 'CANCELLED' AND id != ?`, [studentId, monthKey(), excludeOrderId]))!;
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

export const orderInput = z.object({
  studentId: z.coerce.number().int().positive(),
  weightKg: z.coerce.number({ error: 'Enter the weight in kg' }).positive('Weight must be more than 0 kg'),
  clothesCount: z.coerce.number({ error: 'Enter the number of clothes' }).int('Clothes count must be a whole number').min(1, 'Count at least 1 piece of clothing').max(300, 'Clothes count looks too high'),
  service: z.enum(['REGULAR', 'EXPRESS']).default('REGULAR'),
  note: z.string().trim().max(200).optional().default(''),
});
export type OrderInput = z.infer<typeof orderInput>;

type StudentRow = { id: number; name: string; mobile: string; active: number; status: string; room_no: string; hostel_name: string; id_card_no: string };

export async function studentForOrder(studentId: number): Promise<StudentRow> {
  const s = await db.get<StudentRow>(`SELECT u.id, u.name, u.mobile, u.active, st.status, st.room_no, st.id_card_no, h.name AS hostel_name
    FROM users u JOIN students st ON st.user_id = u.id JOIN hostels h ON h.id = st.hostel_id WHERE u.id = ?`, [studentId]);
  if (!s) throw new HttpError(404, 'Student not found.');
  return s;
}

/**
 * The single place where laundry rules are enforced. Staff never calculate limits
 * or prices by hand: the counter screen shows this result and the server re-runs
 * it inside the create transaction, so the saved order always matches the rules.
 */
export async function quote(input: OrderInput, excludeOrderId = 0) {
  const s = await getSettings();
  const student = await studentForOrder(input.studentId);
  if (student.status === 'PENDING') throw new HttpError(409, `${student.name}'s registration is not approved yet. Verify the ID card and approve first.`);
  if (student.status !== 'ACTIVE' || !student.active) throw new HttpError(409, `${student.name}'s account is ${student.status.toLowerCase()}. Orders cannot be taken.`);

  const weight = round2(input.weightKg);
  if (weight > s.max_kg_per_order) throw new HttpError(422, `Limit is ${s.max_kg_per_order} kg per order. This is ${weight} kg — please remove ${round2(weight - s.max_kg_per_order)} kg.`);
  if (input.service === 'EXPRESS' && !s.express_enabled) throw new HttpError(422, 'Express service is switched off.');

  const usage = await monthUsage(student.id, excludeOrderId);
  if (s.max_active_orders && usage.active >= s.max_active_orders) throw new HttpError(422, `${student.name} already has ${usage.active} order(s) in progress (limit ${s.max_active_orders}). Collect them first.`);
  if (s.monthly_order_limit && usage.orders >= s.monthly_order_limit) throw new HttpError(422, `Monthly limit reached: ${usage.orders} of ${s.monthly_order_limit} orders used this month.`);

  let within = weight;
  let extra = 0;
  if (s.monthly_kg_limit) {
    const left = Math.max(0, round2(s.monthly_kg_limit - usage.kg));
    if (weight > left) {
      if (s.over_limit_action === 'BLOCK') throw new HttpError(422, left > 0 ? `Only ${left} kg left this month (limit ${s.monthly_kg_limit} kg).` : `Monthly limit of ${s.monthly_kg_limit} kg is used up.`);
      within = left;
      extra = round2(weight - left);
    }
  }
  const amount = round2(within * s.regular_rate_per_kg + extra * s.extra_rate_per_kg + (input.service === 'EXPRESS' ? s.express_fee : 0));
  const hours = input.service === 'EXPRESS' ? s.express_turnaround_hours : s.regular_turnaround_hours;
  return {
    student: { id: student.id, name: student.name, id_card_no: student.id_card_no, hostel_name: student.hostel_name, room_no: student.room_no, mobile: student.mobile },
    weight_kg: weight,
    clothes_count: input.clothesCount,
    service: input.service,
    within_kg: round2(within),
    extra_kg: extra,
    amount,
    breakdown: {
      regular: round2(within * s.regular_rate_per_kg),
      extra: round2(extra * s.extra_rate_per_kg),
      express: input.service === 'EXPRESS' ? s.express_fee : 0,
    },
    expected_at: new Date(Date.now() + hours * 3600_000).toISOString(),
    usage_after: {
      orders: usage.orders + 1,
      kg: round2(usage.kg + weight),
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
    await db.lockRow('users', input.studentId);
    if (requestId) {
      const existing = await db.get<{ id: number; order_no: string }>('SELECT id, order_no FROM orders WHERE request_id = ?', [requestId]);
      if (existing) return { ...existing, duplicate: true };
    }
    const q = await quote(input);
    const no = orderNo(await nextCounter('order_no', 1001));
    const at = nowIso();
    const token = crypto.randomBytes(16).toString('base64url');
    const id = await insertId(`INSERT INTO orders (order_no, student_id, hostel_name, room_no, mobile, weight_kg, clothes_count, service, note,
        within_kg, extra_kg, amount, payment_status, qr_token, request_id, received_by, received_at, day_key, month_key, expected_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      no, q.student.id, q.student.hostel_name, q.student.room_no, q.student.mobile, q.weight_kg, q.clothes_count, q.service, input.note || null,
      q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? 'DUE' : 'NONE', token, requestId ?? null, actorId, at, dayKey(), monthKey(), q.expected_at, at,
    ]);
    await addEvent(id, 'RECEIVED', `${q.clothes_count} clothes, ${q.weight_kg} kg`, actorId);
    await notify(q.student.id, `Order ${no} received`, `${q.clothes_count} clothes, ${q.weight_kg} kg. Your digital slip is ready — keep it till pickup.${q.amount > 0 ? ` Amount due ₹${q.amount}.` : ''}`, id);
    await logActivity(actorId, 'ORDER_CREATED', 'order', no, `${q.student.id_card_no}, ${q.clothes_count} clothes, ${q.weight_kg} kg${q.amount ? `, ₹${q.amount}` : ''}`);
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

export async function setStatus(actorId: number, ids: number[], status: 'RECEIVED' | 'WASHING' | 'READY') {
  return db.tx(async () => {
    // Lock every order up front, in id order, so two overlapping batch updates can't deadlock on Postgres.
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) await db.lockRow('orders', id);
    let changed = 0;
    for (const id of ids) {
      const o = await getOrderRow(id);
      if (!OPEN.includes(o.status)) throw new HttpError(409, `${o.order_no} is ${o.status.toLowerCase()} and cannot be changed.`);
      if (o.status === status) continue;
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
    const o = await db.get<OrderRow & { weight_kg: number; service: 'REGULAR' | 'EXPRESS'; payment_status: string }>('SELECT * FROM orders WHERE id = ?', [id]);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (!OPEN.includes(o.status)) throw new HttpError(409, 'Only orders still in progress can be corrected.');
    if (o.payment_status === 'PAID') throw new HttpError(409, 'This order is already paid; cancel and recreate it instead.');
    // Same per-student lock as createOrder, so a correction and a new order can't both pass the monthly limits.
    await db.lockRow('users', o.student_id);
    const q = await quote({ studentId: o.student_id, weightKg, clothesCount, service: o.service, note: '' }, id);
    await db.run(`UPDATE orders SET weight_kg = ?, clothes_count = ?, within_kg = ?, extra_kg = ?, amount = ?, payment_status = ?, updated_at = ? WHERE id = ?`,
      [q.weight_kg, q.clothes_count, q.within_kg, q.extra_kg, q.amount, q.amount > 0 ? (o.payment_status === 'WAIVED' ? 'WAIVED' : 'DUE') : 'NONE', nowIso(), id]);
    const detail = `${o.clothes_count}→${q.clothes_count} clothes, ${o.weight_kg}→${q.weight_kg} kg, ${reason}`;
    await addEvent(id, 'CORRECTED', detail, actorId);
    await notify(o.student_id, `${o.order_no} details corrected`, `Now ${q.clothes_count} clothes, ${q.weight_kg} kg. Reason: ${reason}`, id);
    await logActivity(actorId, 'ORDER_CORRECTED', 'order', o.order_no, detail);
  });
}
