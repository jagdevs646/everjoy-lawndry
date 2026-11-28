import { scopeReads, workspaceId } from './workspace-context.js';
import { migrateWorkspaces } from './workspace-migration.js';
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
import { nowIso, codeKey } from './util.js';

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
  // Neon URLs say sslmode=require. pg 8 already treats that as full certificate checking but will weaken it
  // in pg 9 (libpq semantics). Ask for verify-full explicitly so the connection stays fully verified.
  const connectionString = url.replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, '$1verify-full');
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 5),
    // sslmode in the URL (Neon adds sslmode=require) is honoured by pg itself; otherwise require verified TLS off-machine.
    ssl: local || /sslmode=/.test(url) ? undefined : { rejectUnauthorized: true },
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,   // Neon's free compute can take a few seconds to wake; don't wait forever
    query_timeout: 20_000,             // client-side cap per query (works through Neon's pooler)
    keepAlive: true,
  });
  // Neon restarts or suspends idle compute: a dropped idle connection must not crash the server.
  pool.on('error', err => console.error('Postgres idle connection error (will reconnect):', err.message));
  const wrap = (client: { query: (t: string, p: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }> }): Query =>
    async (sql, params) => { const r = await client.query(toPgPlaceholders(sql), params); return { rows: r.rows, changes: r.rowCount ?? 0 }; };
  return {
    dialect: 'postgres',
    query: wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // A connection that dies while checked out emits 'error' on the client: record it instead of crashing,
      // and destroy that connection on release so the pool doesn't hand it out again.
      let broken: Error | undefined;
      const onError = (e: Error) => { broken = e; };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        // Per-transaction limits (SET LOCAL ends with the transaction, safe behind a connection pooler):
        // a stuck request can't hold row locks, e.g. on the order-number counter, for long.
        await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'; SET LOCAL idle_in_transaction_session_timeout = '30s'");
        try {
          const result = await fn(wrap(client));
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        }
      } finally {
        client.off('error', onError);
        client.release(broken);
      }
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
    sql = scopeReads(sql, this.dialect === 'sqlite' ? 'main' : 'public');
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
    // FOR NO KEY UPDATE: excludes other lockRow callers on the same row, but (unlike FOR UPDATE) does not
    // block the FOR KEY SHARE locks Postgres takes for foreign-key checks, so inserting a complaint,
    // notification or event that references this row from another transaction can't deadlock with it.
    if (this.dialect === 'postgres') await this.run(`SELECT id FROM public.${table} WHERE id = ? AND id IN (SELECT id FROM ${table}) FOR NO KEY UPDATE`, [id]);
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
export const TABLES = ['users', 'hostels', 'students', 'settings', 'services', 'counters', 'orders', 'order_events', 'order_signoffs', 'notifications', 'announcements', 'complaints', 'complaint_updates', 'files', 'activity', 'workspaces', 'staff_workspaces', 'customers', 'workspace_settings', 'workspace_counters'] as const;

export async function migrate() {
  await migrateLegacySchema();
  await migrateWorkspaces();
}

export async function migrateLegacySchema() {
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
    CREATE TABLE IF NOT EXISTS services (
      id ${id},
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'KG' CHECK (unit IN ('KG','PIECE')),
      rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      hosteler_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      uses_allowance INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

  `);

  // Columns added after the first release. ADD COLUMN keeps existing data (Neon and local files).
  const add = [
    ['students', 'kind', "TEXT NOT NULL DEFAULT 'HOSTELER'"],      // HOSTELER | WALKIN
    ['students', 'valid_until', 'TEXT'],                            // hostel plan end (YYYY-MM-DD); NULL = no end set
    ['students', 'pending_hostel_id', 'INTEGER'],                   // room/hostel change waiting for staff approval
    ['students', 'pending_room_no', 'TEXT'],
    ['students', 'change_requested_at', 'TEXT'],
    ['students', 'claimable', 'INTEGER NOT NULL DEFAULT 0'],        // imported from Excel: student sets the password
    ['orders', 'service_id', 'INTEGER'],
    ['orders', 'service_name', 'TEXT'],
    ['orders', 'unit', 'TEXT'],
    ['orders', 'rate', 'DOUBLE PRECISION'],
    ['orders', 'charge_note', 'TEXT'],
    ['orders', 'plan_hosteler', 'INTEGER'],
    ['users', 'password_expires_at', 'TEXT'],                     // temporary passwords stop working after this
    ['students', 'claim_hash', 'TEXT'],                            // imported account: sha256 of the one-time claim code
    ['students', 'claim_expires_at', 'TEXT'],
    ['students', 'claim_ticket_hash', 'TEXT'],
    ['students', 'claim_ticket_until', 'TEXT'],
    ['students', 'claimed_at', 'TEXT'],
    ['students', 'complete_profile', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'photo', 'TEXT'],                                     // profile photo (files table name)
    ['students', 'email', 'TEXT'],                                  // university email: sign-in codes are sent here
    ['students', 'email_verified_at', 'TEXT'],
    ['students', 'valid_from', 'TEXT'],                             // hostel plan start (semester), YYYY-MM-DD
    ['orders', 'tag_no', 'TEXT'],
    ['students', 'left_at', 'TEXT'],                               // removed from the hostel list (left); history kept
    ['orders', 'order_key', 'TEXT'],                               // codeKey(order_no): an order no. is never given twice, however it is written
    ['orders', 'tag_key', 'TEXT'],                                 // codeKey(tag_no): one card on one open basket, however it is written
    ['orders', 'dropoff_ack', 'TEXT'],                             // student confirmed the drop-off: SIGNATURE | PHONE | DISPUTED (NULL = not yet)
    ['orders', 'dropoff_ack_at', 'TEXT'],
    ['orders', 'pickup_ack', 'TEXT'],                              // student confirmed the collection: SIGNATURE | PHONE | OVERRIDE (admin)
    ['orders', 'pickup_ack_at', 'TEXT'],
    ['orders', 'dropoff_needed', 'INTEGER NOT NULL DEFAULT 0'],        // 1 = the student must confirm this drop-off with the code
  ] as const;
  const added = new Set<string>();
  for (const [table, column, def] of add) {
    try {
      await db.driver.script(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      added.add(`${table}.${column}`);
    } catch (e) {
      if (!/duplicate column|already exists/i.test(String((e as Error).message))) throw e;
    }
  }

  // Older office claims already have an audit timestamp. Self-registrations have no claim date.
  await db.run(`UPDATE students SET claimed_at = (SELECT MIN(a.created_at) FROM activity a
    WHERE a.action = 'STUDENT_CLAIMED' AND a.actor_id = students.user_id)
    WHERE claimed_at IS NULL AND claimable = 0 AND user_id IN (SELECT actor_id FROM activity WHERE action = 'STUDENT_CLAIMED')`);
  await db.driver.script('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_claim_ticket ON students (claim_ticket_hash) WHERE claim_ticket_hash IS NOT NULL');

  // Sign-in codes waiting for the student to type them (see otp.ts).
  await db.driver.script(`CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id INTEGER, email TEXT NOT NULL, code_hash TEXT NOT NULL, payload TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  // One basket card can be on only one order that hasn't been collected yet (both SQLite and Postgres support this).
  // Two-sided register: every confirmation (or dispute) by the student, with the sentence they agreed to,
  // the signature image (files table), who was at the counter and a SHA-256 fingerprint. Never updated
  // except superseded_at (a correction asks the student to confirm again).
  await db.driver.script(`CREATE TABLE IF NOT EXISTS order_signoffs (
    id ${id}, order_id INTEGER NOT NULL REFERENCES orders(id), kind TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
    statement TEXT NOT NULL, signature TEXT, signature_sha TEXT, student_id INTEGER NOT NULL, staff_id INTEGER, reason TEXT,
    clothes INTEGER, returned_count INTEGER, ip TEXT, user_agent TEXT, proof_hash TEXT NOT NULL, created_at TEXT NOT NULL, superseded_at TEXT)`);
  await db.driver.script('CREATE INDEX IF NOT EXISTS idx_signoffs_order ON order_signoffs (order_id)');
  await db.driver.script('CREATE INDEX IF NOT EXISTS idx_signoffs_signature ON order_signoffs (signature)');
  // A confirmation the counter is waiting for: the student's app shows a 30-second code made from this
  // request's secret; staff type it in. One per order and kind (drop-off / pickup), expires after minutes.
  await db.driver.script(`CREATE TABLE IF NOT EXISTS confirm_requests (
    order_id INTEGER NOT NULL, kind TEXT NOT NULL, staff_id INTEGER NOT NULL, secret TEXT NOT NULL, returned_count INTEGER, note TEXT,
    pay_method TEXT, pay_ref TEXT, status TEXT NOT NULL DEFAULT 'WAITING', reason TEXT, tries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (order_id, kind))`);
  // Older: hand-over waiting for the student to confirm on their phone (no longer used).
  await db.driver.script(`CREATE TABLE IF NOT EXISTS handover_requests (
    order_id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL, returned_count INTEGER NOT NULL, note TEXT, pay_method TEXT, pay_ref TEXT,
    status TEXT NOT NULL DEFAULT 'WAITING', reason TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);

  // Open student orders from before the column: they too count as received only once the student
  // confirms with the code (or the admin overrides), unless the admin switched drop-off confirmation off.
  if (added.has('orders.dropoff_needed')) {
    await db.run(`UPDATE orders SET dropoff_needed = 1 WHERE status IN ('RECEIVED','WASHING','READY')
      AND student_id IN (SELECT user_id FROM students WHERE kind != 'WALKIN')
      AND COALESCE((SELECT value FROM settings WHERE key = 'sign_dropoff'), 'true') != 'false'`);
  }
  // Fill the keys for orders made before they existed. Order nos. were all EJ-<number> then.
  await db.run(`UPDATE orders SET order_key = REPLACE(UPPER(order_no), '-', '') WHERE order_key IS NULL`);
  for (const r of await db.all<{ id: number; tag_no: string }>('SELECT id, tag_no FROM orders WHERE tag_no IS NOT NULL AND tag_key IS NULL')) {
    await db.run('UPDATE orders SET tag_key = ? WHERE id = ?', [codeKey(r.tag_no), r.id]);
  }
  for (const sql of [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_key ON orders (order_key)',
  ]) {
    try { await db.driver.script(sql); } catch (e) { console.warn(`Could not add a uniqueness check (${(e as Error).message}). The app still checks before saving.`); }
  }
  // One account per university email (emails are new in this version, so no existing rows clash).
  await db.driver.script('DROP INDEX IF EXISTS idx_students_email');
  await db.driver.script('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_email_u ON students (lower(email)) WHERE email IS NOT NULL');
  // Wrong email codes per address, kept across challenges and restarts (stops slow guessing).
  await db.driver.script('CREATE TABLE IF NOT EXISTS otp_failures (email TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL)');
  // Emails sent per day and kind, so registrations can't use up the quota needed for sign-in codes.
  await db.driver.script('CREATE TABLE IF NOT EXISTS mail_counts (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind))');

  // Default services the first time (admin edits names and prices in Rules & pricing).
  const count = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM services');
  if (!Number(count?.c)) {
    const at = nowIso();
    // Upgrading a database that is already in use: keep what the admin had in effect. The old version
    // stored only settings that differed from its defaults (no charging over the limit, ₹0 extra, ₹0/kg).
    const inUse = Number((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users'))?.c) > 0;
    const old = Object.fromEntries((await db.all<{ key: string; value: string }>('SELECT key, value FROM settings')).map(r => {
      try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, null]; }
    }));
    const keep = async (key: string, value: unknown) => {
      if (key in old) return;
      await db.run('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,NULL) ON CONFLICT(key) DO NOTHING', [key, JSON.stringify(value), at]);
    };
    if (inUse) {
      await keep('allow_paid_extra', old.over_limit_action === 'CHARGE');
      await keep('extra_rate_per_kg', 0);
    }
    const oldRate = inUse && Number.isFinite(Number(old.regular_rate_per_kg)) ? Math.max(0, Number(old.regular_rate_per_kg)) : 0;
    const defaults: [string, 'KG' | 'PIECE', number, number, number, number][] = [
      ['Wash & fold', 'KG', Math.max(30, oldRate), oldRate, 1, 1],
      ['Wash + iron', 'KG', 50, 20, 1, 2],
      ['Ironing only', 'PIECE', 10, 10, 0, 3],
      ['Dry cleaning', 'PIECE', 80, 80, 0, 4],
    ];
    for (const [name, unit, rate, hostelerRate, usesAllowance, sort] of defaults) {
      await db.run('INSERT INTO services (name, unit, rate, hosteler_rate, uses_allowance, sort, created_at) VALUES (?,?,?,?,?,?,?)', [name, unit, rate, hostelerRate, usesAllowance, sort, at]);
    }
  }
}

/** Insert a row and return its new id (works on both engines via RETURNING). */
export async function insertId(sql: string, params: unknown[]): Promise<number> {
  const row = await db.get<{ id: number }>(`${sql} RETURNING id`, params);
  return Number(row!.id);
}

export async function logActivity(actorId: number | null, action: string, entity: string | null, entityId: unknown, detail = '') {
  await db.run(`INSERT INTO activity (workspace_id, actor_id, action, entity, entity_id, detail, created_at) VALUES (${workspaceId()}, ?,?,?,?,?,?)`,
    [actorId, action, entity, entityId == null ? null : String(entityId), detail, nowIso()]);
}

export async function notify(userId: number, title: string, body: string, orderId: number | null = null) {
  await db.run(`INSERT INTO notifications (workspace_id, user_id, title, body, order_id, created_at) VALUES (${workspaceId()}, ?,?,?,?,?)`,
    [userId, title, body, orderId, nowIso()]);
}

/** Atomic counter (call inside a transaction): the upsert locks the row, so no two orders share a number. */
export async function nextCounter(name: string, start: number) {
  const row = await db.get<{ value: number }>(
    'INSERT INTO workspace_counters (workspace_id, name, value) VALUES (?, ?, ?) ON CONFLICT(workspace_id,name) DO UPDATE SET value = workspace_counters.value + 1 RETURNING value',
    [workspaceId(), name, start]);
  return Number(row!.value);
}
