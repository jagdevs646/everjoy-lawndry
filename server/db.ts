import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

const dbPath = process.env.DB_PATH || path.resolve('data', 'lawndry.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');      // readers never block the single writer
db.pragma('synchronous = NORMAL');    // safe with WAL, much faster commits
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

export const isMemoryDb = dbPath === ':memory:';

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('ADMIN','STAFF','STUDENT')),
      login_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mobile TEXT,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hostels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS students (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      id_card_no TEXT NOT NULL UNIQUE,
      hostel_id INTEGER NOT NULL REFERENCES hostels(id),
      room_no TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REJECTED','SUSPENDED')),
      review_note TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      student_id INTEGER NOT NULL REFERENCES users(id),
      hostel_name TEXT NOT NULL,          -- snapshot, like the paper register
      room_no TEXT NOT NULL,              -- snapshot
      mobile TEXT,                        -- snapshot
      weight_kg REAL NOT NULL,
      clothes_count INTEGER NOT NULL,
      service TEXT NOT NULL DEFAULT 'REGULAR' CHECK (service IN ('REGULAR','EXPRESS')),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','WASHING','READY','DELIVERED','CANCELLED')),
      within_kg REAL NOT NULL DEFAULT 0,
      extra_kg REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'NONE' CHECK (payment_status IN ('NONE','DUE','PAID','WAIVED')),
      paid_method TEXT,
      paid_ref TEXT,
      paid_at TEXT,
      paid_by INTEGER REFERENCES users(id),
      qr_token TEXT NOT NULL UNIQUE,
      request_id TEXT UNIQUE,             -- idempotency: a double tap cannot create two orders
      received_by INTEGER NOT NULL REFERENCES users(id),
      received_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      expected_at TEXT NOT NULL,
      ready_at TEXT,
      delivered_by INTEGER REFERENCES users(id),
      delivered_at TEXT,
      returned_count INTEGER,
      cancel_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_student_month ON orders(student_id, month_key);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(day_key);
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      type TEXT NOT NULL,
      note TEXT,
      by_user INTEGER REFERENCES users(id),
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      order_id INTEGER REFERENCES orders(id),
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      hostel_id INTEGER REFERENCES hostels(id),   -- NULL = everyone
      expires_on TEXT,                             -- YYYY-MM-DD, NULL = no expiry
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER REFERENCES orders(id),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      photo TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaint_updates (
      id INTEGER PRIMARY KEY,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id),
      by_user INTEGER REFERENCES users(id),
      status TEXT,
      message TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT,
      entity_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at);
  `);
}

export function logActivity(actorId: number | null, action: string, entity: string | null, entityId: unknown, detail = '') {
  db.prepare('INSERT INTO activity (actor_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(actorId, action, entity, entityId == null ? null : String(entityId), detail, nowIso());
}

export function notify(userId: number, title: string, body: string, orderId: number | null = null) {
  db.prepare('INSERT INTO notifications (user_id, title, body, order_id, created_at) VALUES (?,?,?,?,?)')
    .run(userId, title, body, orderId, nowIso());
}

/** Atomic counter (call inside a transaction). better-sqlite3 serialises writes, so no two orders share a number. */
export function nextCounter(name: string, start: number) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name, start);
  return (db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number }).value;
}
