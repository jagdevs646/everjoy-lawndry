import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  admin = await signIn('admin', 'Everjoy@123');   // login id is case-insensitive
  const h = await post(admin, '/api/admin/hostels', { name: 'Test Hostel' });
  hostelId = h.body.id;
  expect((await post(admin, '/api/admin/staff', { name: 'Counter One', loginId: 'counter1', password: 'counter-pass', role: 'STAFF' })).status).toBe(201);
  staff = await signIn('COUNTER1', 'counter-pass');
});

describe('security', () => {
  it('blocks state changes without the CSRF header', async () => {
    const res = await request(app).post('/api/auth/login').send({ loginId: 'ADMIN', password: 'Everjoy@123' });
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
    expect(reset.body.tempPassword).toMatch(/^[a-z]+-\d{4}$/);
    expect((await s.agent.get('/api/me/home')).status).toBe(401);
    const fresh = await signIn(s.idCardNo, reset.body.tempPassword);
    expect((await fresh.get('/api/auth/me')).body.user.must_change_password).toBe(true);
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
  it('blocks or charges beyond the monthly kg limit, and payment is needed before pickup', async () => {
    await put(admin, '/api/admin/settings', { monthly_kg_limit: 10, over_limit_action: 'BLOCK', max_active_orders: 0 });
    const s = await newStudent();
    expect((await order(s.id, 6)).status).toBe(201);
    const blocked = await order(s.id, 5);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toContain('4 kg left');

    await put(admin, '/api/admin/settings', { over_limit_action: 'CHARGE', extra_rate_per_kg: 20 });
    const charged = await order(s.id, 5);
    expect(charged.body.extra_kg).toBe(1);
    expect(charged.body.amount).toBe(20);
    expect(charged.body.payment_status).toBe('DUE');
    expect((await post(staff, `/api/ops/orders/${charged.body.id}/deliver`, { returnedCount: 10 })).status).toBe(409);
    const paidAndDone = await post(staff, `/api/ops/orders/${charged.body.id}/deliver`, { returnedCount: 10, payMethod: 'UPI', payRef: 'UTR123' });
    expect(paidAndDone.body.status).toBe('DELIVERED');
    expect(paidAndDone.body.payment_status).toBe('PAID');

    await put(admin, '/api/admin/settings', { monthly_kg_limit: 0, over_limit_action: 'BLOCK', extra_rate_per_kg: 0, max_active_orders: 2 });
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
    await post(staff, `/api/ops/students/${s.id}/reset-password`).then(r => appLogin(s.idCardNo, r.body.tempPassword))
      .then(async res => {
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.headers['set-cookie']).toBeUndefined();
        const home = await request(app).get('/api/me/home').set('Authorization', `Bearer ${res.body.token}`);
        expect(home.status).toBe(200);
      });
  });

  it('the website login still uses only the cookie', async () => {
    const res = await request(app).post('/api/auth/login').set('x-ej', '1').send({ loginId: 'COUNTER1', password: 'counter-pass' });
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
