import assert from 'node:assert/strict';
import { inWorkspace, type Workspace } from '../server/workspace-context.js';
import { deliverOrder } from '../server/rules.js';
import { orderDetail } from '../server/queries.js';
import { afterAll, it } from 'vitest';
import { db, migrate, insertId, migrateLegacySchema } from '../server/db.js';

afterAll(() => db.close());
it('migrates an existing campus and walk-in order history exactly once', async () => {
  await db.open();
  await migrateLegacySchema();
  const hostel = await insertId('INSERT INTO hostels(name) VALUES (?)',['Demo campus']);
  const users: number[] = [];
  for (const [login,kind,claimable] of [['DEMO1','HOSTELER',0],['DEMO2','HOSTELER',1],['WALKIN-9876500000','WALKIN',0]] as const) {
    const id = await insertId("INSERT INTO users(role, login_id, name, password_hash, created_at) VALUES ('STUDENT',?,?,?,?)",[login,login,'fixture-hash','2026-10-01']);
    users.push(id);
    if(kind==='WALKIN') await db.run('UPDATE users SET mobile=? WHERE id=?',['9876500000',id]);
    await db.run("INSERT INTO students(user_id,id_card_no,hostel_id,room_no,status,kind,claimable,claim_hash) VALUES (?,?,?,?,'ACTIVE',?,?,?)",[id,login,hostel,'1',kind,claimable,claimable?'fixture-code-hash':null]);
  }
  const staff = await insertId("INSERT INTO users(role,login_id,name,password_hash,created_at) VALUES ('STAFF','COUNTER','Counter','staff-hash','2026-10-01')", []);
  await db.tx(async () => {
    for(let i=0;i<350;i++){
      const no='EJ-'+(1001+i);
      await db.run("INSERT INTO orders(order_no,order_key,student_id,hostel_name,room_no,weight_kg,clothes_count,qr_token,received_by,received_at,expected_at,updated_at,day_key,month_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[no,no.replace('-',''),users[i%3],'Demo campus','1',3,5,'fixture-qr-'+i,staff,'2026-10-02','2026-10-04','2026-10-02','2026-10-02','2026-10']);
    }
  });
  await db.run("INSERT INTO activity(actor_id,action,entity,entity_id,created_at) VALUES (?,'STUDENT_CLAIMED','student','DEMO1','2026-10-01')",[users[0]]);
  const snapshot = () => db.all('SELECT id,order_no,order_key,student_id,qr_token,received_by,status,amount,received_at FROM orders ORDER BY id');
  const before = await snapshot();
  await migrate();
  await migrate();
  assert.deepEqual(await snapshot(), before);
  const guest = await db.get('SELECT * FROM customers WHERE user_id=?',[users[2]]);
  assert.equal(guest?.mobile,'9876500000');
  assert.equal(guest?.workspace_id,2);
  assert.equal((await db.get('SELECT login_id FROM users WHERE id=?',[users[2]]))?.login_id,null);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM orders WHERE workspace_id=2'))?.n,116);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM orders WHERE workspace_id=1'))?.n,234);
  assert.equal((await db.get('SELECT claim_hash FROM students WHERE user_id=?',[users[1]]))?.claim_hash,'fixture-code-hash');
  assert.equal((await db.get('SELECT password_hash FROM users WHERE id=?',[users[0]]))?.password_hash,'fixture-hash');
  assert.deepEqual(await db.all('SELECT workspace_id FROM staff_workspaces WHERE user_id=?',[staff]),[{workspace_id:1}]);
  const retail = await db.get<Workspace>("SELECT * FROM workspaces WHERE kind='RETAIL'");
  await inWorkspace(retail!, async () => {
    const order = await db.get<{id:number}>('SELECT id FROM orders ORDER BY id LIMIT 1');
    const detail = await orderDetail(order!.id);
    assert.equal(detail.received_by_name, 'Counter');
    await deliverOrder(staff, order!.id, 5, '', { method: 'COUNTER' });
    assert.equal((await orderDetail(order!.id)).status, 'DELIVERED');
  });
});
