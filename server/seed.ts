import bcrypt from 'bcryptjs';
import { db, logActivity } from './db.js';
import { createOrder, deliverOrder, recordPayment, saveSettings, setStatus } from './rules.js';
import { dayKey, monthKey, nowIso } from './util.js';

const DEMO_PASSWORD = 'Everjoy@123';

/** Every install needs one admin. Outside demo mode the admin must change the password on first sign-in. */
export function ensureAdmin(demo: boolean) {
  if (db.prepare(`SELECT 1 FROM users WHERE role = 'ADMIN'`).get()) return;
  const password = process.env.ADMIN_PASSWORD || DEMO_PASSWORD;
  db.prepare(`INSERT INTO users (role, login_id, name, password_hash, must_change_password, created_at) VALUES ('ADMIN','ADMIN',?,?,?,?)`)
    .run(demo ? 'Asha Nair' : 'Laundry Admin', bcrypt.hashSync(password, 10), demo ? 0 : 1, nowIso());
  console.log(`Created admin account → username: ADMIN  password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : DEMO_PASSWORD}`);
}

/** Realistic sample data for trying the site locally. Runs once, only on an empty database, only with --demo. */
export function seedDemo() {
  if (db.prepare('SELECT 1 FROM hostels').get()) return;
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const at = nowIso();
  const admin = (db.prepare(`SELECT id FROM users WHERE role = 'ADMIN'`).get() as { id: number }).id;

  const hostel: Record<string, number> = {};
  for (const name of ['Boys Hostel 1', 'Boys Hostel 2', 'Girls Hostel 1', 'Girls Hostel 2']) hostel[name] = Number(db.prepare('INSERT INTO hostels (name) VALUES (?)').run(name).lastInsertRowid);

  const addUser = db.prepare('INSERT INTO users (role, login_id, name, mobile, password_hash, created_at) VALUES (?,?,?,?,?,?)');
  const staff = [['STAFF1', 'Ramesh Yadav', '9811100001'], ['STAFF2', 'Sunita Devi', '9811100002']].map(([login, name, mobile]) => Number(addUser.run('STAFF', login, name, mobile, hash, at).lastInsertRowid));

  const people: [string, string, string, string, string, string][] = [
    ['EJ2026001', 'Priya Sharma', '9876500001', 'Girls Hostel 1', '214', 'ACTIVE'],
    ['EJ2026002', 'Arjun Mehta', '9876500002', 'Boys Hostel 2', 'B-108', 'ACTIVE'],
    ['EJ2026003', 'Sana Khan', '9876500003', 'Girls Hostel 1', '118', 'ACTIVE'],
    ['EJ2026004', 'Rohan Das', '9876500004', 'Boys Hostel 1', 'A-302', 'ACTIVE'],
    ['EJ2026005', 'Ishita Verma', '9876500005', 'Girls Hostel 2', '007', 'ACTIVE'],
    ['EJ2026006', 'Kabir Singh', '9876500006', 'Boys Hostel 2', 'B-221', 'ACTIVE'],
    ['EJ2026007', 'Neha Joshi', '9876500007', 'Girls Hostel 2', '105', 'PENDING'],
  ];
  const students = people.map(([idCard, name, mobile, h, room, status]) => {
    const id = Number(addUser.run('STUDENT', idCard, name, mobile, hash, at).lastInsertRowid);
    db.prepare('INSERT INTO students (user_id, id_card_no, hostel_id, room_no, status, reviewed_by, reviewed_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, idCard, hostel[h], room, status, status === 'ACTIVE' ? staff[0] : null, status === 'ACTIVE' ? at : null);
    return id;
  });

  saveSettings(admin, { monthly_kg_limit: 40, over_limit_action: 'CHARGE', extra_rate_per_kg: 25, express_enabled: true, express_fee: 30 });

  // Two weeks of history so the admin charts and reports have something to show.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = 13; d >= 1; d--) {
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const student = students[Math.floor(rand() * 6)];
      const weight = Math.round((2 + rand() * 4.8) * 10) / 10;
      const o = createOrder(staff[i % 2], { studentId: student, weightKg: weight, clothesCount: 6 + Math.floor(rand() * 18), service: rand() > 0.85 ? 'EXPRESS' : 'REGULAR', note: '' });
      setStatus(staff[0], [o.id], 'WASHING');
      setStatus(staff[1], [o.id], 'READY');
      const row = db.prepare('SELECT payment_status, clothes_count FROM orders WHERE id = ?').get(o.id) as { payment_status: string; clothes_count: number };
      if (row.payment_status === 'DUE') recordPayment(staff[1], o.id, rand() > 0.5 ? 'UPI' : 'CASH');
      deliverOrder(staff[(i + 1) % 2], o.id, row.clothes_count, '');
      const received = new Date(Date.now() - d * 86400_000);
      received.setUTCHours(3 + Math.floor(rand() * 9), Math.floor(rand() * 60));
      shiftOrder(o.id, received, true);
    }
  }
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM activity').run();

  // Current state of the counter: something in every column.
  const [priya, arjun, sana, rohan, ishita] = students;
  const ready = createOrder(staff[0], { studentId: priya, weightKg: 4.2, clothesCount: 14, service: 'REGULAR', note: '1 bedsheet' });
  setStatus(staff[0], [ready.id], 'WASHING');
  setStatus(staff[0], [ready.id], 'READY');
  const washing = createOrder(staff[0], { studentId: priya, weightKg: 2.6, clothesCount: 9, service: 'EXPRESS', note: '' });
  setStatus(staff[1], [washing.id], 'WASHING');
  const late = createOrder(staff[1], { studentId: arjun, weightKg: 6.4, clothesCount: 21, service: 'REGULAR', note: '' });
  shiftOrder(late.id, new Date(Date.now() - 3 * 86400_000));
  createOrder(staff[1], { studentId: sana, weightKg: 3.1, clothesCount: 11, service: 'REGULAR', note: '' });
  const ready2 = createOrder(staff[0], { studentId: rohan, weightKg: 5.5, clothesCount: 17, service: 'REGULAR', note: '' });
  setStatus(staff[0], [ready2.id], 'READY');
  createOrder(staff[0], { studentId: ishita, weightKg: 1.8, clothesCount: 6, service: 'EXPRESS', note: 'Kurta — gentle wash' });

  const delivered = db.prepare(`SELECT id FROM orders WHERE student_id = ? AND status = 'DELIVERED' ORDER BY id DESC LIMIT 1`).get(priya) as { id: number };
  const c = Number(db.prepare('INSERT INTO complaints (student_id, order_id, category, description, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(priya, delivered.id, 'Missing clothes', 'One white T-shirt is missing from my last order. It has my name written on the label.', at, at).lastInsertRowid);
  db.prepare('INSERT INTO complaint_updates (complaint_id, by_user, status, message, at) VALUES (?,?,?,?,?)').run(c, priya, 'OPEN', null, at);

  db.prepare('INSERT INTO announcements (title, body, created_by, created_at) VALUES (?,?,?,?)')
    .run('Counter closed on Sunday', 'The laundry counter stays closed this Sunday for machine servicing. Orders given on Saturday will be ready on Monday evening.', admin, at);
  logActivity(admin, 'DEMO_SEEDED', 'system', null, 'Sample hostels, staff, students and orders');
  console.log(`Demo data ready → staff: STAFF1 · students: EJ2026001…EJ2026007 · password for all: ${DEMO_PASSWORD}`);
}

/**
 * Move an order back in time. With `spread`, the timeline is also spaced out
 * like a real day at the counter (washing +2 h, ready +24 h, handed over +28 h).
 */
function shiftOrder(id: number, received: Date, spread = false) {
  const base = received.getTime();
  const offsetHours: Record<string, number> = { RECEIVED: 0, WASHING: 2, READY: 24, PAID: 28, DELIVERED: 28.1 };
  const o = db.prepare('SELECT received_at, expected_at, ready_at, delivered_at, paid_at FROM orders WHERE id = ?').get(id) as Record<string, string | null>;
  const delta = base - Date.parse(o.received_at!);
  const move = (v: string | null) => (v ? new Date(Date.parse(v) + delta).toISOString() : null);
  const at = (type: string, v: string | null) => (spread && v ? new Date(Math.min(base + offsetHours[type] * 3600_000, Date.now() - 60_000)).toISOString() : move(v));
  db.prepare('UPDATE orders SET received_at = ?, expected_at = ?, ready_at = ?, delivered_at = ?, paid_at = ?, day_key = ?, month_key = ?, updated_at = ? WHERE id = ?')
    .run(move(o.received_at), move(o.expected_at), at('READY', o.ready_at), at('DELIVERED', o.delivered_at), at('PAID', o.paid_at), dayKey(received), monthKey(received), nowIso(), id);
  for (const e of db.prepare('SELECT id, type, at FROM order_events WHERE order_id = ?').all(id) as { id: number; type: string; at: string }[]) {
    db.prepare('UPDATE order_events SET at = ? WHERE id = ?').run(spread && e.type in offsetHours ? at(e.type, e.at) : move(e.at), e.id);
  }
}
