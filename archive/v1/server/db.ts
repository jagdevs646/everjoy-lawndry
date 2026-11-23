import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new Database(path.join(dataDir, 'everjoy.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

export function now() { return new Date().toISOString(); }
export function monthKey(date = new Date()) { return date.toISOString().slice(0, 7); }

export function initialiseDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','STAFF','STUDENT')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), student_no TEXT UNIQUE NOT NULL, department TEXT NOT NULL, batch TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), staff_no TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id), permission TEXT NOT NULL, UNIQUE(staff_id, permission));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pricing_rules (id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id), standard_rate REAL NOT NULL, excess_rate REAL NOT NULL, emergency_rate REAL NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS closures (id INTEGER PRIMARY KEY, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, reason TEXT NOT NULL, instructions TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS laundry_transactions (id INTEGER PRIMARY KEY, transaction_no TEXT UNIQUE NOT NULL, student_id INTEGER NOT NULL REFERENCES students(id), category_id INTEGER NOT NULL REFERENCES categories(id), submitted_by INTEGER NOT NULL REFERENCES users(id), collected_by INTEGER REFERENCES users(id), weight REAL NOT NULL, entitled_weight REAL NOT NULL, excess_weight REAL NOT NULL, base_charge REAL NOT NULL, excess_charge REAL NOT NULL, emergency_charge REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL, payment_status TEXT NOT NULL CHECK(payment_status IN ('NOT_REQUIRED','PENDING','PAID','FAILED')) DEFAULT 'NOT_REQUIRED', status TEXT NOT NULL CHECK(status IN ('RECEIVED','PROCESSING','WASHING','READY','COLLECTED','CANCELLED')) DEFAULT 'RECEIVED', service_type TEXT NOT NULL CHECK(service_type IN ('STANDARD','EMERGENCY')) DEFAULT 'STANDARD', qr_token TEXT UNIQUE NOT NULL, expected_completion TEXT NOT NULL, submitted_at TEXT NOT NULL, collected_at TEXT, month_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS status_history (id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES laundry_transactions(id), status TEXT NOT NULL, note TEXT, changed_by INTEGER REFERENCES users(id), changed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES laundry_transactions(id), amount REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','FAILED')), reference TEXT, provider TEXT, created_at TEXT NOT NULL, confirmed_at TEXT);
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, audience TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_recipients (id INTEGER PRIMARY KEY, notification_id INTEGER NOT NULL REFERENCES notifications(id), user_id INTEGER NOT NULL REFERENCES users(id), read_at TEXT, UNIQUE(notification_id, user_id));
    CREATE TABLE IF NOT EXISTS complaints (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id), transaction_id INTEGER REFERENCES laundry_transactions(id), subject TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'NORMAL', status TEXT NOT NULL DEFAULT 'OPEN', assigned_to INTEGER REFERENCES users(id), resolution_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS complaint_attachments (id INTEGER PRIMARY KEY, complaint_id INTEGER NOT NULL REFERENCES complaints(id), file_path TEXT NOT NULL, file_name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS report_exports (id INTEGER PRIMARY KEY, requested_by INTEGER NOT NULL REFERENCES users(id), report_type TEXT NOT NULL, filters_json TEXT NOT NULL, columns_json TEXT NOT NULL, row_count INTEGER, status TEXT NOT NULL, file_name TEXT, created_at TEXT NOT NULL, completed_at TEXT);
  `);
  if ((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count) return;
  const created = now();
  const addUser = db.prepare('INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)');
  const pass = bcrypt.hashSync('Everjoy@123', 10);
  const adminId = Number(addUser.run('admin@everjoy.local', pass, 'Asha Nair', 'ADMIN', created).lastInsertRowid);
  const staffUserId = Number(addUser.run('staff@everjoy.local', pass, 'Rahul Kumar', 'STAFF', created).lastInsertRowid);
  const studentUserId = Number(addUser.run('student@everjoy.local', pass, 'Priya Sharma', 'STUDENT', created).lastInsertRowid);
  const staffId = Number(db.prepare('INSERT INTO staff (user_id,staff_no) VALUES (?,?)').run(staffUserId, 'STF-001').lastInsertRowid);
  const studentId = Number(db.prepare('INSERT INTO students (user_id,student_no,department,batch) VALUES (?,?,?,?)').run(studentUserId, 'STU-2026-001', 'Computer Science', '2026').lastInsertRowid);
  ['LAUNDRY_PROCESS','LAUNDRY_COLLECT','REPORT_VIEW','REPORT_EXPORT','COMPLAINT_MANAGE'].forEach(p => db.prepare('INSERT INTO permissions (staff_id,permission) VALUES (?,?)').run(staffId, p));
  const defaults: Record<string, unknown> = { monthly_allowance_kg: 10, max_submission_kg: 5, max_submissions_month: 4, carry_forward_enabled: true, carry_forward_limit_kg: 2, carry_forward_validity_months: 1, emergency_enabled: true, emergency_max_kg: 3, processing_hours: 24, excess_requires_payment: true, closure_policy: 'BLOCK' };
  for (const [key, value] of Object.entries(defaults)) db.prepare('INSERT INTO settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)').run(key, JSON.stringify(value), created, adminId);
  const categoryId = Number(db.prepare('INSERT INTO categories (name,created_at) VALUES (?,?)').run('Wash & Fold', created).lastInsertRowid);
  db.prepare('INSERT INTO pricing_rules (category_id,standard_rate,excess_rate,emergency_rate,effective_from) VALUES (?,?,?,?,?)').run(categoryId, 0, 60, 40, '2026-01-01');
  db.prepare('INSERT INTO categories (name,created_at) VALUES (?,?)').run('Dry Clean', created);
  const dryId = (db.prepare('SELECT id FROM categories WHERE name=?').get('Dry Clean') as {id:number}).id;
  db.prepare('INSERT INTO pricing_rules (category_id,standard_rate,excess_rate,emergency_rate,effective_from) VALUES (?,?,?,?,?)').run(dryId, 80, 120, 50, '2026-01-01');
  audit(adminId, 'SEED_DATABASE', 'system', 'seed', 'Created local development data');
  createNotification(adminId, 'Welcome to EVERJOY LAUNDRY', 'Your digital laundry account is ready. Your monthly allowance is now visible in the app.', 'ALL_STUDENTS');
  void studentId;
}

export function setting<T>(key: string): T { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined; return JSON.parse(row?.value ?? 'null') as T; }
export function allSettings() { return Object.fromEntries((db.prepare('SELECT key,value FROM settings').all() as {key:string,value:string}[]).map(x => [x.key, JSON.parse(x.value)])); }
export function audit(actorId: number | null, action: string, entity: string, entityId: unknown, detail: string) { db.prepare('INSERT INTO audit_logs(actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)').run(actorId,action,entity,entityId == null ? null : String(entityId),detail,now()); }
export function createNotification(actorId: number, title: string, message: string, audience: string, studentIds?: number[]) {
  const id = Number(db.prepare('INSERT INTO notifications(title,message,audience,created_by,created_at) VALUES(?,?,?,?,?)').run(title,message,audience,actorId,now()).lastInsertRowid);
  const users = audience === 'ALL_STUDENTS' ? db.prepare('SELECT user_id FROM students WHERE active=1').all() as {user_id:number}[] : (studentIds ?? []).map(id => db.prepare('SELECT user_id FROM students WHERE id=?').get(id) as {user_id:number});
  const add = db.prepare('INSERT OR IGNORE INTO notification_recipients(notification_id,user_id) VALUES(?,?)'); users.forEach(u => add.run(id,u.user_id)); return id;
}
