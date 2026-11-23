import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Announcement, api, Order, Student, User } from './api';
import { ChangePassword } from './auth';
import { go, kg, plural, requestId, rupees, toast, useAction, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { ComplaintsBoard, CounterStudent, HandOver, OpsSettings, OrderSheet, StudentFacts, StudentLine, StudentSheet } from './ops';
import { Brand, Button, Empty, ErrorNote, Icon, IconName, Loading, PayPill, Scanner, Segmented, Sheet, StatusPill, Stepper } from './ui';

type Summary = {
  today: { received: number; kg: number; clothes: number; delivered: number; collected: number };
  open: { received: number; washing: number; ready: number; late: number };
  pending_students: number; open_complaints: number; dues: number; settings: OpsSettings; announcements: Announcement[];
};

export function StaffApp({ user, onSignOut, onUser, onAdmin }: { user: User; onSignOut: () => void; onUser: (u: User) => void; onAdmin?: () => void }) {
  const parts = useRoute();
  const page = ['pickup', 'orders', 'students', 'issues'].includes(parts[0]) ? parts[0] : 'counter';
  const sum = useLoad(() => api<Summary>('/ops/summary'), [], { every: 30_000 });
  const [orderId, setOrderId] = useState<number | null>(null);
  const [studentId, setStudentId] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const s = sum.data;
  useScrollTop(page);
  const isAdmin = user.role === 'ADMIN';
  const refresh = () => void sum.reload();

  return (
    <div className="sf-shell">
      <header className="sf-top">
        <Brand sub="Counter" />
        {s && (
          <p className="sf-today" aria-label="Today at the counter">
            <span><b>{s.today.received}</b> in</span>
            <span><b>{kg(s.today.kg)}</b></span>
            <span><b>{s.today.delivered}</b> out</span>
          </p>
        )}
        <button className="sf-user" onClick={() => setMenu(true)} aria-label="Account menu"><span className="avatar">{user.name.split(' ').map(x => x[0]).slice(0, 2).join('')}</span></button>
      </header>
      <main className="sf-main">
        {page === 'counter' && <Counter settings={s?.settings} onCreated={refresh} openOrder={setOrderId} openStudent={setStudentId} pending={s?.pending_students ?? 0} notices={s?.announcements ?? []} />}
        {page === 'pickup' && <Pickup settings={s?.settings} onDone={refresh} openOrder={setOrderId} />}
        {page === 'orders' && <Orders summary={s} onChanged={refresh} openOrder={setOrderId} />}
        {page === 'students' && <Students openStudent={setStudentId} pending={s?.pending_students ?? 0} />}
        {page === 'issues' && <div className="sf-page"><h1>Complaints</h1><ComplaintsBoard onOpenOrder={setOrderId} /></div>}
      </main>
      <nav className="sf-tabs" aria-label="Counter">
        <Tab to="" icon="plus" label="New order" on={page === 'counter'} />
        <Tab to="pickup" icon="scan" label="Pickup" on={page === 'pickup'} badge={s?.open.ready} />
        <Tab to="orders" icon="washer" label="Orders" on={page === 'orders'} badge={s?.open.late} alert />
        <Tab to="students" icon="users" label="Students" on={page === 'students'} badge={s?.pending_students} />
        <Tab to="issues" icon="help" label="Issues" on={page === 'issues'} badge={s?.open_complaints} />
      </nav>
      {orderId && <OrderSheet id={orderId} isAdmin={isAdmin} payFirst={s?.settings.pay_before_pickup ?? true} close={() => setOrderId(null)} onChanged={refresh} />}
      {studentId && <StudentSheet id={studentId} isAdmin={isAdmin} close={() => setStudentId(null)} onChanged={refresh} onOpenOrder={id => { setStudentId(null); setOrderId(id); }} />}
      {menu && (
        <Sheet title={user.name} onClose={() => setMenu(false)} size="sm">
          <div className="stack">
            <p className="muted">Signed in as {user.login_id}</p>
            <details className="pw-details"><summary>Change password</summary><ChangePassword user={user} onDone={u => { onUser(u); setMenu(false); }} /></details>
            {onAdmin && <Button block icon="chart" onClick={() => { setMenu(false); onAdmin(); }}>Back to admin office</Button>}
            <Button block tone="danger" icon="logout" onClick={onSignOut}>Sign out</Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Tab({ to, icon, label, on, badge, alert }: { to: string; icon: IconName; label: string; on: boolean; badge?: number; alert?: boolean }) {
  return (
    <a href={`#/${to}`} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
      <span className="tab-icon"><Icon name={icon} size={24} />{!!badge && <i className={`dot-badge${alert ? ' alert' : ''}`}>{badge > 99 ? '99+' : badge}</i>}</span>
      {label}
    </a>
  );
}

/* --------------------------------------------------------------- counter */

type Quote = { within_kg: number; extra_kg: number; amount: number; breakdown: { regular: number; extra: number; express: number }; expected_at: string; usage_after: { orders: number; kg: number; order_limit: number; kg_limit: number } };

function Counter({ settings, onCreated, openOrder, openStudent, pending, notices }: { settings?: OpsSettings; onCreated: () => void; openOrder: (id: number) => void; openStudent: (id: number) => void; pending: number; notices: Announcement[] }) {
  const [student, setStudent] = useState<CounterStudent | null>(null);
  const [created, setCreated] = useState<Order | null>(null);
  if (created) return <Created o={created} onNext={() => { setCreated(null); setStudent(null); }} onOpen={() => openOrder(created.id)} />;
  return (
    <div className="sf-page counter">
      {!student ? (
        <>
          <h1>New order</h1>
          <FindStudent onFound={setStudent} />
          {pending > 0 && <button className="sf-callout" onClick={() => go('students')}><Icon name="card" />{plural(pending, 'student')} waiting for approval<Icon name="next" size={18} /></button>}
          {notices.map(n => <p key={n.id} className="sf-notice"><Icon name="megaphone" size={18} /><span><b>{n.title}</b> {n.body}</span></p>)}
          <ol className="how">
            <li>Scan or type the student’s ID card no.</li>
            <li>Weigh the clothes and count the pieces.</li>
            <li>Take the order. Write the order no. on the bag tag.</li>
          </ol>
        </>
      ) : (
        <OrderForm student={student} settings={settings} onChangeStudent={() => setStudent(null)} onStudent={setStudent}
          onCreated={o => { setCreated(o); onCreated(); }} openOrder={openOrder} openStudent={openStudent} />
      )}
    </div>
  );
}

function FindStudent({ onFound }: { onFound: (s: CounterStudent) => void }) {
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(false);
  const [suggestions, setSuggestions] = useState<Student[] | null>(null);
  const { busy, error, setError, submit } = useFormAction();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const lookup = async (value = code) => {
    if (!value.trim()) return;
    const r = await submit(() => api<{ student: CounterStudent | null; suggestions: Student[] }>(`/ops/students/lookup?code=${encodeURIComponent(value)}`));
    if (!r) return;
    if (r.student) onFound(r.student);
    else { setSuggestions(r.suggestions); if (!r.suggestions.length) setError(`No student with ID “${value}”. Ask them to register on the website first.`); }
  };
  const pick = async (id: number) => { const r = await submit(() => api<CounterStudent>(`/ops/students/${id}`)); if (r) onFound(r); };
  return (
    <div className="find">
      <form className="find-row" onSubmit={(e: FormEvent) => { e.preventDefault(); void lookup(); }}>
        <label className="sr-only" htmlFor="idcard">ID card no., name or room</label>
        <input id="idcard" ref={input} className="find-input" value={code} onChange={e => { setCode(e.target.value); setSuggestions(null); setError(''); }}
          placeholder="ID card no., name or room" autoCapitalize="characters" autoComplete="off" spellCheck={false} enterKeyHint="search" />
        <Button tone="primary" size="lg" busy={busy} icon="search" aria-label="Find student" />
        <Button size="lg" type="button" icon="camera" onClick={() => setScan(!scan)} aria-label={scan ? 'Close camera' : 'Scan ID card'} className={scan ? 'on' : ''} />
      </form>
      {scan && <Scanner hint="Point at the ID card barcode or the student’s ID QR" onResult={t => { setScan(false); setCode(t.replace(/^EJS:/, '')); void lookup(t); }} />}
      {error && <ErrorNote error={error} />}
      {suggestions && suggestions.length > 0 && (
        <ul className="suggest">
          {suggestions.map(s => (
            <li key={s.id}><button onClick={() => pick(s.id)}>
              <b>{s.name}</b><span>{s.id_card_no}, {s.hostel_name}, room {s.room_no}</span>
              {s.status !== 'ACTIVE' && <span className={`pill acc-${s.status.toLowerCase()}`}>{s.status === 'PENDING' ? 'Not approved' : s.status.toLowerCase()}</span>}
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderForm({ student, settings, onChangeStudent, onStudent, onCreated, openOrder, openStudent }: {
  student: CounterStudent; settings?: OpsSettings; onChangeStudent: () => void; onStudent: (s: CounterStudent) => void; onCreated: (o: Order) => void; openOrder: (id: number) => void; openStudent: (id: number) => void;
}) {
  const [weight, setWeight] = useState('');
  const [count, setCount] = useState('');
  const [service, setService] = useState<'REGULAR' | 'EXPRESS'>('REGULAR');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const rid = useRef(requestId());
  const { busy, error, submit } = useFormAction();
  const approve = useAction();
  const max = settings?.max_kg_per_order ?? 7;
  const w = Number(weight);
  const c = Number(count);
  const ready = w > 0 && c > 0;
  const weightRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (student.status === 'ACTIVE') weightRef.current?.focus(); }, [student.status]);

  // Live rule check: the same server function that saves the order.
  useEffect(() => {
    setQuote(null); setQuoteError('');
    if (!ready || student.status !== 'ACTIVE') return;
    const t = setTimeout(() => {
      api<Quote>('/ops/quote', { body: { studentId: student.id, weightKg: w, clothesCount: c, service } }).then(setQuote).catch(e => setQuoteError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [w, c, service, student.id, student.status, ready]);

  const take = async (e: FormEvent) => {
    e.preventDefault();
    const o = await submit(() => api<Order>('/ops/orders', { body: { studentId: student.id, weightKg: w, clothesCount: c, service, note, requestId: rid.current } }));
    if (o) { rid.current = requestId(); onCreated(o); }
  };
  const approveNow = async () => {
    const r = await approve.run(() => api<CounterStudent>(`/ops/students/${student.id}/review`, { body: { decision: 'APPROVE' } }), `${student.name} approved`);
    if (r) onStudent(r);
  };
  const blocked = student.status !== 'ACTIVE';
  const over = w > max;

  return (
    <form className="order-form" onSubmit={take}>
      <div className="who">
        <StudentLine o={{ student_name: student.name, id_card_no: student.id_card_no, hostel_name: student.hostel_name, room_no: student.room_no, mobile: student.mobile }} />
        <div className="who-actions">
          <Button size="sm" type="button" onClick={() => openStudent(student.id)}>Details</Button>
          <Button size="sm" type="button" icon="swap" onClick={onChangeStudent}>Change</Button>
        </div>
      </div>
      <p className="who-usage">This month: {plural(student.usage.orders, 'order')}, {kg(student.usage.kg)}{student.usage.kg_limit ? ` of ${kg(student.usage.kg_limit)}` : ''}. {student.open.length ? `${plural(student.open.length, 'order')} in progress.` : 'Nothing in progress.'}</p>
      {student.open.length > 0 && (
        <ul className="who-open">
          {student.open.map(o => <li key={o.id}><button type="button" onClick={() => openOrder(o.id)}><b>{o.order_no}</b><span>{o.clothes_count} clothes</span><StatusPill status={o.status} /></button></li>)}
        </ul>
      )}

      {blocked ? (
        student.status === 'PENDING' ? (
          <div className="approve-box">
            <p><b>Not approved yet.</b> Match the ID card with the university portal, then approve to take the order.</p>
            <StudentFacts s={student} />
            <Button tone="good" size="lg" block icon="check" busy={approve.busy} type="button" onClick={approveNow}>Details match, approve</Button>
            <Button block type="button" onClick={() => openStudent(student.id)}>Reject or edit</Button>
          </div>
        ) : <ErrorNote error={`This account is ${student.status.toLowerCase()}${student.review_note ? `: ${student.review_note}` : ''}. Orders cannot be taken.`} />
      ) : (
        <>
          <div className="measure">
            <label className={`measure-box${over ? ' over' : ''}`}>
              <span>Weight</span>
              <span className="measure-input"><input ref={weightRef} inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.0" aria-describedby="kg-hint" /><em>kg</em></span>
              <small id="kg-hint">{over ? `Over the ${max} kg limit` : `Up to ${max} kg`}</small>
            </label>
            <div className="measure-box">
              <span>Clothes</span>
              <Stepper value={count} onChange={setCount} min={0} max={300} label="clothes" />
              <small>Count every piece</small>
            </div>
          </div>
          {settings?.express_enabled && (
            <Segmented label="Service" value={service} onChange={setService} options={[{ value: 'REGULAR', label: 'Regular' }, { value: 'EXPRESS', label: `Express, ${rupees(settings.express_fee)}` }]} />
          )}
          <details className="note-details" open={!!note}>
            <summary>Add a note</summary>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. 1 blanket, white kurta wash separately" maxLength={200} aria-label="Note" />
          </details>

          <div className={`verdict${quoteError ? ' bad' : quote ? (quote.amount ? ' pay' : ' ok') : ''}`} aria-live="polite">
            {!ready ? <span>Enter weight and clothes count.</span>
              : quoteError ? <span><Icon name="alert" size={18} />{quoteError}</span>
              : !quote ? <span>Checking rules…</span>
              : <>
                <b>{quote.amount ? `Collect ${rupees(quote.amount)} at pickup` : 'No charge'}</b>
                <span>{[quote.extra_kg ? `${kg(quote.extra_kg)} over monthly limit (${rupees(quote.breakdown.extra)})` : '', quote.breakdown.express ? `express ${rupees(quote.breakdown.express)}` : '', quote.breakdown.regular ? `wash ${rupees(quote.breakdown.regular)}` : ''].filter(Boolean).join(', ') || 'Within the monthly limit.'}</span>
                <span>Ready by {when(quote.expected_at, 'short')}</span>
              </>}
          </div>
          {error && <ErrorNote error={error} />}
          <Button tone="primary" size="lg" block busy={busy} disabled={!quote || !!quoteError}>Take order: {c || 0} clothes, {kg(w)}</Button>
        </>
      )}
    </form>
  );
}

function Created({ o, onNext, onOpen }: { o: Order; onNext: () => void; onOpen: () => void }) {
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => { next.current?.focus(); }, []);
  return (
    <div className="sf-page created" role="status">
      <p className="created-label">Order taken. Write this on the bag tag:</p>
      <p className="created-no">{o.order_no}</p>
      <p className="created-meta">{o.student_name}, room {o.room_no}. {plural(o.clothes_count, 'piece')}, {kg(o.weight_kg)}{o.amount ? `. ${rupees(o.amount)} due at pickup` : ''}.</p>
      <p className="created-sub">The digital slip is already on the student’s phone.</p>
      <Button ref={next} tone="primary" size="lg" block icon="plus" onClick={onNext}>Next student</Button>
      <Button block onClick={onOpen}>Open this order</Button>
    </div>
  );
}

/* ----------------------------------------------------------------- pickup */

function Pickup({ settings, onDone, openOrder }: { settings?: OpsSettings; onDone: () => void; openOrder: (id: number) => void }) {
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(true);
  const [found, setFound] = useState<Order | null>(null);
  const [handed, setHanded] = useState<Order | null>(null);
  const { busy, error, setError, submit } = useFormAction();
  const [q, setQ] = useState('');
  const ready = useLoad(() => api<{ rows: Order[]; total: number }>(`/ops/orders?status=READY&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, handed?.id], { every: 30_000 });
  const lookup = async (value: string) => {
    if (!value.trim()) return;
    setScan(false);
    const r = await submit(() => api<Order>('/ops/scan', { body: { code: value } }));
    if (r) { setFound(r); setCode(''); }
  };
  const reset = () => { setFound(null); setHanded(null); setError(''); setScan(true); };

  if (handed) return (
    <div className="sf-page created" role="status">
      <p className="created-label">Handed over</p>
      <p className="created-no">{handed.order_no}</p>
      <p className="created-meta">{handed.student_name}: {plural(handed.returned_count ?? 0, 'piece')} returned{handed.payment_status === 'PAID' ? `, ${rupees(handed.amount)} received` : ''}.</p>
      <Button tone="primary" size="lg" block icon="scan" onClick={reset}>Scan next slip</Button>
    </div>
  );

  return (
    <div className="sf-page pickup">
      <h1>Pickup</h1>
      {!found ? (
        <>
          {scan ? <Scanner hint="Scan the QR on the student’s slip" onResult={lookup} /> : <Button size="lg" block icon="camera" onClick={() => setScan(true)}>Scan slip QR</Button>}
          <form className="find-row" onSubmit={e => { e.preventDefault(); void lookup(code); }}>
            <label className="sr-only" htmlFor="orderno">Order number</label>
            <input id="orderno" className="find-input" value={code} onChange={e => setCode(e.target.value)} placeholder="or type order no., e.g. 1042" inputMode="numeric" autoComplete="off" />
            <Button tone="primary" size="lg" busy={busy} icon="search" aria-label="Find order" />
          </form>
          {error && <ErrorNote error={error} />}
          <h2 className="sub">Ready for pickup {ready.data ? `(${ready.data.total})` : ''}</h2>
          <input className="filter-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name, room or ID" aria-label="Filter ready orders" />
          {!ready.data ? <Loading /> : !ready.data.rows.length ? <Empty icon="check" title="Nothing waiting">Orders marked ready show up here.</Empty> : (
            <ul className="order-rows">
              {ready.data.rows.map(o => <OrderRow key={o.id} o={o} onOpen={() => { setFound(null); void lookup(o.order_no); }} />)}
            </ul>
          )}
        </>
      ) : (
        <div className="stack">
          <div className="pick-head">
            <span className="pick-no">{found.order_no}</span>
            <StatusPill status={found.status} late={found.late} />
            <PayPill o={found} />
          </div>
          {found.status === 'DELIVERED' ? (
            <div className="stop-box"><Icon name="alert" size={28} /><b>Already handed over</b><p>{when(found.delivered_at, 'short')} by {found.delivered_by_name}. Do not give clothes again.</p></div>
          ) : found.status === 'CANCELLED' ? (
            <div className="stop-box"><Icon name="x" size={28} /><b>This order was cancelled</b><p>{found.cancel_reason}</p></div>
          ) : (
            <>
              <div className={`verify${found.via === 'NUMBER' ? ' strict' : ''}`}>
                <StudentLine o={found} />
                <p>{found.via === 'QR' ? 'Slip QR verified. Check the face matches the ID card.' : 'Typed order no.: check the student’s physical ID card before handing over.'}</p>
              </div>
              <HandOver o={found} payFirst={settings?.pay_before_pickup ?? true} onDone={o => { setHanded(o); onDone(); }} />
            </>
          )}
          <Button block onClick={() => openOrder(found.id)}>Order details</Button>
          <Button tone="plain" block onClick={reset}>Scan another</Button>
        </div>
      )}
    </div>
  );
}

function OrderRow({ o, onOpen, selectable, selected, onSelect }: { o: Order; onOpen: () => void; selectable?: boolean; selected?: boolean; onSelect?: (on: boolean) => void }) {
  return (
    <li className={`order-row${selected ? ' sel' : ''}${o.late ? ' late' : ''}`}>
      {selectable && <label className="row-check"><input type="checkbox" checked={!!selected} onChange={e => onSelect?.(e.target.checked)} aria-label={`Select ${o.order_no}`} /></label>}
      <button onClick={onOpen}>
        <span className="or-no">{o.order_no}</span>
        <span className="or-who"><b>{o.student_name}</b><small>{o.hostel_name}, room {o.room_no}</small></span>
        <span className="or-load">{o.clothes_count}<small>pcs</small></span>
        <span className="or-load">{Number(o.weight_kg).toFixed(1)}<small>kg</small></span>
        <span className="or-state"><StatusPill status={o.status} late={o.late} />{o.payment_status === 'DUE' && <PayPill o={o} />}<small>{o.status === 'READY' ? `since ${when(o.ready_at, 'time')}` : `due ${when(o.expected_at, 'short')}`}</small></span>
      </button>
    </li>
  );
}

/* ----------------------------------------------------------------- orders */

const LANES = [
  { key: 'RECEIVED', label: 'Received' },
  { key: 'WASHING', label: 'Washing' },
  { key: 'READY', label: 'Ready' },
  { key: 'LATE', label: 'Late' },
] as const;
type Lane = typeof LANES[number]['key'];

function Orders({ summary, onChanged, openOrder }: { summary?: Summary; onChanged: () => void; openOrder: (id: number) => void }) {
  const [lane, setLane] = useState<Lane>('RECEIVED');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const list = useLoad(() => api<{ rows: Order[]; total: number }>(`/ops/orders?status=${lane}&limit=300${q ? `&q=${encodeURIComponent(q)}` : ''}`), [lane, q], { every: 30_000 });
  const { busy, run } = useAction();
  useEffect(() => setSel(new Set()), [lane, q]);
  const counts: Record<Lane, number | undefined> = { RECEIVED: summary?.open.received, WASHING: summary?.open.washing, READY: summary?.open.ready, LATE: summary?.open.late };
  const rows = list.data?.rows ?? [];
  const move = async (status: 'WASHING' | 'READY' | 'RECEIVED') => {
    const ids = [...sel];
    const r = await run(() => api<{ changed: number }>('/ops/orders/status', { body: { ids, status } }));
    if (r) { toast(`${plural(r.changed, 'order')} moved to ${status === 'READY' ? 'Ready' : status.toLowerCase()}${status === 'READY' ? '. Students were notified.' : ''}`); setSel(new Set()); void list.reload(); onChanged(); }
  };
  const allOn = rows.length > 0 && rows.every(r => sel.has(r.id));
  const nextFor: Record<Lane, ('WASHING' | 'READY' | 'RECEIVED')[]> = { RECEIVED: ['WASHING', 'READY'], WASHING: ['READY'], READY: ['WASHING'], LATE: ['WASHING', 'READY'] };

  return (
    <div className="sf-page orders">
      <h1>Orders</h1>
      <div className="lanes" role="tablist" aria-label="Order status">
        {LANES.map(l => (
          <button key={l.key} role="tab" aria-selected={lane === l.key} className={`${lane === l.key ? 'on' : ''} lane-${l.key.toLowerCase()}`} onClick={() => setLane(l.key)}>
            <b>{counts[l.key] ?? '–'}</b>{l.label}
          </button>
        ))}
      </div>
      <div className="orders-tools">
        <input className="filter-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search order no., name, room or ID" aria-label="Search orders" />
        {rows.length > 0 && <label className="select-all"><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} />Select all</label>}
      </div>
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !rows.length ? <Empty icon="washer" title={lane === 'LATE' ? 'Nothing is late' : `No orders in ${lane.toLowerCase()}`} /> : (
        <ul className="order-rows">
          {rows.map(o => <OrderRow key={o.id} o={o} onOpen={() => openOrder(o.id)} selectable selected={sel.has(o.id)} onSelect={on => { const n = new Set(sel); if (on) n.add(o.id); else n.delete(o.id); setSel(n); }} />)}
        </ul>
      )}
      {sel.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>{sel.size} selected</span>
          {nextFor[lane].map(s => <Button key={s} tone={s === 'READY' ? 'primary' : 'quiet'} busy={busy} onClick={() => move(s)}>{s === 'READY' ? 'Mark ready' : s === 'WASHING' ? 'Move to washing' : 'Back to received'}</Button>)}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- students */

function Students({ openStudent, pending }: { openStudent: (id: number) => void; pending: number }) {
  const [view, setView] = useState<'PENDING' | ''>(pending ? 'PENDING' : '');
  const [q, setQ] = useState('');
  const list = useLoad(() => api<{ rows: Student[]; total: number }>(`/ops/students?status=${view}&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`), [view, q], { every: 30_000 });
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
  return (
    <div className="sf-page">
      <h1>Students</h1>
      <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'PENDING', label: `Waiting approval${pending ? ` (${pending})` : ''}` }, { value: '', label: 'Everyone' }]} />
      <input className="filter-input" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search name, ID card, room or mobile" aria-label="Search students" />
      {!list.data ? <Loading /> : !list.data.rows.length ? <Empty icon="users" title={view === 'PENDING' ? 'No one is waiting' : 'No students found'}>{view === 'PENDING' ? 'New sign-ups appear here for you to check against the university portal.' : ''}</Empty> : (
        <ul className="student-rows">
          {list.data.rows.map(s => (
            <li key={s.id}><button onClick={() => openStudent(s.id)}>
              <span className="avatar">{s.name.split(' ').map(x => x[0]).slice(0, 2).join('')}</span>
              <span className="sr-who"><b>{s.name}</b><small>{s.id_card_no}, {s.hostel_name}, room {s.room_no}</small></span>
              {s.status !== 'ACTIVE' ? <span className={`pill acc-${s.status.toLowerCase()}`}>{s.status === 'PENDING' ? 'Check' : s.status.toLowerCase()}</span> : <small className="sr-month">{s.month_orders} this month</small>}
              <Icon name="next" size={18} />
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { OrderRow };
