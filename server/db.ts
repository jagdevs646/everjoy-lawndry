/**
 * Database layer with two interchangeable engines:
 *
 *   - SQLite (better-sqlite3): local use, a college PC, and the default test run.
 *   - Postgres (pg): hosted use, e.g. a free Neon database for the Render deployment.
 *     Tests also run against PGlite (real Postgres compiled to WASM) to keep SQL portable.
 *
 * Engine choice: DATABASE_URL=postgres://… → Postgres; DATABASE_URL=pglite://memory → PGlite (tests);
 * otherwise SQLite at DB_PATH (default data/lawndry.db).
 *
 * All SQL in the app is written once, with `?` placeholders, in the common subset of both
 * dialects. Business code calls db.get/all/run; inside db.tx(fn) those calls automatically join
 * the open transaction (AsyncLocalStorage), so helpers don't need a connection passed around.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

export type Row = Record<string, any>;
export type Dialect = 'sqlite' | 'postgres';
type Result = { rows: Row[]; changes: number };
type Query = (sql: string, params: unknown[]) => Promise<Result>;

interface Driver {
  dialect: Dialect;
  /** Run one statement outside any transaction. */
  query: Query;
  /** Run fn with a connection that holds an open transaction. */
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  /** Run a multi-statement script (schema). */
  script(sql: string): Promise<void>;
  /** SQLite only: write a consistent copy of the database file. */
  backupFile?(dest: string): Promise<void>;
  close(): Promise<void>;
}

type TxStore = { q: Query; done: boolean };
const txContext = new AsyncLocalStorage<TxStore>();

/** JS values the drivers can't bind: booleans become 1/0, undefined becomes null. */
const normalise = (params: unknown[]) => params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));

/** `?` → `$1, $2…` for Postgres, skipping anything inside single-quoted literals. */
function toPgPlaceholders(sql: string) {
  let n = 0;
  let out = '';
  let inQuote = false;
  for (const ch of sql) {
    if (ch === "'") inQuote = !inQuote;
    out += !inQuote && ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/** A tiny FIFO lock: SQLite has one connection, so a transaction must not interleave with other requests. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    const prev = this.#tail;
    this.#tail = prev.then(() => next);
    await prev;
    return release;
  }
}

/* ------------------------------------------------------------------ SQLite */

async function sqliteDriver(file: string): Promise<Driver> {
  const { default: Database } = await import('better-sqlite3');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');      // readers never block the single writer
  conn.pragma('synchronous = NORMAL');    // safe with WAL, much faster commits
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  const cache = new Map<string, any>();
  const exec: Query = async (sql, params) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = conn.prepare(sql); cache.set(sql, stmt); }
    if (stmt.reader) { const rows = stmt.all(...params) as Row[]; return { rows, changes: rows.length }; }
    const info = stmt.run(...params);
    return { rows: [], changes: info.changes };
  };
  const mutex = new Mutex();
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      const release = await mutex.lock();
      try { return await exec(sql, params); } finally { release(); }
    },
    async transaction(fn) {
      const release = await mutex.lock();
      try {
        conn.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(exec);
          conn.exec('COMMIT');
          return result;
        } catch (e) {
          if (conn.inTransaction) conn.exec('ROLLBACK');
          throw e;
        }
      } finally { release(); }
    },
    async script(sql) { conn.exec(sql); },
    async backupFile(dest) { await conn.backup(dest); },
    async close() { conn.close(); },
  };
}

/* ---------------------------------------------------------------- Postgres */

async function pgDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  // COUNT(*) and SUM() come back as int8/numeric strings by default; the app works with numbers.
  pg.types.setTypeParser(20, v => parseInt(v, 10));
  pg.types.setTypeParser(1700, v => parseFloat(v));
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 5),
    ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true },
    idleTimeoutMillis: 30_000,
  });
  const wrap = (client: { query: (t: string, p: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }> }): Query =>
    async (sql, params) => { const r = await client.query(toPgPlaceholders(sql), params); return { rows: r.rows, changes: r.rowCount ?? 0 }; };
  return {
    dialect: 'postgres',
    query: wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const result = await fn(wrap(client));
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        }
      } finally { client.release(); }
    },
    async script(sql) { await pool.query(sql); },
    async close() { await pool.end(); },
  };
}

/** PGlite: an in-process Postgres, used to run the test suite against real Postgres SQL. */
async function pgliteDriver(): Promise<Driver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const toNumber = (v: string) => Number(v);
  const lite = new PGlite({ parsers: { 20: toNumber, 1700: toNumber } });
  await lite.waitReady;
  const wrap = (client: { query: (t: string, p: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Query =>
    async (sql, params) => { const r = await client.query(toPgPlaceholders(sql), params); return { rows: r.rows as Row[], changes: r.affectedRows ?? 0 }; };
  return {
    dialect: 'postgres',
    query: wrap(lite),
    transaction: fn => lite.transaction(tx => fn(wrap(tx))),
    async script(sql) { await lite.exec(sql); },
    async close() { await lite.close(); },
  };
}

/* --------------------------------------------------------------------- API */

class Db {
  #driver: Driver | null = null;
  #file: string | null = null;

  async open() {
    if (this.#driver) return;
    const url = process.env.DATABASE_URL || '';
    if (url.startsWith('pglite:')) this.#driver = await pgliteDriver();
    else if (/^postgres(ql)?:\/\//.test(url)) this.#driver = await pgDriver(url);
    else {
      const file = process.env.DB_PATH || path.resolve('data', 'lawndry.db');
      this.#driver = await sqliteDriver(file);
      this.#file = file === ':memory:' ? null : file;
    }
  }

  get driver() {
    if (!this.#driver) throw new Error('Database not opened yet. Call db.open() first.');
    return this.#driver;
  }
  get dialect(): Dialect { return this.driver.dialect; }
  /** True when the whole database is one file that can be copied (SQLite on disk). */
  get isFile() { return !!this.#file; }

  /** The current transaction's connection, or null. Using a finished transaction is a bug (a missing await). */
  #current(): Query | null {
    const store = txContext.getStore();
    if (!store) return null;
    if (store.done) throw new Error('Database used after its transaction finished. Is an await missing?');
    return store.q;
  }

  async run(sql: string, params: unknown[] = []): Promise<Result> {
    const p = normalise(params);
    const q = this.#current();
    return q ? q(sql, p) : this.driver.query(sql, p);
  }
  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.run(sql, params)).rows as T[];
  }
  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.run(sql, params)).rows[0] as T | undefined;
  }

  /**
   * Run fn in one transaction: everything commits together or nothing does.
   * Nested calls join the outer transaction.
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#current()) return fn();
    return this.driver.transaction(async q => {
      const store: TxStore = { q, done: false };
      try { return await txContext.run(store, fn); } finally { store.done = true; }
    });
  }

  /**
   * Lock a row for the rest of the transaction so two requests can't act on it at once
   * (e.g. two counters handing over the same slip). SQLite already runs one transaction at a time.
   */
  async lockRow(table: 'users' | 'orders' | 'complaints', id: number) {
    if (this.dialect === 'postgres') await this.run(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
  }

  async backupFile(dest: string) {
    if (!this.driver.backupFile || !this.#file) throw new Error('File backups are only available for a SQLite database on disk.');
    await this.driver.backupFile(dest);
  }

  async close() { await this.#driver?.close(); this.#driver = null; }

  /** Column types that differ between the two engines. */
  get types() {
    return this.dialect === 'sqlite'
      ? { id: 'INTEGER PRIMARY KEY', blob: 'BLOB' }
      : { id: 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY', blob: 'BYTEA' };
  }
}

export const db = new Db();

/** Every table, in an order that respects foreign keys (used for JSON backups). */
export const TABLES = ['users', 'hostels', 'students', 'settings', 'counters', 'orders', 'order_events', 'notifications', 'announcements', 'complaints', 'complaint_updates', 'files', 'activity'] as const;

export async function migrate() {
  const { id, blob } = db.types;
  await db.driver.script(`
    CREATE TABLE IF NOT EXISTS users (
      id ${id},
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
      id ${id},
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hostels_name ON hostels (lower(name));
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
    CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id ${id},
      order_no TEXT NOT NULL UNIQUE,
      student_id INTEGER NOT NULL REFERENCES users(id),
      hostel_name TEXT NOT NULL,
      room_no TEXT NOT NULL,
      mobile TEXT,
      weight_kg DOUBLE PRECISION NOT NULL,
      clothes_count INTEGER NOT NULL,
      service TEXT NOT NULL DEFAULT 'REGULAR' CHECK (service IN ('REGULAR','EXPRESS')),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','WASHING','READY','DELIVERED','CANCELLED')),
      within_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
      extra_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
      amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'NONE' CHECK (payment_status IN ('NONE','DUE','PAID','WAIVED')),
      paid_method TEXT,
      paid_ref TEXT,
      paid_at TEXT,
      paid_by INTEGER REFERENCES users(id),
      qr_token TEXT NOT NULL UNIQUE,
      request_id TEXT UNIQUE,
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
      id ${id},
      order_id INTEGER NOT NULL REFERENCES orders(id),
      type TEXT NOT NULL,
      note TEXT,
      by_user INTEGER REFERENCES users(id),
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
    CREATE TABLE IF NOT EXISTS notifications (
      id ${id},
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      order_id INTEGER REFERENCES orders(id),
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
    CREATE TABLE IF NOT EXISTS announcements (
      id ${id},
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      hostel_id INTEGER REFERENCES hostels(id),
      expires_on TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id ${id},
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
      id ${id},
      complaint_id INTEGER NOT NULL REFERENCES complaints(id),
      by_user INTEGER REFERENCES users(id),
      status TEXT,
      message TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id ${id},
      name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      data ${blob} NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id ${id},
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

/** Insert a row and return its new id (works on both engines via RETURNING). */
export async function insertId(sql: string, params: unknown[]): Promise<number> {
  const row = await db.get<{ id: number }>(`${sql} RETURNING id`, params);
  return Number(row!.id);
}

export async function logActivity(actorId: number | null, action: string, entity: string | null, entityId: unknown, detail = '') {
  await db.run('INSERT INTO activity (actor_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    [actorId, action, entity, entityId == null ? null : String(entityId), detail, nowIso()]);
}

export async function notify(userId: number, title: string, body: string, orderId: number | null = null) {
  await db.run('INSERT INTO notifications (user_id, title, body, order_id, created_at) VALUES (?,?,?,?,?)',
    [userId, title, body, orderId, nowIso()]);
}

/** Atomic counter (call inside a transaction): the upsert locks the row, so no two orders share a number. */
export async function nextCounter(name: string, start: number) {
  const row = await db.get<{ value: number }>(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = counters.value + 1 RETURNING value',
    [name, start]);
  return Number(row!.value);
}
