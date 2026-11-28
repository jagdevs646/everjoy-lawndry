import { db, type Row } from './db.js';
import { workspaceTables } from './workspace-context.js';

async function relaxSqliteIdentity(table: 'users' | 'students', column: 'login_id' | 'id_card_no') {
  const schema = await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  if (!schema) throw new Error('Missing identity table: ' + table);
  const unique = new RegExp(column + '\\s+TEXT\\s+NOT NULL\\s+UNIQUE', 'i');
  if (!unique.test(schema.sql)) throw new Error('Unexpected identity definition for ' + table);
  const indexes = await db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL", [table]);
  const columns = (await db.all<{ name: string }>('PRAGMA table_info(' + table + ')')).map(c => '"' + c.name.replaceAll('"', '""') + '"').join(', ');
  const replacement = 'migrate_' + table;
  const create = schema.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?\w+["`]?/i, 'CREATE TABLE ' + replacement)
    .replace(unique, column + (table === 'students' ? ' TEXT NOT NULL' : ' TEXT'));
  await db.driver.script(create);
  await db.run(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
  const rows = await db.get<Row>(`SELECT (SELECT COUNT(*) FROM ${table}) AS originals, (SELECT COUNT(*) FROM ${replacement}) AS copies`);
  if (rows?.originals !== rows?.copies) throw new Error('Identity migration count mismatch');
  await db.driver.script(`DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table}`);
  for (const index of indexes) await db.driver.script(index.sql);
}

/** Run once at startup. The copy and constraint changes commit together. */
export async function migrateWorkspaces() {
  const { id } = db.types;
  await db.driver.script('CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY)');
  if (await db.get("SELECT name FROM schema_versions WHERE name = 'hybrid-workspaces'")) return;
  const sqlite = db.dialect === 'sqlite';
  // SQLite requires foreign_keys to be disabled before BEGIN when rebuilding a referenced parent.
  // No requests are accepted during startup. Every relationship is checked before COMMIT.
  if (sqlite) await db.driver.script('PRAGMA foreign_keys=OFF');
  try {
    await db.tx(async () => {
      if (!sqlite) await db.run('LOCK TABLE schema_versions IN EXCLUSIVE MODE');
      if (await db.get("SELECT name FROM schema_versions WHERE name = 'hybrid-workspaces'")) return;
      await db.run(`CREATE TABLE workspaces (
        id ${id}, kind TEXT NOT NULL CHECK(kind IN ('CAMPUS','RETAIL')), name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED')), timezone TEXT NOT NULL,
        contact_name TEXT, contact_phone TEXT, contract_from TEXT, contract_until TEXT, monthly_value DOUBLE PRECISION, notes TEXT)`);
      await db.run("INSERT INTO workspaces(kind,name,code,timezone) VALUES ('CAMPUS','Campus','CAMPUS',?), ('RETAIL','Everjoy Customers','RETAIL',?)",
        [process.env.APP_TZ || 'Asia/Kolkata', process.env.APP_TZ || 'Asia/Kolkata']);
      await db.run('CREATE TABLE staff_workspaces (user_id INTEGER NOT NULL REFERENCES users(id), workspace_id INTEGER NOT NULL REFERENCES workspaces(id), PRIMARY KEY(user_id,workspace_id))');
      await db.run("INSERT INTO staff_workspaces SELECT id,1 FROM users WHERE role='STAFF'");
      await db.run(`CREATE TABLE customers (user_id INTEGER PRIMARY KEY REFERENCES users(id), workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        mobile TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', email TEXT, verified_at TEXT, claim_hash TEXT, claim_expires_at TEXT,
        UNIQUE(workspace_id,mobile))`);
      await db.run(`CREATE TABLE workspace_settings (workspace_id INTEGER NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL,
        value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), PRIMARY KEY(workspace_id,key))`);
      await db.run('CREATE TABLE workspace_counters (workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(workspace_id,name))');
      await db.run('INSERT INTO workspace_settings SELECT 1,key,value,updated_at,updated_by FROM settings');
      await db.run('INSERT INTO workspace_counters SELECT 1,name,value FROM counters');
      await db.run("INSERT INTO workspace_settings (workspace_id,key,value,updated_at) VALUES (2,'order_no_format',?,?)",
        [JSON.stringify({prefix:'RETAIL-',suffix:'',pad:0,start:1001,reset:'NEVER'}), new Date().toISOString()]);
      for (const table of workspaceTables) {
        if (['customers','workspace_settings','workspace_counters'].includes(table)) continue;
        await db.run(`ALTER TABLE ${table} ADD COLUMN workspace_id INTEGER ${table === 'activity' ? '' : 'NOT NULL'} DEFAULT 1`);
        await db.run(`CREATE INDEX idx_scope_${table} ON ${table}(workspace_id)`);
      }
      await db.run("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'MEMBER'");
      await db.run("ALTER TABLE orders ADD COLUMN customer_type TEXT NOT NULL DEFAULT 'STUDENT'");
      await db.run('ALTER TABLE orders ADD COLUMN intake_mode TEXT');
      if (sqlite) {
        await relaxSqliteIdentity('users','login_id');
        await relaxSqliteIdentity('students','id_card_no');
      } else {
        await db.run('ALTER TABLE users DROP CONSTRAINT users_login_id_key, ALTER COLUMN login_id DROP NOT NULL');
        await db.run('ALTER TABLE students DROP CONSTRAINT students_id_card_no_key');
      }
      await db.run('CREATE VIEW actor_names AS SELECT id,name,role FROM users');
      await db.run("CREATE UNIQUE INDEX idx_staff_login ON users(login_id) WHERE role IN ('STAFF','ADMIN')");
      await db.run("CREATE UNIQUE INDEX idx_member_login ON users(workspace_id,login_id) WHERE role='STUDENT'");
      await db.run('CREATE UNIQUE INDEX idx_campus_student_card ON students(workspace_id,id_card_no)');
      await db.run('DROP INDEX IF EXISTS idx_hostels_name');
      await db.run('DROP INDEX IF EXISTS idx_services_name');
      await db.run('DROP INDEX IF EXISTS idx_orders_open_tag');
      await db.run('DROP INDEX IF EXISTS idx_orders_open_tag_key');
      await db.run('CREATE UNIQUE INDEX idx_campus_hostel ON hostels(workspace_id,lower(name))');
      await db.run('CREATE UNIQUE INDEX idx_workspace_service ON services(workspace_id,lower(name))');
      await db.run("CREATE UNIQUE INDEX idx_workspace_open_card ON orders(workspace_id,tag_key) WHERE tag_key IS NOT NULL AND status IN ('RECEIVED','WASHING','READY')");
      await db.run(`INSERT INTO services(workspace_id,name,unit,rate,hosteler_rate,uses_allowance,active,sort,created_at)
        SELECT 2,name,unit,rate,0,0,active,sort,created_at FROM services WHERE workspace_id=1`);
      await db.run(`INSERT INTO customers (user_id,workspace_id,mobile)
        SELECT u.id,2,u.mobile FROM users u JOIN students s ON s.user_id=u.id WHERE s.kind='WALKIN'`);
      await db.run("UPDATE users SET workspace_id=2,account_type='GUEST',active=0,login_id=NULL WHERE id IN (SELECT user_id FROM customers)");
      await db.run("UPDATE students SET workspace_id=2 WHERE kind='WALKIN'");
      await db.run("UPDATE orders SET workspace_id=2,customer_type='NON_STUDENT' WHERE student_id IN (SELECT user_id FROM customers)");
      for (const t of ['order_events','order_signoffs','confirm_requests','handover_requests']) {
        await db.run(`UPDATE ${t} SET workspace_id=2 WHERE order_id IN (SELECT id FROM orders WHERE workspace_id=2)`);
      }
      await db.run(`UPDATE hostels SET workspace_id=2 WHERE active=0 AND lower(name)='walk-in customers'
        AND NOT EXISTS(SELECT 1 FROM students WHERE hostel_id=hostels.id AND workspace_id!=2)`);
      await db.run(`UPDATE orders SET service_id=(SELECT dst.id FROM services src JOIN services dst ON dst.name=src.name AND dst.workspace_id=2
        WHERE src.id=orders.service_id) WHERE workspace_id=2 AND service_id IN (SELECT id FROM services WHERE workspace_id=1)`);
      await db.run('UPDATE complaints SET workspace_id=2 WHERE student_id IN (SELECT user_id FROM customers)');
      await db.run('UPDATE complaint_updates SET workspace_id=2 WHERE complaint_id IN (SELECT id FROM complaints WHERE workspace_id=2)');
      await db.run('UPDATE notifications SET workspace_id=2 WHERE user_id IN (SELECT user_id FROM customers)');
      await db.run(`UPDATE files SET workspace_id=2 WHERE name IN (SELECT photo FROM complaints WHERE workspace_id=2 UNION
        SELECT signature FROM order_signoffs WHERE workspace_id=2 UNION SELECT photo FROM users WHERE workspace_id=2)`);
      await db.run(`UPDATE activity SET workspace_id=2 WHERE (entity='order' AND entity_id IN (SELECT order_no FROM orders WHERE workspace_id=2 UNION SELECT CAST(id AS TEXT) FROM orders WHERE workspace_id=2))
        OR (entity='student' AND entity_id IN (SELECT id_card_no FROM students WHERE workspace_id=2))`);
      if (sqlite && (await db.all('PRAGMA foreign_key_check')).length) throw new Error('Workspace migration would leave orphaned records');
      await db.run("INSERT INTO schema_versions(name) VALUES ('hybrid-workspaces')");
    });
  } finally {
    if (sqlite) await db.driver.script('PRAGMA foreign_keys=ON');
  }
}
