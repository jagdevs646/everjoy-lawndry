import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';

const app = await createApp();
type Agent = ReturnType<typeof request.agent>;

/** A signed-in browser: keeps the session cookie and sends the CSRF header. */
async function signIn(loginId: string, password: string): Promise<Agent> {
  const a = request.agent(app);
  const res = await a.post('/api/auth/login').set('x-ej', '1').send({ loginId, password });
  expect(res.status, res.body.error).toBe(200);
  return a;
}
/** A one-sheet .xlsx with a header row taken from the first row's keys. */
async function xlsx(rows: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const header = Object.keys(rows[0]);
  ws.addRow(header);
  rows.forEach(r => ws.addRow(header.map(h => r[h])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const post = (a: Agent, url: string, body: object = {}) => a.post(url).set('x-ej', '1').send(body);
const put = (a: Agent, url: string, body: object) => a.put(url).set('x-ej', '1').send(body);

let admin: Agent;
let staff: Agent;
let hostelId: number;
let seq = 100;

/** Self sign-up, then the counter approves after checking the university portal. */
async function newStudent(approve = true) {
  const idCardNo = `TST${++seq}`;
  const a = request.agent(app);
  const res = await post(a, '/api/auth/signup', { idCardNo, name: `Student ${seq}`, mobile: `98765${String(seq).padStart(5, '0')}`, hostelId, roomNo: `${seq}`, password: 'secret12' });
  expect(res.status, res.body.error).toBe(201);
  const id = res.body.user.id as number;
  if (approve) expect((await post(staff, `/api/ops/students/${id}/review`, { decision: 'APPROVE' })).status).toBe(200);
  return { agent: a, id, idCardNo };
}
const order = (studentId: number, weightKg = 4, clothesCount = 10, extra: object = {}) =>
  post(staff, '/api/ops/orders', { studentId, weightKg, clothesCount, service: 'REGULAR', ...extra });

/** First sign-in with a temporary password: the server allows nothing until a new one is chosen. */
async function firstSignIn(loginId: string, temp: string, next: string) {
  const a = await signIn(loginId, temp);
  expect((await a.get('/api/ops/summary')).body.details?.code).toBe('MUST_CHANGE_PASSWORD');
  const r = await post(a, '/api/auth/password', { current: temp, next });
  expect(r.status, r.body.error).toBe(200);
  return a;
}

beforeAll(async () => {
  admin = await firstSignIn('admin', 'Everjoy@123', 'Admin-pass-2026');   // login id is case-insensitive
  const h = await post(admin, '/api/admin/hostels', { name: 'Test Hostel' });
  hostelId = h.body.id;
  expect((await post(admin, '/api/admin/staff', { name: 'Counter One', loginId: 'counter1', password: 'counter-pass', role: 'STAFF' })).status).toBe(201);
  staff = await firstSignIn('COUNTER1', 'counter-pass', 'counter-pass-2');
});

describe('security', () => {
  it('blocks state changes without the CSRF header', async () => {
    const res = await request(app).post('/api/auth/login').send({ loginId: 'ADMIN', password: 'Admin-pass-2026' });
    expect(res.status).toBe(403);
  });

  it('keeps each role inside its own area', async () => {
    const { agent } = await newStudent();
    expect((await agent.get('/api/ops/orders')).status).toBe(403);
    expect((await agent.get('/api/admin/settings')).status).toBe(403);
    expect((await staff.get('/api/admin/settings')).status).toBe(403);
    expect((await request(app).get('/api/me/home')).status).toBe(401);
  });

  it('never shows one student another student’s slip', async () => {
    const a = await newStudent();
    const b = await newStudent();
    const o = await order(a.id);
    expect((await a.agent.get(`/api/me/orders/${o.body.id}`)).body.qr_token).toBeTruthy();
    expect((await b.agent.get(`/api/me/orders/${o.body.id}`)).status).toBe(404);
    expect((await staff.get(`/api/ops/orders/${o.body.id}`)).body.qr_token).toBeUndefined();
  });

  it('a password reset signs the student out everywhere and forces a new password', async () => {
    const s = await newStudent();
    const reset = await post(staff, `/api/ops/students/${s.id}/reset-password`);
    expect(reset.body.tempPassword).toMatch(/^[a-z]+-[A-Z]{4}-\d{4}$/);
    expect((await s.agent.get('/api/me/home')).status).toBe(401);
    const fresh = await signIn(s.idCardNo, reset.body.tempPassword);
    expect((await fresh.get('/api/auth/me')).body.user.must_change_password).toBe(true);
    expect((await fresh.get('/api/me/home')).status).toBe(403);   // nothing else until a new password is chosen
    expect((await post(fresh, '/api/auth/password', { current: reset.body.tempPassword, next: 'brand-new' })).status).toBe(200);
    expect((await fresh.get('/api/auth/me')).body.user.must_change_password).toBe(false);
  });
});

describe('registration', () => {
  it('a new sign-up waits for approval before laundry can be taken', async () => {
    const s = await newStudent(false);
    const lookup = await staff.get(`/api/ops/students/lookup?code=${s.idCardNo.toLowerCase()}`);
    expect(lookup.body.student.status).toBe('PENDING');
    expect((await order(s.id)).status).toBe(409);
    await post(staff, `/api/ops/students/${s.id}/review`, { decision: 'APPROVE' });
    expect((await order(s.id)).status).toBe(201);
  });

  it('rejects duplicate ID cards and needs a reason to reject', async () => {
    const s = await newStudent(false);
    const dup = await post(request.agent(app), '/api/auth/signup', { idCardNo: s.idCardNo, name: 'Copy Cat', mobile: '9999988888', hostelId, roomNo: '1', password: 'secret12' });
    expect(dup.status).toBe(409);
    expect((await post(staff, `/api/ops/students/${s.id}/review`, { decision: 'REJECT' })).status).toBe(400);
    expect((await post(staff, `/api/ops/students/${s.id}/review`, { decision: 'REJECT', note: 'ID not on portal' })).status).toBe(200);
    // Student fixes details → back to pending
    const fix = await s.agent.patch('/api/me/profile').set('x-ej', '1').send({ mobile: '9123456780', hostelId, roomNo: '12', name: 'Fixed Name' });
    expect(fix.body.status).toBe('PENDING');
  });
});

describe('orders at the counter', () => {
  it('enforces the 7 kg limit and gives unique, sequential order numbers', async () => {
    const s = await newStudent();
    const heavy = await order(s.id, 7.2);
    expect(heavy.status).toBe(422);
    expect(heavy.body.error).toContain('7 kg');
    expect(heavy.body.details).toMatchObject({ code: 'OVER_LIMIT', keep_kg: 7, can_charge: true });
    const a = await order(s.id, 7);
    const b = await order(s.id, 1.5);
    expect(a.status).toBe(201);
    expect(Number(b.body.order_no.slice(3))).toBe(Number(a.body.order_no.slice(3)) + 1);
  });

  it('a double tap with the same request id creates only one order', async () => {
    const s = await newStudent();
    const first = await order(s.id, 3, 8, { requestId: 'req-abcdef-123' });
    const again = await order(s.id, 3, 8, { requestId: 'req-abcdef-123' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('limits orders in progress per student', async () => {
    const s = await newStudent();
    await order(s.id); await order(s.id);
    const third = await order(s.id);
    expect(third.status).toBe(422);
    expect(third.body.error).toContain('in progress');
  });
});

describe('pickup with the digital slip', () => {
  it('scans the QR, checks the clothes count, and cannot hand over twice', async () => {
    const s = await newStudent();
    const o = await order(s.id, 3, 12);
    const slip = await s.agent.get(`/api/me/orders/${o.body.id}`);
    expect((await post(staff, '/api/ops/scan', { code: 'EJ:not-a-real-token' })).status).toBe(404);
    const scanned = await post(staff, '/api/ops/scan', { code: `EJ:${slip.body.qr_token}` });
    expect(scanned.body.order_no).toBe(o.body.order_no);
    expect(scanned.body.via).toBe('QR');
    await post(staff, '/api/ops/orders/status', { ids: [o.body.id], status: 'READY' });
    expect((await post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 11 })).status).toBe(422);
    const done = await post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 11, note: 'Student took 1 item earlier' });
    expect(done.body.status).toBe('DELIVERED');
    expect((await post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 12 })).status).toBe(409);
    const notes = await s.agent.get('/api/notifications');
    expect(notes.body.rows.map((n: { title: string }) => n.title).join(' ')).toContain('ready for pickup');
  });

  it('staff can find the order by number when the phone is dead', async () => {
    const s = await newStudent();
    const o = await order(s.id);
    const found = await post(staff, '/api/ops/scan', { code: o.body.order_no.replace('EJ-', '') });
    expect(found.body.id).toBe(o.body.id);
    expect(found.body.via).toBe('NUMBER');
  });
});

describe('monthly limits and pricing', () => {
  it('over the free limit: the counter either removes kg or charges for them', async () => {
    await put(admin, '/api/admin/settings', { monthly_kg_limit: 10, allow_paid_extra: false, max_active_orders: 0 });
    const s = await newStudent();
    expect((await order(s.id, 6)).status).toBe(201);
    const blocked = await order(s.id, 5);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toContain('4 kg left');
    expect(blocked.body.details).toMatchObject({ code: 'OVER_LIMIT', extra_kg: 1, keep_kg: 4, can_charge: false });
    expect((await order(s.id, 5, 10, { acceptExtra: true })).status).toBe(422);   // charging is switched off

    await put(admin, '/api/admin/settings', { allow_paid_extra: true, extra_rate_per_kg: 20 });
    const ask = await order(s.id, 5);
    expect(ask.status).toBe(422);
    expect(ask.body.details).toMatchObject({ code: 'OVER_LIMIT', extra_kg: 1, extra_charge: 20, can_charge: true });
    const charged = await order(s.id, 5, 10, { acceptExtra: true });
    expect(charged.status, charged.body.error).toBe(201);
    expect(charged.body.extra_kg).toBe(1);
    expect(charged.body.amount).toBe(20);
    expect(charged.body.payment_status).toBe('DUE');
    expect(charged.body.charge_note).toContain('1 kg over');
    expect((await post(staff, `/api/ops/orders/${charged.body.id}/deliver`, { returnedCount: 10 })).status).toBe(409);
    const paidAndDone = await post(staff, `/api/ops/orders/${charged.body.id}/deliver`, { returnedCount: 10, payMethod: 'UPI', payRef: 'UTR123' });
    expect(paidAndDone.body.status).toBe('DELIVERED');
    expect(paidAndDone.body.payment_status).toBe('PAID');

    await put(admin, '/api/admin/settings', { monthly_kg_limit: 0, allow_paid_extra: true, extra_rate_per_kg: 20, max_active_orders: 2 });
  });

  it('settings are validated and changes are logged', async () => {
    expect((await put(admin, '/api/admin/settings', { max_kg_per_order: -1 })).status).toBe(400);
    await put(admin, '/api/admin/settings', { max_kg_per_order: 8 });
    await put(admin, '/api/admin/settings', { max_kg_per_order: 7 });
    const log = await admin.get('/api/admin/activity?q=SETTINGS');
    expect(log.body.rows[0].detail).toContain('max_kg_per_order: 8 → 7');
  });
});

describe('corrections and cancellations', () => {
  it('staff can fix a fresh order but not one already washing', async () => {
    const s = await newStudent();
    const o = await order(s.id, 4, 10);
    const fixed = await staff.patch(`/api/ops/orders/${o.body.id}`).set('x-ej', '1').send({ weightKg: 4.5, clothesCount: 11, reason: 'Re-weighed' });
    expect(fixed.body.clothes_count).toBe(11);
    await post(staff, '/api/ops/orders/status', { ids: [o.body.id], status: 'WASHING' });
    expect((await post(staff, `/api/ops/orders/${o.body.id}/cancel`, { reason: 'Mistake' })).status).toBe(403);
    expect((await post(admin, `/api/ops/orders/${o.body.id}/cancel`, { reason: 'Student request' })).body.status).toBe('CANCELLED');
  });
});

describe('complaints, announcements, export', () => {
  it('student raises a complaint on their own order and sees the reply', async () => {
    const s = await newStudent();
    const o = await order(s.id);
    const c = await s.agent.post('/api/me/complaints').set('x-ej', '1').field('orderId', String(o.body.id)).field('category', 'Missing clothes').field('description', 'Blue shirt missing');
    expect(c.status, c.body.error).toBe(201);
    await post(staff, `/api/ops/complaints/${c.body.id}/update`, { status: 'RESOLVED', message: 'Found it, please collect.' });
    const mine = await s.agent.get('/api/me/complaints');
    expect(mine.body.rows[0].status).toBe('RESOLVED');
    expect(mine.body.rows[0].updates.at(-1).message).toBe('Found it, please collect.');
  });

  it('announcements reach every active student', async () => {
    const s = await newStudent();
    await post(admin, '/api/admin/announcements', { title: 'Closed Sunday', body: 'Machine servicing day.' });
    const home = await s.agent.get('/api/me/home');
    expect(home.body.announcements[0].title).toBe('Closed Sunday');
    expect(home.body.unread).toBeGreaterThan(0);
  });

  it('exports the register to Excel', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const res = await admin.get(`/api/admin/export?from=${from}&to=${to}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect((await admin.get(`/api/admin/report?from=${today}&to=${to}`)).body.totals.orders).toBeGreaterThan(0);
  });
});

describe('Android / iOS app sign-in', () => {
  const appLogin = (loginId: string, password: string) =>
    request(app).post('/api/auth/login').set({ 'x-ej': '1', 'x-ej-client': 'app' }).send({ loginId, password });

  it('gives the app a bearer token instead of a cookie, and the token works', async () => {
    const s = await newStudent();
    await appLogin(s.idCardNo, 'secret12')
      .then(async res => {
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.headers['set-cookie']).toBeUndefined();
        const home = await request(app).get('/api/me/home').set('Authorization', `Bearer ${res.body.token}`);
        expect(home.status).toBe(200);
      });
  });

  it('the website login still uses only the cookie', async () => {
    const res = await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: 'COUNTER1', password: 'counter-pass-2' });
    expect(res.body.token).toBeUndefined();
    expect(String(res.headers['set-cookie'])).toContain('ej_session=');
  });

  it('answers CORS preflight only for the app origins, never with credentials', async () => {
    const ok = await request(app).options('/api/me/home').set({ Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,x-ej' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(ok.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('an app token stops working after a password change on another device', async () => {
    const s = await newStudent();
    const first = await appLogin(s.idCardNo, 'secret12');
    const changed = await request(app).post('/api/auth/password').set({ 'x-ej': '1', 'x-ej-client': 'app', Authorization: `Bearer ${first.body.token}` }).send({ current: 'secret12', next: 'secret34' });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();
    expect((await request(app).get('/api/me/home').set('Authorization', `Bearer ${first.body.token}`)).status).toBe(401);
    expect((await request(app).get('/api/me/home').set('Authorization', `Bearer ${changed.body.token}`)).status).toBe(200);
  });

  it('rejects a tampered token', async () => {
    const res = await request(app).get('/api/me/home').set('Authorization', 'Bearer abc.def.ghi');
    expect(res.status).toBe(401);
  });
});

describe('login rate limits', () => {
  it('limits guesses per account even when the attacker rotates X-Forwarded-For', async () => {
    const s = await newStudent();
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await request(app).post('/api/auth/login').set({ 'x-ej': '1', 'X-Forwarded-For': `203.0.113.${i}` }).send({ loginId: s.idCardNo, password: `wrong-${i}` });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
    // The real student is also blocked for a while: the account is protected, not the attacker's IP.
    expect((await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: s.idCardNo, password: 'secret12' })).status).toBe(429);
  });
});

describe('hosting-safe storage and concurrency', () => {
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  it('keeps complaint photos in the database and shows them only to the owner and staff', async () => {
    const owner = await newStudent();
    const other = await newStudent();
    const o = await order(owner.id);
    const c = await owner.agent.post('/api/me/complaints').set('x-ej', '1')
      .field('orderId', String(o.body.id)).field('category', 'Damaged clothes').field('description', 'Torn sleeve on the blue shirt')
      .attach('photo', png, { filename: 'tear.png', contentType: 'image/png' });
    expect(c.status, c.body.error).toBe(201);
    const name = c.body.photo as string;
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    const mine = await owner.agent.get(`/api/files/${name}`);
    expect(mine.status).toBe(200);
    expect(Buffer.compare(mine.body as Buffer, png)).toBe(0);
    expect((await other.agent.get(`/api/files/${name}`)).status).toBe(403);
    expect((await staff.get(`/api/files/${name}`)).status).toBe(200);
  });

  it('two counters handing over the same slip at once: only one succeeds', async () => {
    const s = await newStudent();
    const o = await order(s.id, 3, 9);
    await post(staff, '/api/ops/orders/status', { ids: [o.body.id], status: 'READY' });
    const [a, b] = await Promise.all([
      post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 9 }),
      post(admin, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 9 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('parallel orders for one student still respect the in-progress limit', async () => {
    const s = await newStudent();
    const results = await Promise.all([1, 2, 3, 4].map(() => order(s.id, 2, 5)));
    const ok = results.filter(r => r.status === 201).length;
    expect(ok).toBe(2);   // max_active_orders = 2
  });
});

describe('odd input behaves the same on SQLite and Postgres', () => {
  it('search treats % and backslash literally and never errors', async () => {
    const all = await staff.get('/api/ops/orders?limit=500');
    expect(all.body.total).toBeGreaterThan(0);
    const pct = await staff.get(`/api/ops/orders?q=${encodeURIComponent('%')}`);
    expect(pct.status).toBe(200);
    expect(pct.body.total).toBe(0);
    expect((await staff.get(`/api/ops/orders?q=${encodeURIComponent('a\b')}`)).status).toBe(200);
    expect((await staff.get(`/api/ops/students?q=${encodeURIComponent('_')}`)).body.total).toBe(0);
    expect((await admin.get(`/api/admin/activity?q=${encodeURIComponent('%')}`)).status).toBe(200);
  });

  it('rejects impossible ids, decimals and NUL characters with 4xx, not 500', async () => {
    expect((await staff.get('/api/ops/orders/3000000000')).status).toBe(400);
    expect((await staff.get('/api/ops/students?hostelId=1.5')).status).toBe(400);
    expect((await staff.get('/api/ops/orders?limit=2.5')).status).toBe(400);
    const nul = await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: 'ADMIN\u0000', password: 'x' });
    expect(nul.status).toBeGreaterThanOrEqual(400);
    expect(nul.status).toBeLessThan(500);
  });

  it('a duplicate hostel name (any case) is a 409', async () => {
    expect((await post(admin, '/api/admin/hostels', { name: 'Ruby Block' })).status).toBe(201);
    expect((await post(admin, '/api/admin/hostels', { name: 'ruby block' })).status).toBe(409);
  });
});

describe('room changes need staff approval', () => {
  it('an approved student’s new room waits until the counter approves it', async () => {
    const s = await newStudent();
    const asked = await s.agent.patch('/api/me/profile').set('x-ej', '1').send({ mobile: '9876500999', hostelId, roomNo: '512' });
    expect(asked.status, asked.body.error).toBe(200);
    expect(asked.body.room_no).not.toBe('512');
    expect(asked.body.pending_room_no).toBe('512');
    const list = await staff.get('/api/ops/room-changes');
    expect(list.body.rows.some((r: { id: number }) => r.id === s.id)).toBe(true);
    expect((await post(staff, `/api/ops/students/${s.id}/room-change`, { decision: 'REJECT' })).status).toBe(400);   // needs a reason
    const ok = await post(staff, `/api/ops/students/${s.id}/room-change`, { decision: 'APPROVE' });
    expect(ok.body.room_no).toBe('512');
    expect(ok.body.pending_room_no).toBeNull();
    expect((await post(staff, `/api/ops/students/${s.id}/room-change`, { decision: 'APPROVE' })).status).toBe(409);
  });
});

describe('services, plans and walk-ins', () => {
  const svc = async (name: string) => ((await staff.get('/api/services')).body.rows as { id: number; name: string }[]).find(r => r.name === name)!;

  it('each service has its own price; hostelers get their rate', async () => {
    const s = await newStudent();
    const iron = await svc('Ironing only');
    const ironed = await order(s.id, 0, 6, { serviceId: iron.id });
    expect(ironed.status, ironed.body.error).toBe(201);
    expect(ironed.body.service_name).toBe('Ironing only');
    expect(ironed.body.amount).toBe(60);
    const both = await order(s.id, 4, 10, { serviceId: (await svc('Wash + iron')).id });
    expect(both.body.amount).toBe(80);   // ₹20/kg for hostelers
  });

  it('admin adds and edits services; names stay unique', async () => {
    const made = await post(admin, '/api/admin/services', { name: 'Blanket wash', unit: 'PIECE', rate: 120, hosteler_rate: 100 });
    expect(made.status, made.body.error).toBe(201);
    expect((await post(admin, '/api/admin/services', { name: 'blanket WASH', unit: 'PIECE', rate: 1, hosteler_rate: 1 })).status).toBe(409);
    const edited = await admin.patch(`/api/admin/services/${made.body.id}`).set('x-ej', '1').send({ rate: 150 });
    expect(edited.status, edited.body.error).toBe(200);
    expect((await svc('Blanket wash') as unknown as { rate: number }).rate).toBe(150);
    expect((await staff.post('/api/admin/services').set('x-ej', '1').send({ name: 'X', unit: 'KG', rate: 1, hosteler_rate: 1 })).status).toBe(403);
  });

  it('after the hostel plan ends the student pays normal prices', async () => {
    const s = await newStudent();
    const set = await post(admin, '/api/admin/students/validity', { scope: 'IDS', ids: [s.id], validUntil: '2020-01-31' });
    expect(set.body.changed).toBe(1);
    const o = await order(s.id, 4, 10);
    expect(o.status, o.body.error).toBe(201);
    expect(o.body.amount).toBe(120);   // wash & fold at ₹30/kg
    expect(o.body.charge_note).toContain('plan ended');
    expect((await staff.patch(`/api/ops/students/${s.id}`).set('x-ej', '1').send({ name: 'X Y', idCardNo: s.idCardNo, mobile: '9876500998', hostelId, roomNo: '1', validUntil: '' })).status).toBe(403);
  });

  it('staff can serve an unregistered walk-in, who pays normal prices', async () => {
    const w = await post(staff, '/api/ops/walk-in', { name: 'Guest Person', mobile: '9123456780' });
    expect(w.status, w.body.error).toBe(201);
    expect(w.body.kind).toBe('WALKIN');
    const again = await post(staff, '/api/ops/walk-in', { name: 'Guest Person', mobile: '+91 91234 56780' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(w.body.id);
    const o = await order(w.body.id, 2, 5);
    expect(o.body.amount).toBe(60);
    expect((await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: 'WALKIN-9123456780', password: 'anything' })).status).toBe(401);
  });
});

describe('UPI QR', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  it('admin uploads the QR; signed-in users can see it', async () => {
    const s = await newStudent();
    expect((await s.agent.get('/api/upi-qr')).status).toBe(404);
    const up = await admin.post('/api/admin/upi-qr').set('x-ej', '1').attach('qr', png, { filename: 'qr.png', contentType: 'image/png' });
    expect(up.status, up.body.error).toBe(201);
    const img = await s.agent.get('/api/upi-qr');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect((await s.agent.get('/api/me/home')).body.info.has_upi_qr).toBe(true);
    expect((await request(app).get('/api/upi-qr')).status).toBe(401);
  });
});

describe('Excel import', () => {
  const sheet = (rows: Record<string, unknown>[]) => xlsx(rows);
  const upload = async (type: string, b: Buffer | Promise<Buffer>) => { const buf = await b; return admin.post(`/api/admin/import/${type}`).set('x-ej', '1').attach('file', buf, { filename: 'list.xlsx' }); };

  it('gives a template with the right headers', async () => {
    const res = await admin.get('/api/admin/import/template/students').buffer(true).parse((r, cb) => { const d: Buffer[] = []; r.on('data', (c: Buffer) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer as unknown as ArrayBuffer);
    expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(['ID Card No', 'Full Name', 'Mobile', 'Hostel', 'Room', 'Valid Until']);
  });

  it('imports nothing if any row is wrong, and lists the rows', async () => {
    const res = await upload('students', sheet([
      { 'ID Card No': 'IMP001', 'Full Name': 'Good Row', 'Mobile': '9811100001', 'Hostel': 'Test Hostel', 'Room': '1', 'Valid Until': '' },
      { 'ID Card No': 'IMP002', 'Full Name': 'Bad Row', 'Mobile': '12345', 'Hostel': 'Test Hostel', 'Room': '2', 'Valid Until': '' },
    ]));
    expect(res.status).toBe(422);
    expect(res.body.details.errors[0].row).toBe(3);
    expect((await staff.get('/api/ops/students?q=IMP001')).body.total).toBe(0);
  });

  it('imported students claim their account with ID card no. and mobile', async () => {
    const res = await upload('students', sheet([
      { 'ID Card No': 'imp010', 'Full Name': 'Imported One', 'Mobile': '9811100010', 'Hostel': 'Import Block', 'Room': '7', 'Valid Until': '31/05/2027' },
    ]));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 0, newHostels: ['Import Block'] });
    const card = (await staff.get('/api/ops/students?q=IMP010')).body.rows[0];
    expect(card).toMatchObject({ status: 'ACTIVE', valid_until: '2027-05-31', claimable: 1 });

    const hostels = (await request(app).get('/api/public/info')).body.hostels as { id: number }[];
    const wrong = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'IMP010', name: 'Someone', mobile: '9811100099', hostelId: hostels[0].id, roomNo: '1', password: 'secret12' });
    expect(wrong.status).toBe(409);
    // Knowing the ID card no. and mobile is not enough: the office's one-time claim code is needed.
    const noCode = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'IMP010', name: 'Imported One', mobile: '9811100010', hostelId: hostels[0].id, roomNo: '7', password: 'secret12' });
    expect(noCode.status).toBe(409);
    expect(noCode.body.details.code).toBe('CLAIM_CODE');
    const code = (res.body.codes as { idCardNo: string; code: string }[]).find(c => c.idCardNo === 'IMP010')!.code;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const claim = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'IMP010', name: 'Imported One', mobile: '9811100010', hostelId: hostels[0].id, roomNo: '7', password: 'secret12', claimCode: code.toLowerCase().replace('-', ' ') });
    expect(claim.status, claim.body.error).toBe(200);
    const reuse = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'IMP010', name: 'Imported One', mobile: '9811100010', hostelId: hostels[0].id, roomNo: '7', password: 'other123', claimCode: code });
    expect(reuse.status).toBe(409);   // claimed once: the code is gone
    expect(claim.body.claimed).toBe(true);
    await signIn('IMP010', 'secret12');

    // A real Excel date cell and a mobile typed as a number both work.
    const again = await upload('students', sheet([{ 'ID Card No': 'IMP010', 'Full Name': 'Imported One', 'Mobile': 9811100010, 'Hostel': 'Import Block', 'Room': 8, 'Valid Until': new Date(Date.UTC(2027, 10, 30)) }]));
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
    expect((await staff.get('/api/ops/students?q=IMP010')).body.rows[0]).toMatchObject({ room_no: '8', valid_until: '2027-11-30' });
  });

  it('imports staff with temporary passwords', async () => {
    const res = await upload('staff', sheet([{ 'Full Name': 'Imported Staff', 'Username': 'impstaff', 'Mobile': '', 'Role': 'staff' }]));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acc = res.body.accounts[0];
    expect(acc.username).toBe('IMPSTAFF');
    const a = await signIn('IMPSTAFF', acc.tempPassword);
    expect((await a.get('/api/auth/me')).body.user.must_change_password).toBeTruthy();
    expect((await upload('staff', sheet([{ 'Full Name': 'Again', 'Username': 'IMPSTAFF', 'Mobile': '', 'Role': 'STAFF' }]))).status).toBe(422);
  });
});

describe('staff work report', () => {
  it('shows what one counter person did', async () => {
    const list = (await admin.get('/api/admin/staff')).body.rows as { id: number; login_id: string; month_collected: number; last_active: string | null }[];
    const me = list.find(r => r.login_id === 'COUNTER1')!;
    expect(me.last_active).toBeTruthy();
    const r = await admin.get(`/api/admin/staff/${me.id}/report?from=2020-01-01&to=2099-12-31`);
    expect(r.status, r.body.error).toBe(200);
    expect(Number(r.body.taken.orders)).toBeGreaterThan(3);
    expect(Number(r.body.delivered.orders)).toBeGreaterThan(0);
    expect(Number(r.body.money.upi)).toBeGreaterThanOrEqual(20);
    expect(Number(r.body.approvals.approved)).toBeGreaterThan(3);
    expect((await admin.get(`/api/admin/staff/${me.id}/report?from=2026-02-01&to=2026-01-01`)).status).toBe(400);
  });
});

describe('review fixes', () => {
  const svcId = async (name: string) => ((await staff.get('/api/services')).body.rows as { id: number; name: string }[]).find(r => r.name === name)?.id
    ?? ((await admin.get('/api/admin/services')).body.rows as { id: number; name: string }[]).find(r => r.name === name)!.id;

  it('a correction keeps the price the order was taken with, even after the plan ends', async () => {
    const s = await newStudent();
    const o = await order(s.id, 4, 10);
    expect(o.body.amount).toBe(0);
    await post(admin, '/api/admin/students/validity', { scope: 'IDS', ids: [s.id], validUntil: '2020-01-31' });
    const fixed = await staff.patch(`/api/ops/orders/${o.body.id}`).set('x-ej', '1').send({ weightKg: 4, clothesCount: 11, reason: 'Recount' });
    expect(fixed.status, fixed.body.error).toBe(200);
    expect(fixed.body.amount).toBe(0);
    expect(fixed.body.payment_status).toBe('NONE');
  });

  it('orders of a hidden service can still be corrected', async () => {
    const id = await svcId('Dry cleaning');
    const s = await newStudent();
    const o = await order(s.id, 0, 2, { serviceId: id });
    await admin.patch(`/api/admin/services/${id}`).set('x-ej', '1').send({ active: false });
    const fixed = await staff.patch(`/api/ops/orders/${o.body.id}`).set('x-ej', '1').send({ weightKg: 0, clothesCount: 3, reason: 'Recount' });
    expect(fixed.status, fixed.body.error).toBe(200);
    expect(fixed.body.amount).toBe(240);
    expect((await order(s.id, 0, 1, { serviceId: id })).status).toBe(422);
    await admin.patch(`/api/admin/services/${id}`).set('x-ej', '1').send({ active: true });
  });

  it('impossible dates are refused', async () => {
    expect((await post(admin, '/api/admin/students/validity', { scope: 'ALL', validUntil: '2027-02-30' })).status).toBe(400);
    expect((await admin.get('/api/admin/staff/1/report?from=2026-13-01&to=2026-12-31')).status).toBe(400);
  });

  it('WALKIN- ids are reserved, and a walk-in mobile never returns another account', async () => {
    const res = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'WALKIN-9000000001', name: 'Sneaky', mobile: '9000000001', hostelId, roomNo: '1', password: 'secret12' });
    expect(res.status).toBe(400);
  });

  it('a counter password reset makes an imported account usable', async () => {
    const up = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', await xlsx([{ 'ID Card No': 'IMP777', 'Full Name': 'Reset Me', 'Mobile': '9811100777', 'Hostel': 'Test Hostel', 'Room': '9', 'Valid Until': '' }]), { filename: 's.xlsx' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const id = (await staff.get('/api/ops/students?q=IMP777')).body.rows[0].id;
    const r = await post(staff, `/api/ops/students/${id}/reset-password`);
    await signIn('IMP777', r.body.tempPassword);
  });

  it('CSV import keeps text exactly (leading zeros, day/month dates) and reports real row numbers', async () => {
    const csv = 'ID Card No,Full Name,Mobile,Hostel,Room,Valid Until\nCSV001,Csv One,9811100501,Test Hostel,0105,2027-06-05\n\nCSV002,Csv Two,123,Test Hostel,1,\n';
    const bad = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', Buffer.from(csv), { filename: 'list.csv' });
    expect(bad.status).toBe(422);
    expect(bad.body.details.errors[0].row).toBe(4);
    const good = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', Buffer.from(csv.split('\n').slice(0, 2).join('\n')), { filename: 'list.csv' });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect((await staff.get('/api/ops/students?q=CSV001')).body.rows[0]).toMatchObject({ room_no: '0105', valid_until: '2027-06-05' });
  });
});

describe('security audit fixes', () => {
  it('staff cannot move an order back to "received" (that would re-open cancel/correct)', async () => {
    const s = await newStudent();
    const o = await order(s.id, 3, 5);
    await post(staff, '/api/ops/orders/status', { ids: [o.body.id], status: 'WASHING' });
    expect((await post(staff, '/api/ops/orders/status', { ids: [o.body.id], status: 'RECEIVED' })).status).toBe(403);
    expect((await post(admin, '/api/ops/orders/status', { ids: [o.body.id], status: 'RECEIVED' })).status).toBe(200);
  });

  it('a student who is not approved cannot raise complaints or upload photos', async () => {
    const s = await newStudent(false);
    const r = await s.agent.post('/api/me/complaints').set('x-ej', '1').field('category', 'Other').field('description', 'spam spam spam');
    expect(r.status).toBe(403);
  });

  it('signing out cancels the token on the server', async () => {
    const s = await newStudent();
    const res = await request(app).post('/api/auth/login').set({ 'x-ej': '1', 'x-ej-client': 'app' }).send({ loginId: s.idCardNo, password: 'secret12' });
    const bearer = { Authorization: `Bearer ${res.body.token}`, 'x-ej': '1' };
    expect((await request(app).get('/api/me/home').set(bearer)).status).toBe(200);
    await request(app).post('/api/auth/logout').set(bearer);
    expect((await request(app).get('/api/me/home').set(bearer)).status).toBe(401);
  });

  it('only wrong passwords count toward the login limit', async () => {
    const s = await newStudent();
    for (let i = 0; i < 10; i++) expect((await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: s.idCardNo, password: 'secret12' })).status).toBe(200);
  });

  it('sends a strict content security policy', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('the register export writes names as text, never as formulas', async () => {
    const s = await newStudent();
    await staff.patch(`/api/ops/students/${s.id}`).set('x-ej', '1').send({ name: '=HYPERLINK("http://x","y")', idCardNo: s.idCardNo, mobile: '9876500111', hostelId, roomNo: '1' });
    await order(s.id, 1, 1);
    const res = await admin.get('/api/admin/export?from=2000-01-01&to=2099-12-31').buffer(true).parse((r, cb) => { const d: Buffer[] = []; r.on('data', (c: Buffer) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer as unknown as ArrayBuffer);
    let found = false;
    wb.worksheets[0].eachRow(row => row.eachCell(cell => { if (String(cell.value).startsWith('=HYPERLINK')) { found = true; expect(cell.type).toBe(ExcelJS.ValueType.String); } }));
    expect(found).toBe(true);
  });
});

describe('upload hardening', () => {
  it('refuses an .xlsx that unpacks far beyond a student list (zip bomb)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['ID Card No', 'Full Name', 'Mobile', 'Hostel', 'Room', 'Valid Until']);
    const filler = 'A'.repeat(32_000);
    for (let i = 0; i < 500; i++) ws.addRow([`Z${i}`, `${i}${filler}`, '9811100000', 'Test Hostel', '1', '']);   // each row unique: ~16 MB unpacked
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', buf, { filename: 'big.xlsx' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('too big');
  });

  it('a photo must really be an image, whatever the browser says', async () => {
    const s = await newStudent();
    const r = await s.agent.post('/api/me/complaints').set('x-ej', '1').field('category', 'Other').field('description', 'Shirt torn badly')
      .attach('photo', Buffer.from('<svg onload=alert(1)>'), { filename: 'x.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
  });

  it('login ids and passwords have a maximum length', async () => {
    const r = await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: 'A'.repeat(5000), password: 'x' });
    expect(r.status).toBe(400);
  });
});
