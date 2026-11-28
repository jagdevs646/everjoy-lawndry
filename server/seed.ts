import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, insertId, logActivity } from './db.js';
import { createOrder, deliverOrder, recordPayment, saveSettings, setStatus } from './rules.js';
import { dayKey, monthKey, nowIso } from './util.js';

const DEMO_PASSWORD = 'Everjoy@123';

/**
 * Every install needs one admin. Outside demo mode the admin must change the password on first sign-in.
 * On a production server without ADMIN_PASSWORD the admin gets a random password (printed once), so a
 * public server never starts with a guessable admin password, demo or not.
 */
export async function ensureAdmin(demo: boolean) {
  if (await db.get(`SELECT 1 AS one FROM users WHERE role = 'ADMIN' LIMIT 1`)) return;
  const fromEnv = process.env.ADMIN_PASSWORD;
  const generated = !fromEnv && process.env.NODE_ENV === 'production';
  const password = fromEnv || (generated ? crypto.randomBytes(9).toString('base64url') : DEMO_PASSWORD);
  await db.run(`INSERT INTO users (role, login_id, name, password_hash, must_change_password, created_at) VALUES ('ADMIN','ADMIN',?,?,?,?)`,
    // Only a local demo skips the forced change; any real server makes the admin choose a password.
    [demo ? 'Asha Nair' : 'Laundry Admin', await bcrypt.hash(password, 10), demo && process.env.NODE_ENV !== 'production' ? 0 : 1, nowIso()]);
  if (generated) console.log(`First admin account → username: ADMIN  password: ${password}  (change it after signing in)`);
  else console.log(`Created admin account → username: ADMIN  password: ${fromEnv ? '(from ADMIN_PASSWORD)' : DEMO_PASSWORD}`);
}

/** Realistic sample data for trying the site locally. Runs once, only on an empty database, only with --demo. */
export async function seedDemo() {
  // One transaction: a seed that fails halfway leaves nothing behind (and so runs again next start).
  const seeded = await db.tx(async () => {
    if (await db.get('SELECT 1 AS one FROM hostels LIMIT 1')) return false;
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const at = nowIso();
    const admin = (await db.get<{ id: number }>(`SELECT id FROM users WHERE role = 'ADMIN'`))!.id;

    const hostel: Record<string, number> = {};
    for (const name of ['Boys Hostel 1', 'Boys Hostel 2', 'Girls Hostel 1', 'Girls Hostel 2']) hostel[name] = await insertId('INSERT INTO hostels (name) VALUES (?)', [name]);

    const addUser = (role: string, login: string, name: string, mobile: string) =>
      insertId('INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES (?,?,?,?,?,?)', [role, login, name, mobile, hash, at]);
    const staff: number[] = [];
    for (const [login, name, mobile] of [['STAFF1', 'Ramesh Yadav', '9811100001'], ['STAFF2', 'Sunita Devi', '9811100002']]) staff.push(await addUser('STAFF', login, name, mobile));

    for (const id of staff) await db.run('INSERT INTO staff_workspaces(user_id,workspace_id) VALUES (?,1)',[id]);

    const people: [string, string, string, string, string, string][] = [
      ['EJ2026001', 'Priya Sharma', '9876500001', 'Girls Hostel 1', '214', 'ACTIVE'],
      ['EJ2026002', 'Arjun Mehta', '9876500002', 'Boys Hostel 2', 'B-108', 'ACTIVE'],
      ['EJ2026003', 'Sana Khan', '9876500003', 'Girls Hostel 1', '118', 'ACTIVE'],
      ['EJ2026004', 'Rohan Das', '9876500004', 'Boys Hostel 1', 'A-302', 'ACTIVE'],
      ['EJ2026005', 'Ishita Verma', '9876500005', 'Girls Hostel 2', '007', 'ACTIVE'],
      ['EJ2026006', 'Kabir Singh', '9876500006', 'Boys Hostel 2', 'B-221', 'ACTIVE'],
      ['EJ2026007', 'Neha Joshi', '9876500007', 'Girls Hostel 2', '105', 'PENDING'],
    ];
    const students: number[] = [];
    for (const [idCard, name, mobile, h, room, status] of people) {
      const id = await addUser('STUDENT', idCard, name, mobile);
      await db.run('INSERT INTO students (user_id, id_card_no, hostel_id, room_no, status, reviewed_by, reviewed_at) VALUES (?,?,?,?,?,?,?)',
        [id, idCard, hostel[h], room, status, status === 'ACTIVE' ? staff[0] : null, status === 'ACTIVE' ? at : null]);
      students.push(id);
    }

    await saveSettings(admin, { monthly_kg_limit: 40, over_limit_action: 'CHARGE', extra_rate_per_kg: 25, express_enabled: true, express_fee: 30 });

    // Demo orders: the student gave the code at the counter (one order below is left waiting for it).
    const demoOrder = async (...a: Parameters<typeof createOrder>) => {
      const o = await createOrder(...a);
      await db.run(`UPDATE orders SET dropoff_ack = 'CODE', dropoff_ack_at = received_at WHERE id = ?`, [o.id]);
      return o;
    };

    // Two weeks of history so the admin charts and reports have something to show.
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let d = 13; d >= 1; d--) {
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const student = students[Math.floor(rand() * 6)];
        const weight = Math.round((2 + rand() * 4.8) * 10) / 10;
        const o = await demoOrder(staff[i % 2], { studentId: student, weightKg: weight, clothesCount: 6 + Math.floor(rand() * 18), service: rand() > 0.85 ? 'EXPRESS' : 'REGULAR', note: '' });
        await setStatus(staff[0], [o.id], 'WASHING');
        await setStatus(staff[1], [o.id], 'READY');
        const row = (await db.get<{ payment_status: string; clothes_count: number }>('SELECT payment_status, clothes_count FROM orders WHERE id = ?', [o.id]))!;
        if (row.payment_status === 'DUE') await recordPayment(staff[1], o.id, rand() > 0.5 ? 'UPI' : 'CASH');
        await deliverOrder(staff[(i + 1) % 2], o.id, row.clothes_count, '', { method: 'CODE' });   // demo: the student confirmed with the code
        const received = new Date(Date.now() - d * 86400_000);
        received.setUTCHours(3 + Math.floor(rand() * 9), Math.floor(rand() * 60));
        await shiftOrder(o.id, received, true);
      }
    }
    await db.run('DELETE FROM notifications');
    await db.run('DELETE FROM activity');

    // Current state of the counter: something in every column.
    const [priya, arjun, sana, rohan, ishita] = students;
    const ready = await demoOrder(staff[0], { studentId: priya, weightKg: 4.2, clothesCount: 14, service: 'REGULAR', note: '1 bedsheet' });
    await setStatus(staff[0], [ready.id], 'WASHING');
    await setStatus(staff[0], [ready.id], 'READY');
    const washing = await demoOrder(staff[0], { studentId: priya, weightKg: 2.6, clothesCount: 9, service: 'EXPRESS', note: '' });
    await setStatus(staff[1], [washing.id], 'WASHING');
    const late = await demoOrder(staff[1], { studentId: arjun, weightKg: 6.4, clothesCount: 21, service: 'REGULAR', note: '' });
    await shiftOrder(late.id, new Date(Date.now() - 3 * 86400_000));
    await demoOrder(staff[1], { studentId: sana, weightKg: 3.1, clothesCount: 11, service: 'REGULAR', note: '' });
    const ready2 = await demoOrder(staff[0], { studentId: rohan, weightKg: 5.5, clothesCount: 17, service: 'REGULAR', note: '' });
    await setStatus(staff[0], [ready2.id], 'READY');
    await createOrder(staff[0], { studentId: ishita, weightKg: 1.8, clothesCount: 6, service: 'EXPRESS', note: 'Kurta — gentle wash' });

    const delivered = (await db.get<{ id: number }>(`SELECT id FROM orders WHERE student_id = ? AND status = 'DELIVERED' ORDER BY id DESC LIMIT 1`, [priya]))!;
    const c = await insertId('INSERT INTO complaints (student_id, order_id, category, description, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [priya, delivered.id, 'Missing clothes', 'One white T-shirt is missing from my last order. It has my name written on the label.', at, at]);
    await db.run('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)', [c, priya, 'OPEN', null, at]);

    await db.run('INSERT INTO announcements (title, body, created_by, created_at) VALUES (?,?,?,?)',
      ['Counter closed on Sunday', 'The laundry counter stays closed this Sunday for machine servicing. Orders given on Saturday will be ready on Monday evening.', admin, at]);
    await logActivity(admin, 'DEMO_SEEDED', 'system', null, 'Sample hostels, staff, students and orders');
    return true;
  });
  if (seeded) console.log(`Demo data ready → staff: STAFF1 · students: EJ2026001…EJ2026007 · password for all: ${DEMO_PASSWORD}`);
}

/**
 * Move an order back in time. With `spread`, the timeline is also spaced out
 * like a real day at the counter (washing +2 h, ready +24 h, handed over +28 h).
 */
async function shiftOrder(id: number, received: Date, spread = false) {
  const base = received.getTime();
  const offsetHours: Record<string, number> = { RECEIVED: 0, WASHING: 2, READY: 24, PAID: 28, DELIVERED: 28.1 };
  const o = (await db.get<Record<string, string | null>>('SELECT received_at, expected_at, ready_at, delivered_at, paid_at FROM orders WHERE id = ?', [id]))!;
  const delta = base - Date.parse(o.received_at!);
  const move = (v: string | null) => (v ? new Date(Date.parse(v) + delta).toISOString() : null);
  const at = (type: string, v: string | null) => (spread && v ? new Date(Math.min(base + offsetHours[type] * 3600_000, Date.now() - 60_000)).toISOString() : move(v));
  await db.run('UPDATE orders SET received_at = ?, expected_at = ?, ready_at = ?, delivered_at = ?, paid_at = ?, day_key = ?, month_key = ?, updated_at = ? WHERE id = ?',
    [move(o.received_at), move(o.expected_at), at('READY', o.ready_at), at('DELIVERED', o.delivered_at), at('PAID', o.paid_at), dayKey(received), monthKey(received), nowIso(), id]);
  for (const e of await db.all<{ id: number; type: string; at: string }>('SELECT id, type, at FROM order_events WHERE order_id = ?', [id])) {
    await db.run('UPDATE order_events SET at = ? WHERE id = ?', [spread && e.type in offsetHours ? at(e.type, e.at) : move(e.at), e.id]);
  }
}
