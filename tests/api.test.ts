import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { outbox } from '../server/mail.js';

// Keep one listener alive while concurrent Supertest requests share a signed-in agent.
const app = (await createApp()).listen(0, '127.0.0.1');
await new Promise<void>(resolve => app.once('listening', resolve));
afterAll(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
type Agent = ReturnType<typeof request.agent>;

/** The 6-digit code in the newest email (to this address, if given). Tests run without a real mail service. */
function codeFor(email?: string) {
  const m = [...outbox].reverse().find(x => !email || x.to === email);
  expect(m, `no email${email ? ` to ${email}` : ''}`).toBeTruthy();
  return /(\d{6})/.exec(m!.subject)![1];
}

/** A signed-in browser: keeps the session cookie and sends the CSRF header. Types the email code when asked. */
async function signIn(loginId: string, password: string): Promise<Agent> {
  const a = request.agent(app);
  let res = await a.post('/api/auth/login').set('x-ej', '1').send({ loginId, password });
  expect(res.status, res.body.error).toBe(200);
  if (res.body.otp_required) {
    res = await a.post('/api/auth/otp').set('x-ej', '1').send({ challenge: res.body.challenge, code: codeFor() });
    expect(res.status, res.body.error).toBe(200);
  }
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
  const email = `tst${seq}@uni.test`;
  const a = request.agent(app);
  const started = await post(a, '/api/auth/signup', { idCardNo, name: `Student ${seq}`, mobile: `98765${String(seq).padStart(5, '0')}`, email, hostelId, roomNo: `${seq}`, password: 'secret12' });
  expect(started.status, started.body.error).toBe(202);   // the account is made once the emailed code is typed
  const res = await post(a, '/api/auth/otp', { challenge: started.body.challenge, code: codeFor(email) });
  expect(res.status, res.body.error).toBe(201);
  const id = res.body.user.id as number;
  if (approve) expect((await post(staff, `/api/ops/students/${id}/review`, { decision: 'APPROVE' })).status).toBe(200);
  return { agent: a, id, idCardNo, email };
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
  // The student's code confirmation has its own tests below; the rest of the suite hands over directly.
  expect((await put(admin, '/api/admin/settings', { sign_dropoff: false, sign_pickup: false })).status).toBe(200);
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
    expect((await a.agent.get(`/api/me/orders/${o.body.id}`)).body.qr_key).toBeTruthy();
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
    // The slip QR changes every 30 s (HMAC of the order's secret token); the old fixed QR is refused.
    // The phone gets a derived key, never the order's secret token.
    expect(slip.body.qr_token).toBeUndefined();
    expect(slip.body.qr_key).toBeTruthy();
    const qr = (step: number) => `EJ2:${o.body.id}.${step}.${crypto.createHmac('sha256', slip.body.qr_key).update(`${o.body.id}.${step}`).digest('base64url').slice(0, 16)}`;
    const now = Math.floor(Date.now() / 30_000);
    expect((await post(staff, '/api/ops/scan', { code: 'EJ:some-old-fixed-qr' })).status).toBe(409);
    expect((await post(staff, '/api/ops/scan', { code: `EJ2:${o.body.id}.${now}.AAAAAAAAAAAAAAAA` })).status).toBe(404);
    expect((await post(staff, '/api/ops/scan', { code: qr(now - 20) })).status).toBe(409);   // a 10-minute-old screenshot
    const scanned = await post(staff, '/api/ops/scan', { code: qr(now) });
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
  const appLogin = async (loginId: string, password: string) => {
    const h = { 'x-ej': '1', 'x-ej-client': 'app' };
    const res = await request(app).post('/api/auth/login').set(h).send({ loginId, password });
    if (!res.body.otp_required) return res;
    return request(app).post('/api/auth/otp').set(h).send({ challenge: res.body.challenge, code: codeFor() });
  };

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
    // Staff enter each student's semester (Jan–Jun or Jul–Dec). A plan that hasn't started yet means normal prices too.
    const year = new Date().getFullYear() + 1;
    const dated = await staff.patch(`/api/ops/students/${s.id}`).set('x-ej', '1').send({ name: 'X Y', idCardNo: s.idCardNo, mobile: '9876500998', hostelId, roomNo: '1', validFrom: `${year}-01-01`, validUntil: `${year}-06-30` });
    expect(dated.status, dated.body.error).toBe(200);
    expect(dated.body.plan).toMatchObject({ hosteler: false });
    expect(dated.body.plan.label).toContain(`starts 1 Jan ${year}`);
    const bad = await staff.patch(`/api/ops/students/${s.id}`).set('x-ej', '1').send({ name: 'X Y', idCardNo: s.idCardNo, mobile: '9876500998', hostelId, roomNo: '1', validFrom: `${year}-07-01`, validUntil: `${year}-06-30` });
    expect(bad.status).toBe(400);
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
    expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(['ID Card No', 'Full Name', 'Mobile', 'University Email', 'Hostel', 'Room', 'Valid From', 'Valid Until']);
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
    const h = { 'x-ej': '1', 'x-ej-client': 'app' };
    const started = await request(app).post('/api/auth/login').set(h).send({ loginId: s.idCardNo, password: 'secret12' });
    const res = await request(app).post('/api/auth/otp').set(h).send({ challenge: started.body.challenge, code: codeFor(s.email) });
    const bearer = { Authorization: `Bearer ${res.body.token}`, 'x-ej': '1' };
    expect((await request(app).get('/api/me/home').set(bearer)).status).toBe(200);
    await request(app).post('/api/auth/logout').set(bearer);
    expect((await request(app).get('/api/me/home').set(bearer)).status).toBe(401);
  });

  it('only wrong passwords count toward the login limit', async () => {
    const s = await newStudent();
    const device = await signIn(s.idCardNo, 'secret12');   // this browser is trusted now: no more email codes
    for (let i = 0; i < 10; i++) {
      const r = await device.post('/api/auth/login').set('x-ej', '1').send({ loginId: s.idCardNo, password: 'secret12' });
      expect(r.status).toBe(200);
      expect(r.body.user).toBeTruthy();
    }
  });

  it('sends a strict content security policy', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('anyone can download the Android app as an .apk file', async () => {
    const r = await request(app).get('/download/everjoy-lawndry.apk').buffer(true).parse((res, cb) => { let n = 0; res.on('data', (c: Buffer) => { n += c.length; }); res.on('end', () => cb(null, n)); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/vnd.android.package-archive');
    expect(r.headers['content-disposition']).toContain('everjoy-lawndry.apk');
    expect(r.body as unknown as number).toBeGreaterThan(1_000_000);
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

describe('university email codes', () => {
  it('a new browser needs the emailed code; a trusted one does not', async () => {
    const s = await newStudent();
    const fresh = request.agent(app);
    const first = await post(fresh, '/api/auth/login', { loginId: s.idCardNo, password: 'secret12' });
    expect(first.body).toMatchObject({ otp_required: true });
    expect(first.body.email_hint).toMatch(/^ts•+@uni\.test$/);
    expect(first.body.user).toBeUndefined();
    expect((await fresh.get('/api/me/home')).status).toBe(401);   // no session before the code
    const right = codeFor(s.email);
    const wrong = await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: right === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    const ok = await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: right });
    expect(ok.status, ok.body.error).toBe(200);
    expect((await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: right })).status).toBe(410);   // single use
    const again = await post(fresh, '/api/auth/login', { loginId: s.idCardNo, password: 'secret12' });
    expect(again.body.user).toBeTruthy();   // trusted browser: password only
  });

  it('five wrong codes end the challenge', async () => {
    const s = await newStudent();
    const fresh = request.agent(app);
    const first = await post(fresh, '/api/auth/login', { loginId: s.idCardNo, password: 'secret12' });
    const right = codeFor(s.email);
    const bad = right === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: bad });
    expect((await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: right })).status).toBe(429);
  });

  it('only university addresses when the admin sets a domain', async () => {
    await put(admin, '/api/admin/settings', { student_email_domain: 'uni.test' });
    const r = await post(request.agent(app), '/api/auth/signup', { idCardNo: 'DOM001', name: 'Dom One', mobile: '9811177001', email: 'dom@gmail.com', hostelId, roomNo: '1', password: 'secret12' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('uni.test');
    await put(admin, '/api/admin/settings', { student_email_domain: '' });
  });

  it('imported students with a university email set up their account with an emailed code (no approval needed)', async () => {
    const up = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', await xlsx([
      { 'ID Card No': 'OTP001', 'Full Name': 'Mail Student', 'Mobile': '9811188001', 'University Email': 'mail.student@uni.test', 'Hostel': 'Test Hostel', 'Room': '3', 'Valid From': '2026-07-01', 'Valid Until': '2026-12-31' },
    ]), { filename: 's.xlsx' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.codes).toHaveLength(1);   // a claim code too, in case email codes are switched off
    const a = request.agent(app);
    const started = await post(a, '/api/auth/signup', { idCardNo: 'OTP001', name: 'Mail Student', mobile: '9811188001', hostelId, roomNo: '3', password: 'mypass12' });
    expect(started.status, started.body.error).toBe(202);
    expect(started.body.purpose).toBe('CLAIM');
    const done = await post(a, '/api/auth/otp', { challenge: started.body.challenge, code: codeFor('mail.student@uni.test') });
    expect(done.status, done.body.error).toBe(200);
    expect(done.body.user.student_status).toBe('ACTIVE');
    const card = (await staff.get('/api/ops/students?q=OTP001')).body.rows[0];
    expect(card).toMatchObject({ valid_from: '2026-07-01', valid_until: '2026-12-31', claimable: 0, email: 'mail.student@uni.test' });
    expect(card.email_verified_at).toBeTruthy();
  });
});

describe('profile photo', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  it('student adds a photo before approval; after approval only staff can change it', async () => {
    const s = await newStudent(false);
    const up = await s.agent.post('/api/me/photo').set('x-ej', '1').attach('photo', jpeg, { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(up.status, up.body.error).toBe(200);
    expect(up.body.photo).toBeTruthy();
    expect((await s.agent.get(`/api/files/${up.body.photo}`)).status).toBe(200);
    expect((await staff.get(`/api/files/${up.body.photo}`)).status).toBe(200);
    const other = await newStudent();
    expect((await other.agent.get(`/api/files/${up.body.photo}`)).status).toBe(403);
    await post(staff, `/api/ops/students/${s.id}/review`, { decision: 'APPROVE' });
    expect((await s.agent.post('/api/me/photo').set('x-ej', '1').attach('photo', jpeg, { filename: 'me.jpg', contentType: 'image/jpeg' })).status).toBe(403);
    const byStaff = await staff.post(`/api/ops/students/${s.id}/photo`).set('x-ej', '1').attach('photo', jpeg, { filename: 'c.jpg', contentType: 'image/jpeg' });
    expect(byStaff.status, byStaff.body.error).toBe(200);
    expect(byStaff.body.photo).not.toBe(up.body.photo);
    expect((await staff.get(`/api/files/${up.body.photo}`)).status).toBe(404);   // the old photo is deleted
  });
});

describe('basket card no.', () => {
  it('cards follow the admin series, are never on two open orders, and find the basket at pickup', async () => {
    await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'A', from: 1, to: 3000 }], card_required: true });
    const s = await newStudent();
    expect((await order(s.id, 2, 4)).status).toBe(422);                         // card needed
    expect((await order(s.id, 2, 4, { tagNo: 'B12' })).status).toBe(422);       // not in a series
    expect((await order(s.id, 2, 4, { tagNo: 'A5000' })).status).toBe(422);
    const o1 = await order(s.id, 2, 4, { tagNo: 'a 1002' });
    expect(o1.status, o1.body.error).toBe(201);
    const t = await newStudent();
    const clash = await order(t.id, 2, 4, { tagNo: 'A1002' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toContain(o1.body.order_no);
    const found = await post(staff, '/api/ops/scan', { code: 'A1002' });
    expect(found.body).toMatchObject({ id: o1.body.id, via: 'CARD', tag_no: 'A1002' });
    expect((await staff.get('/api/ops/orders?q=a1002')).body.rows[0].id).toBe(o1.body.id);
    const slip = await s.agent.get(`/api/me/orders/${o1.body.id}`);
    expect(slip.body.tag_no).toBe('A1002');
    // Collected: the card goes back on the shelf and can be given to the next basket.
    await post(staff, `/api/ops/orders/${o1.body.id}/deliver`, { returnedCount: 4 });
    const reuse = await order(t.id, 2, 4, { tagNo: 'A1002' });
    expect(reuse.status, reuse.body.error).toBe(201);
    // Wrong card typed: staff change it.
    const moved = await staff.patch(`/api/ops/orders/${reuse.body.id}/card`).set('x-ej', '1').send({ tagNo: 'A7' });
    expect(moved.body.tag_no).toBe('A7');
    await put(admin, '/api/admin/settings', { card_series: [], card_required: false });
  });

  it('a series can have words and signs before and after the number', async () => {
    // "H" 1–500 and "H1-" 1–100 can both read H11, so the counter could mix them up.
    expect((await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'H', from: 1, to: 500 }, { prefix: 'H1-', from: 1, to: 100 }] })).status).toBe(400);
    expect((await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'EJ-', from: 1, to: 9 }] })).status).toBe(400);
    const ok = await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'blue-', suffix: '/b', from: 1, to: 500, pad: 3 }, { prefix: '#', from: 100, to: 999 }], card_required: true });
    expect(ok.status, ok.body.error).toBe(200);
    expect(ok.body.card_series[0]).toEqual({ prefix: 'BLUE-', suffix: '/B', from: 1, to: 500, pad: 3, blocked: [] });
    const s = await newStudent();
    const o = await order(s.id, 2, 3, { tagNo: 'blue 7 b' });
    expect(o.status, o.body.error).toBe(201);
    expect(o.body.tag_no).toBe('BLUE-007/B');
    expect((await order(s.id, 2, 3, { tagNo: 'BLUE-501/B' })).status).toBe(422);
    const t = await newStudent();
    expect((await order(t.id, 2, 3, { tagNo: 'BLUE-007/B' })).status).toBe(409);
    expect((await post(staff, '/api/ops/scan', { code: 'blue7b' })).body).toMatchObject({ id: o.body.id, via: 'CARD', tag_no: 'BLUE-007/B' });
    const hash = await order(t.id, 2, 3, { tagNo: '# 250' });
    expect(hash.body.tag_no).toBe('#250');
    expect((await post(staff, '/api/ops/scan', { code: '#250' })).body.id).toBe(hash.body.id);
    await put(admin, '/api/admin/settings', { card_series: [], card_required: false });
  });

  it('a card on a basket that is not collected is never given again, however it is written', async () => {
    await put(admin, '/api/admin/settings', { card_series: [], card_required: false });
    const s = await newStudent();
    const o = await order(s.id, 2, 3, { tagNo: 'K77' });
    expect(o.status, o.body.error).toBe(201);
    // The admin now writes cards as K-077: still the same physical card.
    expect((await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'K-', from: 1, to: 999, pad: 3 }] })).status).toBe(200);
    const t = await newStudent();
    const again = await order(t.id, 2, 3, { tagNo: 'k-077' });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(o.body.order_no);
    expect((await post(staff, '/api/ops/scan', { code: 'K-077' })).body.id).toBe(o.body.id);
    const other = await order(t.id, 2, 3, { tagNo: 'K-078' });
    expect(other.status, other.body.error).toBe(201);
    expect((await staff.patch(`/api/ops/orders/${other.body.id}/card`).set('x-ej', '1').send({ tagNo: 'K 77' })).status).toBe(409);
    await put(admin, '/api/admin/settings', { card_series: [] });
  });

  it('cards marked lost or damaged, or outside the range, are refused; the counter sees it live', async () => {
    const bad = await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'Q', from: 1, to: 300, blocked: [{ from: 290, to: 310, reason: 'LOST' }] }] });
    expect(bad.status).toBe(400);   // not-usable cards must be inside the series
    const ok = await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'Q', from: 1, to: 300, blocked: [{ from: 2, to: 2, reason: 'LOST', note: 'lost 20 Nov' }, { from: 5, to: 7, reason: 'DAMAGED' }] }] });
    expect(ok.status, ok.body.error).toBe(200);
    const s = await newStudent();
    const lost = await order(s.id, 2, 3, { tagNo: 'Q2' });
    expect(lost.status).toBe(422);
    expect(lost.body.error).toContain('lost');
    expect((await order(s.id, 2, 3, { tagNo: 'Q301' })).body.error).toContain('outside the series');
    // Live check while typing: the next free card skips the lost one.
    const free = await staff.get('/api/ops/cards/check?card=Q1&series=0');
    expect(free.body).toMatchObject({ card: 'Q1', ok: true, next_free: 'Q1' });
    const o = await order(s.id, 2, 3, { tagNo: 'Q1' });
    expect(o.status, o.body.error).toBe(201);
    const taken = await staff.get('/api/ops/cards/check?card=q1&series=0');
    expect(taken.body.ok).toBe(false);
    expect(taken.body.problem).toContain(o.body.order_no);
    expect(taken.body.next_free).toBe('Q3');
    expect((await staff.get('/api/ops/cards/check?card=Q6&series=0')).body.problem).toContain('damaged');
    expect((await staff.get('/api/ops/cards/series')).body.series[0]).toMatchObject({ prefix: 'Q', from: 1, to: 300 });
    // At pickup the number alone finds the basket.
    expect((await post(staff, '/api/ops/scan', { code: 'Q1' })).body.id).toBe(o.body.id);
    await put(admin, '/api/admin/settings', { card_series: [] });
  });
});

describe('order no. style', () => {
  const fy = () => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const a = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${String(a % 100).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`;
  };
  afterAll(async () => { await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'EJ-', suffix: '', pad: 0, start: 1001, reset: 'NEVER' }, card_series: [] }); });

  it('the admin sets their own style, with date parts and numbering that starts again', async () => {
    expect((await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'X-', reset: 'YEARLY' } })).status).toBe(400);   // would repeat
    expect((await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'INV/{QQ}/' } })).status).toBe(400);
    const ok = await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'inv/{FY}/', suffix: '', pad: 4, start: 1, reset: 'FY' } });
    expect(ok.status, ok.body.error).toBe(200);
    expect((await admin.get('/api/admin/order-no')).body.next).toBe(`INV/${fy()}/0001`);
    const s = await newStudent();
    const a = await order(s.id, 2, 3);
    const b = await order(s.id, 2, 3);
    expect(a.body.order_no).toBe(`INV/${fy()}/0001`);
    expect(b.body.order_no).toBe(`INV/${fy()}/0002`);
    expect((await post(staff, '/api/ops/scan', { code: `inv ${fy().replace('-', ' ')} 0002` })).body.id).toBe(b.body.id);
    expect((await post(staff, '/api/ops/scan', { code: '2' })).body.id).toBe(b.body.id);     // just the number, today's style
    expect((await staff.get(`/api/ops/orders?q=${encodeURIComponent(a.body.order_no)}`)).body.rows[0].id).toBe(a.body.id);
    // A card series that looks like these order numbers is refused.
    expect((await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'INV', from: 1, to: 50 }] })).status).toBe(400);
  });

  it('an order no. is never given twice, even when the style is changed back', async () => {
    const { db } = await import('../server/db.js');
    const used = (await db.all<{ order_no: string }>("SELECT order_no FROM orders WHERE order_no LIKE 'EJ-%' ORDER BY id LIMIT 1"))[0].order_no;
    // "EJ" + the same numbers would read like the old EJ-… numbers: those are skipped.
    await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'EJ', suffix: '', pad: 0, start: Number(used.slice(3)), reset: 'NEVER' } });
    const s = await newStudent();
    const o = await order(s.id, 2, 3);
    expect(o.status, o.body.error).toBe(201);
    expect(o.body.order_no).not.toBe(used.replace('-', ''));
    const keys = (await db.all<{ k: string }>('SELECT order_key AS k FROM orders')).map(r => r.k);
    expect(new Set(keys).size).toBe(keys.length);
    // Back to the first style: numbering carries on after the last EJ- order, never from 1001 again.
    await put(admin, '/api/admin/settings', { order_no_format: { prefix: 'EJ-', suffix: '', pad: 0, start: 1001, reset: 'NEVER' } });
    const next = await order(s.id, 2, 3);
    expect(Number(next.body.order_no.slice(3))).toBeGreaterThan(Number(used.slice(3)));
  });
});

describe('round 2 review fixes', () => {
  it('a new code does not give new tries', async () => {
    const s = await newStudent();
    const fresh = request.agent(app);
    const first = await post(fresh, '/api/auth/login', { loginId: s.idCardNo, password: 'secret12' });
    const bad = codeFor(s.email) === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: bad });
    // resend needs 30 s; simulate it by moving the last send back
    const { db } = await import('../server/db.js');
    await db.run('UPDATE login_challenges SET last_sent_at = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), first.body.challenge]);
    expect((await post(fresh, '/api/auth/otp/resend', { challenge: first.body.challenge })).status).toBe(200);
    expect((await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: bad })).status).toBe(400);
    expect((await post(fresh, '/api/auth/otp', { challenge: first.body.challenge, code: codeFor(s.email) })).status).toBe(429);   // 5 tries used up
  });

  it('a student adds their email only by typing the code sent to it', async () => {
    const up = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', await xlsx([
      { 'ID Card No': 'NOMAIL1', 'Full Name': 'No Mail', 'Mobile': '9811199001', 'Hostel': 'Test Hostel', 'Room': '4' },
    ]), { filename: 's.xlsx' });
    const code = up.body.codes[0].code;
    const a = request.agent(app);
    const claimed = await post(a, '/api/auth/signup', { idCardNo: 'NOMAIL1', name: 'No Mail', mobile: '9811199001', hostelId, roomNo: '4', password: 'nomail12', claimCode: code });
    expect(claimed.status, claimed.body.error).toBe(200);
    const asked = await a.put('/api/me/email').set('x-ej', '1').send({ email: 'no.mail@uni.test' });
    expect(asked.status, asked.body.error).toBe(202);
    expect((await a.get('/api/auth/me')).body.profile.email).toBeNull();   // not saved yet
    const done = await post(a, '/api/auth/otp', { challenge: asked.body.challenge, code: codeFor('no.mail@uni.test') });
    expect(done.status, done.body.error).toBe(200);
    expect((await a.get('/api/auth/me')).body.profile).toMatchObject({ email: 'no.mail@uni.test' });
  });

  it('A012 and A12 are the same card; digits that match both a card and an order are not guessed', async () => {
    await put(admin, '/api/admin/settings', { card_series: [], card_required: false });
    const s = await newStudent();
    const t = await newStudent();
    const o1 = await order(s.id, 2, 3, { tagNo: 'A012' });
    expect(o1.body.tag_no).toBe('A12');
    expect((await order(t.id, 2, 3, { tagNo: 'A12' })).status).toBe(409);
    const n = Number(o1.body.order_no.slice(3)) - 1;   // an order no. that exists
    const o2 = await order(t.id, 2, 3, { tagNo: String(n) });
    expect(o2.status, o2.body.error).toBe(201);
    expect((await post(staff, '/api/ops/scan', { code: String(n) })).status).toBe(409);
    expect((await post(staff, '/api/ops/scan', { code: `EJ-${n}` })).body.order_no).toBe(`EJ-${n}`);
    expect((await put(admin, '/api/admin/settings', { card_series: [{ prefix: 'EJ', from: 1, to: 9 }] })).status).toBe(400);
  });
});

describe('round 3: timings, automatic status, stats, leaving, password reset', () => {
  it('ready time is the pickup time N days after drop-off, and orders move on by themselves', async () => {
    await put(admin, '/api/admin/settings', { pickup_from: '19:00', ready_after_days: 2, auto_status: true, auto_washing_hours: 24 });
    const s = await newStudent();
    const o = await order(s.id, 3, 5);
    const exp = new Date(o.body.expected_at);
    expect(exp.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })).toBe('19:00');
    expect((exp.getTime() - Date.now()) / 3600_000).toBeGreaterThan(24);
    const { db } = await import('../server/db.js');
    const { runAutoAdvance } = await import('../server/rules.js');
    // 25 hours after drop-off: washing
    await db.run('UPDATE orders SET received_at = ? WHERE id = ?', [new Date(Date.now() - 25 * 3600_000).toISOString(), o.body.id]);
    await runAutoAdvance();
    expect((await staff.get(`/api/ops/orders/${o.body.id}`)).body.status).toBe('WASHING');
    // ready time reached: ready for pickup, student told
    await db.run('UPDATE orders SET expected_at = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), o.body.id]);
    await runAutoAdvance();
    const after = await staff.get(`/api/ops/orders/${o.body.id}`);
    expect(after.body.status).toBe('READY');
    expect(after.body.events.at(-1).note).toContain('Automatic');
    expect((await s.agent.get('/api/notifications')).body.rows[0].title).toContain('ready for pickup');
    // switched off: nothing moves
    await put(admin, '/api/admin/settings', { auto_status: false });
    const o2 = await order(s.id, 2, 3);
    await db.run('UPDATE orders SET received_at = ?, expected_at = ? WHERE id = ?', [new Date(Date.now() - 50 * 3600_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), o2.body.id]);
    await runAutoAdvance();
    expect((await staff.get(`/api/ops/orders/${o2.body.id}`)).body.status).toBe('RECEIVED');
    await put(admin, '/api/admin/settings', { auto_status: true });
  });

  it('orders chart by day, week and month', async () => {
    for (const by of ['day', 'week', 'month']) {
      const r = await admin.get(`/api/admin/trend?by=${by}`);
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(by === 'day' ? 14 : 12);
      expect(r.body.rows.at(-1).orders).toBeGreaterThan(0);
    }
  });

  it('stats: turnaround per service and staff, complaints per 100 orders', async () => {
    const r = await admin.get('/api/admin/stats?from=2020-01-01&to=2099-12-31&by=month');
    expect(r.status, r.body.error).toBe(200);
    expect(r.body.byService.length).toBeGreaterThan(0);
    expect(r.body.byService[0]).toHaveProperty('to_ready_h');
    expect(r.body.byStaff.some((p: { name: string }) => p.name === 'Counter One')).toBe(true);
    expect(r.body.byStaff.some((p: { name: string }) => p.name === 'Automatic')).toBe(true);
    expect(r.body.complaints.total).toBeGreaterThan(0);
    expect(r.body.complaints.per_100_orders).toBeGreaterThan(0);
  });

  it('students who left are removed from the list (history kept) and can be restored', async () => {
    const s = await newStudent();
    const busy = await newStudent();
    await order(busy.id, 2, 3);
    const r = await post(admin, '/api/admin/students/leave', { ids: [s.id, busy.id] });
    expect(r.body.changed).toBe(1);
    expect(r.body.blocked).toHaveLength(1);   // still has laundry at the counter
    expect((await staff.get(`/api/ops/students?q=${s.idCardNo}`)).body.total).toBe(0);
    expect((await staff.get(`/api/ops/students?status=LEFT&q=${s.idCardNo}`)).body.total).toBe(1);
    expect((await s.agent.get('/api/me/home')).status).toBe(401);   // signed out
    expect((await order(s.id, 2, 3)).status).toBe(409);
    expect((await staff.post('/api/admin/students/leave').set('x-ej', '1').send({ ids: [s.id] })).status).toBe(403);
    expect((await post(admin, `/api/admin/students/${s.id}/restore`)).status).toBe(200);
    expect((await staff.get(`/api/ops/students?q=${s.idCardNo}`)).body.total).toBe(1);
  });

  it('a student resets a forgotten password with a code from their email', async () => {
    const s = await newStudent();
    const a = request.agent(app);
    const start = await post(a, '/api/auth/forgot', { loginId: s.idCardNo });
    expect(start.status, start.body.error).toBe(200);
    expect((await post(a, '/api/auth/otp', { challenge: start.body.challenge, code: codeFor(s.email) })).status).toBe(400);   // new password needed
    const done = await post(a, '/api/auth/otp', { challenge: start.body.challenge, code: codeFor(s.email), newPassword: 'fresh-pass' });
    expect(done.status, done.body.error).toBe(200);
    expect((await s.agent.get('/api/me/home')).status).toBe(401);   // other devices signed out
    await signIn(s.idCardNo, 'fresh-pass');
  });

  it('activity log pages through everything, newest first', async () => {
    const r = await admin.get('/api/admin/activity?limit=100&offset=0');
    expect(r.body.total).toBeGreaterThan(r.body.rows.length - 1);
    expect(r.body.rows.length).toBeLessThanOrEqual(100);
    expect(r.body.rows[0].id).toBeGreaterThan(r.body.rows.at(-1).id);
  });
});

describe('two-sided register: the student confirms with the code on their phone', () => {
  beforeAll(async () => { expect((await put(admin, '/api/admin/settings', { sign_dropoff: true, sign_pickup: true })).status).toBe(200); });
  afterAll(async () => { await put(admin, '/api/admin/settings', { sign_dropoff: false, sign_pickup: false }); });

  /** What the student's pop-up shows for this order, and the code on their screen right now. */
  const popup = async (a: Agent, orderId: number, kind: 'DROPOFF' | 'PICKUP') => {
    const r = (await a.get('/api/me/pending')).body.requests.find((x: { order_id: number; kind: string }) => x.order_id === orderId && x.kind === kind);
    return r as { statement: string; key: string; amount: number; seconds_left: number } | undefined;
  };
  const codeOf = async (key: string, orderId: number, kind: 'DROPOFF' | 'PICKUP') => {
    const { confirmCode } = await import('../server/signoff.js');
    return confirmCode(key, orderId, kind, Math.floor(Date.now() / 1000 / 30));
  };
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const has = (rows: { id: number }[], id: number) => rows.some(r => r.id === id);

  it('drop-off: the pop-up shows what the student confirms; staff type the code; the record is fingerprinted', async () => {
    const s = await newStudent();
    const o = await order(s.id, 3, 8);
    expect(o.status, o.body.error).toBe(201);
    expect(o.body.confirm_requests[0]).toMatchObject({ kind: 'DROPOFF', status: 'WAITING' });
    const p = await popup(s.agent, o.body.id, 'DROPOFF');
    expect(p!.statement).toContain('gave 8 clothes (3 kg)');
    expect(p!.statement).toContain(o.body.order_no);
    expect(JSON.stringify((await s.agent.get('/api/me/pending')).body)).not.toContain('secret');
    // Another student sees nothing.
    const other = await newStudent();
    expect(await popup(other.agent, o.body.id, 'DROPOFF')).toBeUndefined();
    const code = await codeOf(p!.key, o.body.id, 'DROPOFF');
    const bad = await post(staff, `/api/ops/orders/${o.body.id}/confirm`, { kind: 'DROPOFF', code: wrong(code) });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toContain('4 tries left');
    const ok = await post(staff, `/api/ops/orders/${o.body.id}/confirm`, { kind: 'DROPOFF', code });
    expect(ok.status, ok.body.error).toBe(200);
    expect(ok.body.dropoff_ack).toBe('CODE');
    expect(ok.body.confirm_requests).toEqual([]);
    const so = ok.body.signoffs[0];
    expect(so).toMatchObject({ kind: 'DROPOFF', method: 'CODE', status: 'CONFIRMED', staff_name: 'Counter One' });
    expect(so.statement).toContain('gave 8 clothes');
    expect(await popup(s.agent, o.body.id, 'DROPOFF')).toBeUndefined();
    expect((await post(staff, `/api/ops/orders/${o.body.id}/confirm-request`, { kind: 'DROPOFF' })).status).toBe(409);
    // The fingerprint holds; changing the record afterwards breaks it.
    const { verifySignoff } = await import('../server/signoff.js');
    const { db } = await import('../server/db.js');
    expect(await verifySignoff(so.id)).toBe(true);
    await db.run('UPDATE order_signoffs SET statement = ? WHERE id = ?', ['I gave 2 clothes', so.id]);
    expect(await verifySignoff(so.id)).toBe(false);
    // Students see their record without the evidence fields.
    const mine = (await s.agent.get(`/api/me/orders/${o.body.id}`)).body;
    expect(mine.signoffs[0].proof_hash).toBeUndefined();
    expect(mine.confirm_requests).toEqual([]);
  });

  it('a drop-off without the code is "not confirmed": it stays in its lane, cannot move on and is not counted as taken in', async () => {
    const s = await newStudent();
    const o = await order(s.id, 2, 6);
    const id = o.body.id;
    expect(o.body.dropoff_needed).toBe(1);
    const lane = async (st: string) => (await staff.get(`/api/ops/orders?status=${st}&limit=500`)).body.rows as { id: number }[];
    expect(has(await lane('UNCONFIRMED'), id)).toBe(true);
    expect(has(await lane('RECEIVED'), id)).toBe(true);   // shown in its lane, marked "Not confirmed"
    const before = (await staff.get('/api/ops/summary')).body;
    expect(before.open.unconfirmed).toBeGreaterThan(0);
    const moved = await post(staff, '/api/ops/orders/status', { ids: [id], status: 'WASHING' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toContain('not confirmed');
    // Only the admin may count it without the code.
    expect((await post(staff, `/api/ops/orders/${id}/dropoff-override`, { reason: 'Lost phone' })).status).toBe(403);
    // The student gives the code: now it is received and moves on.
    const p = await popup(s.agent, id, 'DROPOFF');
    const ok = await post(staff, `/api/ops/orders/${id}/confirm`, { kind: 'DROPOFF', code: await codeOf(p!.key, id, 'DROPOFF') });
    expect(ok.status, ok.body.error).toBe(200);
    expect(has(await lane('UNCONFIRMED'), id)).toBe(false);
    expect(has(await lane('RECEIVED'), id)).toBe(true);
    const after = (await staff.get('/api/ops/summary')).body;
    expect(after.open.unconfirmed).toBe(before.open.unconfirmed - 1);
    expect(after.today.received).toBe(before.today.received + 1);
    expect((await post(staff, '/api/ops/orders/status', { ids: [id], status: 'WASHING' })).status).toBe(200);
    // Lost phone: the admin counts another drop-off as received, with a reason on record.
    const t = await newStudent();
    const o2 = await order(t.id, 1, 3);
    const ov = await post(admin, `/api/ops/orders/${o2.body.id}/dropoff-override`, { reason: 'Student lost their phone' });
    expect(ov.status, ov.body.error).toBe(200);
    expect(ov.body.dropoff_ack).toBe('OVERRIDE');
    expect(ov.body.signoffs[0]).toMatchObject({ kind: 'DROPOFF', method: 'OVERRIDE', reason: 'Student lost their phone' });
    expect(has(await lane('RECEIVED'), o2.body.id)).toBe(true);
    expect(await popup(t.agent, o2.body.id, 'DROPOFF')).toBeUndefined();
    expect((await post(admin, `/api/ops/orders/${o2.body.id}/dropoff-override`, { reason: 'again' })).status).toBe(409);
  });

  it('five wrong codes cancel the request; a code from another order does not work', async () => {
    const s = await newStudent();
    const a = await order(s.id, 2, 4);
    const b = await order(s.id, 2, 5);
    const pa = await popup(s.agent, a.body.id, 'DROPOFF');
    const codeA = await codeOf(pa!.key, a.body.id, 'DROPOFF');
    const pb = await popup(s.agent, b.body.id, 'DROPOFF');
    const codeB = await codeOf(pb!.key, b.body.id, 'DROPOFF');
    if (codeA !== codeB) expect((await post(staff, `/api/ops/orders/${b.body.id}/confirm`, { kind: 'DROPOFF', code: codeA })).status).toBe(422);
    for (let i = 0; i < 4; i++) await post(staff, `/api/ops/orders/${a.body.id}/confirm`, { kind: 'DROPOFF', code: wrong(codeA) });
    expect((await post(staff, `/api/ops/orders/${a.body.id}/confirm`, { kind: 'DROPOFF', code: wrong(codeA) })).status).toBe(429);
    expect((await post(staff, `/api/ops/orders/${a.body.id}/confirm`, { kind: 'DROPOFF', code: codeA })).status).toBe(409);
    // Staff send a new code.
    expect((await post(staff, `/api/ops/orders/${a.body.id}/confirm-request`, { kind: 'DROPOFF' })).status).toBe(200);
    const again = await popup(s.agent, a.body.id, 'DROPOFF');
    expect((await post(staff, `/api/ops/orders/${a.body.id}/confirm`, { kind: 'DROPOFF', code: await codeOf(again!.key, a.body.id, 'DROPOFF') })).status).toBe(200);
  });

  it('pickup: no hand-over without the code; with it the clothes and any payment go out together', async () => {
    await put(admin, '/api/admin/settings', { allow_paid_extra: true, extra_rate_per_kg: 20, pay_before_pickup: true });
    const s = await newStudent();
    const o = await order(s.id, 3, 8);
    const none = await post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 8 });
    expect(none.status).toBe(409);
    expect(none.body.details?.code).toBe('SIGN_NEEDED');
    expect((await post(staff, `/api/ops/orders/${o.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 7 })).status).toBe(422);   // count differs: note needed
    const asked = await post(staff, `/api/ops/orders/${o.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 7, note: 'One shirt still drying' });
    expect(asked.status, asked.body.error).toBe(200);
    const p = await popup(s.agent, o.body.id, 'PICKUP');
    expect(p!.statement).toContain('received 7 of the 8 clothes');
    expect(p!.statement).toContain('Staff note: One shirt still drying');
    expect(p!.seconds_left).toBeGreaterThan(500);
    const done = await post(staff, `/api/ops/orders/${o.body.id}/confirm`, { kind: 'PICKUP', code: await codeOf(p!.key, o.body.id, 'PICKUP') });
    expect(done.status, done.body.error).toBe(200);
    expect(done.body).toMatchObject({ status: 'DELIVERED', pickup_ack: 'CODE', returned_count: 7, confirm_requests: [] });

    // Money due: the request must say how it was paid; the payment is saved with the code.
    const t = await newStudent();
    const paid = await order(t.id, 9, 10, { acceptExtra: true });
    expect(paid.body.amount).toBeGreaterThan(0);
    expect((await post(staff, `/api/ops/orders/${paid.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 10 })).status).toBe(409);
    await post(staff, `/api/ops/orders/${paid.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 10, payMethod: 'UPI', payRef: 'UTR77' });
    const pp = await popup(t.agent, paid.body.id, 'PICKUP');
    expect(pp!.amount).toBe(paid.body.amount);
    const ok = await post(staff, `/api/ops/orders/${paid.body.id}/confirm`, { kind: 'PICKUP', code: await codeOf(pp!.key, paid.body.id, 'PICKUP') });
    expect(ok.body).toMatchObject({ status: 'DELIVERED', payment_status: 'PAID', paid_method: 'UPI', pickup_ack: 'CODE' });
  });

  it('dispute from the pop-up stops the counter and opens a complaint; a correction asks again', async () => {
    const s = await newStudent();
    const o = await order(s.id, 3, 8);
    expect((await post(s.agent, `/api/me/orders/${o.body.id}/dispute`, { kind: 'DROPOFF', reason: '' })).status).toBe(400);
    const no = await post(s.agent, `/api/me/orders/${o.body.id}/dispute`, { kind: 'DROPOFF', reason: 'I gave 9 clothes, not 8' });
    expect(no.status, no.body.error).toBe(200);
    const d = (await staff.get(`/api/ops/orders/${o.body.id}`)).body;
    expect(d.dropoff_ack).toBe('DISPUTED');
    expect(d.confirm_requests[0]).toMatchObject({ kind: 'DROPOFF', status: 'DISPUTED', reason: 'I gave 9 clothes, not 8' });
    const blocked = await post(staff, `/api/ops/orders/${o.body.id}/confirm`, { kind: 'DROPOFF', code: '123456' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('I gave 9 clothes');
    expect((await s.agent.get('/api/me/complaints')).body.rows.some((c: { description: string }) => c.description.includes('I gave 9 clothes'))).toBe(true);
    expect(has((await staff.get('/api/ops/orders?status=DISPUTED')).body.rows, o.body.id)).toBe(true);
    const other = await newStudent();
    expect((await post(other.agent, `/api/me/orders/${o.body.id}/dispute`, { kind: 'DROPOFF', reason: 'not mine' })).status).toBe(404);
    // Recount and correct: the old request goes, the confirmation is reset, staff send a new code.
    expect((await staff.patch(`/api/ops/orders/${o.body.id}`).set('x-ej', '1').send({ weightKg: 3, clothesCount: 9, reason: 'Recounted with the student' })).status).toBe(200);
    expect((await staff.get(`/api/ops/orders/${o.body.id}`)).body).toMatchObject({ dropoff_ack: null, confirm_requests: [] });
    expect(has((await staff.get('/api/ops/orders?status=UNSIGNED')).body.rows, o.body.id)).toBe(true);
    await post(staff, `/api/ops/orders/${o.body.id}/confirm-request`, { kind: 'DROPOFF' });
    const p = await popup(s.agent, o.body.id, 'DROPOFF');
    expect(p!.statement).toContain('gave 9 clothes');
    expect((await post(staff, `/api/ops/orders/${o.body.id}/confirm`, { kind: 'DROPOFF', code: await codeOf(p!.key, o.body.id, 'DROPOFF') })).status).toBe(200);
    // Cancelling an order removes a waiting pickup request.
    const o2 = await order(s.id, 2, 4);
    await post(staff, `/api/ops/orders/${o2.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 4 });
    expect((await post(staff, `/api/ops/orders/${o2.body.id}/cancel`, { reason: 'Student took the clothes back' })).status).toBe(200);
    expect(await popup(s.agent, o2.body.id, 'PICKUP')).toBeUndefined();
  });

  it('walk-ins hand over at the counter; only the admin can skip the code, with a reason; settings can turn it off', async () => {
    const w = await post(staff, '/api/ops/walk-in', { name: 'Visitor Code', mobile: '9811177002' });
    const wo = await order(w.body.id, 2, 3);
    expect(wo.body.confirm_requests).toEqual([]);   // no app, no drop-off code
    expect((await post(staff, `/api/ops/orders/${wo.body.id}/confirm-request`, { kind: 'PICKUP', returnedCount: 3 })).status).toBe(409);
    const handed = await post(staff, `/api/ops/orders/${wo.body.id}/deliver`, { returnedCount: 3, payMethod: 'CASH' });
    expect(handed.status, handed.body.error).toBe(200);
    expect(handed.body.pickup_ack).toBe('COUNTER');

    const s = await newStudent();
    const o = await order(s.id, 2, 4);
    expect((await post(staff, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 4, override: 'Phone battery dead' })).status).toBe(403);
    expect((await post(admin, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 4, override: 'x' })).status).toBe(422);
    const over = await post(admin, `/api/ops/orders/${o.body.id}/deliver`, { returnedCount: 4, override: 'Phone battery dead; ID card checked' });
    expect(over.status, over.body.error).toBe(200);
    expect(over.body.pickup_ack).toBe('OVERRIDE');

    expect((await put(admin, '/api/admin/settings', { sign_dropoff: false, sign_pickup: false })).status).toBe(200);
    const o2 = await order(s.id, 2, 4);
    expect(o2.body.confirm_requests).toEqual([]);
    const plain = await post(staff, `/api/ops/orders/${o2.body.id}/deliver`, { returnedCount: 4 });
    expect(plain.status, plain.body.error).toBe(200);
    expect(plain.body.pickup_ack).toBeNull();
    await put(admin, '/api/admin/settings', { sign_dropoff: true, sign_pickup: true });
    // Backups carry the evidence.
    const backup = await admin.get('/api/admin/backup');
    if (backup.status === 200 && backup.body?.tables) expect(backup.body.tables.order_signoffs.length).toBeGreaterThan(0);
  });
});

describe('office claim registration', () => {
  const officeStudent = async (id: string, email = '') => {
    const result = await post(admin, '/api/admin/students', { idCardNo: id, name: 'Office Student', hostelId, roomNo: '102', email });
    expect(result.status, result.body.error).toBe(201);
    return result.body.codes[0] as { code: string; expires: string };
  };
  const claim = (identifier: string, code: string) => post(request.agent(app), '/api/auth/claim', { identifier, code });
  it('preserves an issued code on monthly import, accepts email and requires the missing profile details', async () => {
    const id = 'OFFICE101', email = 'office101@uni.test';
    const issued = await officeStudent(id, email);
    const buf = await xlsx([{ 'ID Card No': id, 'Full Name': 'Office Student', Mobile: '9811100101', Hostel: 'Test Hostel', Room: '102' }]);
    const upload = await admin.post('/api/admin/import/students').set('x-ej', '1').attach('file', buf, 'students.xlsx');
    expect(upload.body.codes).toEqual([]);
    const ticket = await claim(email.toUpperCase(), issued.code.toLowerCase().replace('-', ' '));
    expect(ticket.status, ticket.body.error).toBe(200);
    const a = request.agent(app);
    const body = { ticket: ticket.body.ticket, password: 'account-pass' };
    const saved = await post(a, '/api/auth/claim/password', body);
    expect(saved.status, saved.body.error).toBe(200);
    expect(saved.body.user.complete_profile).toBe(true);
    expect((await a.get('/api/me/home')).status).toBe(403);
    expect((await post(a, '/api/me/complete-profile', { mobile: '9811100101' })).status).toBe(400);
    expect((await post(a, '/api/auth/claim/password', body)).status).toBe(400);
    expect((await claim(id, issued.code)).status).toBe(400);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    expect((await a.post('/api/me/photo').set('x-ej', '1').attach('photo', png, 'profile.png')).status).toBe(200);
    expect((await post(a, '/api/me/complete-profile', { mobile: '9811100101' })).status).toBe(200);
    expect((await a.get('/api/me/home')).status).toBe(200);
    expect((await post(a, '/api/auth/login', { loginId: id, password: body.password })).body.user.id).toBe(saved.body.user.id);
  });
  it('replaces old codes and tickets only on explicit reissue, and rejects expired credentials', async () => {
    const { db } = await import('../server/db.js');
    const id = 'OFFICE102';
    const issued = await officeStudent(id);
    const { body } = await claim(id, issued.code);
    const student = (await admin.get('/api/ops/students?status=UNCLAIMED&q=' + id)).body.rows[0];
    const replacement = await post(admin, '/api/admin/students/reissue', { studentId: student.id });
    expect(replacement.status).toBe(200);
    expect((await post(request.agent(app), '/api/auth/claim/password', { ticket: body.ticket, password: 'account-pass' })).status).toBe(400);
    const old = await claim(id, issued.code);
    expect(old.status).toBe(400);
    expect((await claim('UNKNOWN101', issued.code)).body.error).toBe(old.body.error);
    const next = await claim(id, replacement.body.codes[0].code);
    expect(next.status).toBe(200);
    await db.run('UPDATE students SET claim_ticket_until = ?, claim_expires_at = ? WHERE user_id = ?', ['2000-01-01', '2000-01-01', student.id]);
    expect((await post(request.agent(app), '/api/auth/claim/password', { ticket: next.body.ticket, password: 'account-pass' })).status).toBe(400);
    expect((await claim(id, replacement.body.codes[0].code)).status).toBe(400);
  });
  it('limits an identifier to six attempts', async () => {
    for (let i = 0; i < 6; i++) expect((await claim('OFFICE103', 'invalid')).status).toBe(400);
    expect((await claim('OFFICE103', 'invalid')).status).toBe(429);
  });
});

describe('workspace isolation', () => {
  it('separates campus identities, staff lists, direct lookups, prices, orders and scoped settings', async () => {
    const campus = await post(admin, '/api/admin/workspaces', { name:'Test North University',code:'NORTH',hostels:['Test Hostel'],copy_from:1 });
    expect(campus.status,campus.body.error).toBe(201);
    const ws = String(campus.body.id);
    const north = (await admin.get('/api/public/info').set('x-ej-workspace',ws)).body.hostels;
    expect(north).toHaveLength(1);
    expect(north[0].id).not.toBe(hostelId);
    const seed = {idCardNo:'DUALCAMPUS',name:'Shared ID fixture',roomNo:'1',hostelId};
    const a = await post(admin,'/api/admin/students',seed);
    const b = await admin.post('/api/admin/students').set('x-ej','1').set('x-ej-workspace',ws).send({...seed,hostelId:north[0].id});
    expect(a.status).toBe(201);
    expect(b.status,b.body.error).toBe(201);
    expect((await staff.get('/api/ops/students').set('x-ej-workspace',ws)).status).toBe(403);
    const second = (await admin.get('/api/ops/students?q=DUALCAMPUS').set('x-ej-workspace',ws)).body.rows[0];
    expect((await staff.get('/api/ops/students/'+second.id)).status).toBe(404);
    const crossQuote = await post(staff,'/api/ops/quote',{studentId:second.id,weightKg:1,clothesCount:1});
    expect(crossQuote.status).toBe(404);
    const wrongHostel = await post(admin,'/api/admin/students',{...seed,idCardNo:'INVALIDHOSTEL',hostelId:north[0].id});
    expect(wrongHostel.status).toBe(400);
    const newOrder = await admin.post('/api/ops/orders').set('x-ej','1').set('x-ej-workspace',ws).send({studentId:second.id,weightKg:1,clothesCount:1});
    expect(newOrder.status,newOrder.body.error).toBe(201);
    expect(newOrder.body.order_no).toMatch(/^NORTH-/);
    expect((await staff.get('/api/ops/orders/'+newOrder.body.id)).status).toBe(404);
    expect((await staff.get('/api/ops/orders?q='+newOrder.body.order_no)).body.rows).toHaveLength(0);
    expect((await admin.patch('/api/admin/workspaces/'+ws).set('x-ej','1').send({status:'PAUSED'})).status).toBe(200);
    expect((await admin.post('/api/ops/orders').set('x-ej','1').set('x-ej-workspace',ws).send({studentId:second.id,weightKg:1,clothesCount:1})).status).toBe(409);
    expect((await admin.get('/api/ops/orders/'+newOrder.body.id).set('x-ej-workspace',ws)).status).toBe(200);
    const firstSettings = (await admin.get('/api/admin/settings')).body;
    const s = await admin.put('/api/admin/settings').set('x-ej','1').set('x-ej-workspace',ws).send({max_kg_per_order:12});
    expect(s.status,s.body.error).toBe(200);
    expect((await admin.get('/api/admin/settings')).body.max_kg_per_order).toBe(firstSettings.max_kg_per_order);
    const samePrefix = await admin.put('/api/admin/settings').set('x-ej','1').set('x-ej-workspace',ws).send({order_no_format:firstSettings.order_no_format});
    expect(samePrefix.status).toBe(409);
  });
});

describe('office scopes', () => {
  it('reconciles office report counts, keeps aggregate scopes read-only and limits the campus directory to administrators', async () => {
    const directory = await admin.get('/api/admin/workspaces').set('x-ej-workspace','-1').expect(200);
    const rows = directory.body.rows as {id:number;kind:string}[];
    expect(rows.filter(r => r.kind==='CAMPUS').length).toBeGreaterThan(1);
    const range = '/api/admin/report?from=2020-01-01&to=2099-12-31';
    const totals = async (id:number) => {
      const r=await admin.get(range).set('x-ej-workspace',String(id)).expect(200);
      return Number(r.body.totals.orders);
    };
    let campus=0,retail=0;
    for(const w of rows){const n=await totals(w.id); if(w.kind==='RETAIL') retail+=n; else campus+=n;}
    expect(await totals(-1)).toBe(campus+retail);
    expect(await totals(-2)).toBe(campus);
    await admin.put('/api/admin/settings').set('x-ej','1').set('x-ej-workspace','-1').send({max_active_orders:5}).expect(409);
    await staff.get('/api/admin/workspaces').set('x-ej-workspace','-1').expect(403);
    await staff.get('/api/ops/customers').expect(403);
  });
});
