import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Announcement, api, ApiError, Order, Service, Student, User } from './api';
import { ChangePassword } from './auth';
import { go, kg, plural, requestId, rupees, toast, useAction, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { CardInput, ComplaintsBoard, CounterStudent, HandOver, OpsSettings, OrderSheet, serviceLine, StudentFacts, StudentLine, StudentSheet } from './ops';
import { CodeEntry, useSignRules } from './signoff';
import { Avatar, Brand, Button, Empty, ErrorNote, Field, Icon, IconName, Loading, PayPill, Scanner, Segmented, Sheet, isAwaiting, StatusPill, Stepper } from './ui';

type Summary = {
  today: { received: number; kg: number; clothes: number; delivered: number; collected: number };
  open: { received: number; washing: number; ready: number; late: number; unconfirmed?: number };
  pending_students: number; room_changes: number; services: Service[]; open_complaints: number; dues: number; settings: OpsSettings; announcements: Announcement[];
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
        {page === 'counter' && <Counter settings={s?.settings} services={s?.services ?? []} onCreated={refresh} openOrder={setOrderId} openStudent={setStudentId} pending={s?.pending_students ?? 0} notices={s?.announcements ?? []} />}
        {page === 'pickup' && <Pickup settings={s?.settings} onDone={refresh} openOrder={setOrderId} isAdmin={isAdmin} />}
        {page === 'orders' && <Orders summary={s} onChanged={refresh} openOrder={setOrderId} />}
        {page === 'students' && <Students openStudent={setStudentId} pending={s?.pending_students ?? 0} roomChanges={s?.room_changes ?? 0} />}
        {page === 'issues' && <div className="sf-page"><h1>Complaints</h1><ComplaintsBoard onOpenOrder={setOrderId} /></div>}
      </main>
      <nav className="sf-tabs" aria-label="Counter">
        <Tab to="" icon="plus" label="New order" on={page === 'counter'} />
        <Tab to="pickup" icon="scan" label="Pickup" on={page === 'pickup'} badge={s?.open.ready} />
        <Tab to="orders" icon="washer" label="Orders" on={page === 'orders'} badge={s?.open.late} alert />
        <Tab to="students" icon="users" label="Students" on={page === 'students'} badge={(s?.pending_students ?? 0) + (s?.room_changes ?? 0)} />
        <Tab to="issues" icon="help" label="Issues" on={page === 'issues'} badge={s?.open_complaints} />
        {/* Computer only: today's numbers and the account, under the menu */}
        {s && (
          <div className="sf-side-stats" aria-label="Counter today">
            <h2>Today</h2>
            <dl>
              <div><dt>Taken in</dt><dd>{s.today.received}</dd></div>
              <div><dt>Weight</dt><dd>{kg(s.today.kg)}</dd></div>
              <div><dt>Handed back</dt><dd>{s.today.delivered}</dd></div>
            </dl>
            <h2>Now</h2>
            <dl>
              <div><dt>Received</dt><dd>{s.open.received}</dd></div>
              <div><dt>Washing</dt><dd>{s.open.washing}</dd></div>
              <div><dt>On the shelf</dt><dd>{s.open.ready}</dd></div>
              <div className={s.open.late ? 'late' : ''}><dt>Late</dt><dd>{s.open.late}</dd></div>
            </dl>
          </div>
        )}
        <button type="button" className="sf-side-user" onClick={() => setMenu(true)}>
          <span className="avatar">{user.name.split(' ').map(x => x[0]).slice(0, 2).join('')}</span>
          <span><b>{user.name}</b><small>{isAdmin ? 'Admin' : 'Staff'}, {user.login_id}</small></span>
        </button>
      </nav>
      {orderId && <OrderSheet id={orderId} isAdmin={isAdmin} payFirst={s?.settings.pay_before_pickup ?? true} close={() => setOrderId(null)} onChanged={refresh} />}
      {studentId && <StudentSheet id={studentId} isAdmin={isAdmin} close={() => setStudentId(null)} onChanged={refresh} onOpenOrder={id => { setStudentId(null); setOrderId(id); }} />}
      {menu && (
        <Sheet title={user.name} onClose={() => setMenu(false)} size="sm">
          <div className="stack">
            <p className="muted">Signed in as {user.login_id}</p>
            <details className="pw-details"><summary>Change password</summary><ChangePassword user={user} onDone={u => { onUser(u); setMenu(false); }} /></details>
            <a className="btn btn-quiet btn-block" href="guide/staff.html"><Icon name="help" size={18} />Guide for staff and admin</a>
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

type Quote = { within_kg: number; extra_kg: number; amount: number; plan: { hosteler: boolean; label: string }; service: { id: number; name: string; unit: 'KG' | 'PIECE'; rate: number };
  breakdown: { service: number; extra: number; express: number }; charge_note: string | null; expected_at: string; usage_after: { orders: number; kg: number; order_limit: number; kg_limit: number } };
/** The server's answer when an order is over a free limit: remove kg, or (if allowed) charge for them. */
type OverLimit = { code: 'OVER_LIMIT'; extra_kg: number; keep_kg: number; can_charge: boolean; extra_charge?: number; rate?: number };

function Counter({ settings, services, onCreated, openOrder, openStudent, pending, notices }: { settings?: OpsSettings; services: Service[]; onCreated: () => void; openOrder: (id: number) => void; openStudent: (id: number) => void; pending: number; notices: Announcement[] }) {
  const [student, setStudent] = useState<CounterStudent | null>(null);
  const [created, setCreated] = useState<Order | null>(null);
  if (created) return <Created o={created} onNext={() => { setCreated(null); setStudent(null); }} onOpen={() => openOrder(created.id)} />;
  return (
    <div className="sf-page counter">
      {!student ? (
        <>
          <h1>New order</h1>
          <div className="counter-cols">
            <div className="counter-find"><FindStudent onFound={setStudent} /></div>
            <div className="counter-side">
              {pending > 0 && <button className="sf-callout" onClick={() => go('students')}><Icon name="card" />{plural(pending, 'student')} waiting for approval<Icon name="next" size={18} /></button>}
              {notices.map(n => <p key={n.id} className="sf-notice"><Icon name="megaphone" size={18} /><span><b>{n.title}</b> {n.body}</span></p>)}
              <ol className="how">
                <li>Scan or type the student’s ID card no.</li>
                <li>Weigh the clothes and count the pieces.</li>
                <li>Take the order. Write the order no. on the bag tag.</li>
              </ol>
            </div>
          </div>
        </>
      ) : (
        <OrderForm student={student} settings={settings} services={services} onChangeStudent={() => setStudent(null)} onStudent={setStudent}
          onCreated={o => { setCreated(o); onCreated(); }} openOrder={openOrder} openStudent={openStudent} />
      )}
    </div>
  );
}

function FindStudent({ onFound }: { onFound: (s: CounterStudent) => void }) {
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(false);
  const [suggestions, setSuggestions] = useState<Student[] | null>(null);
  const [missed, setMissed] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const { busy, error, setError, submit } = useFormAction();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const lookup = async (value = code) => {
    if (!value.trim()) return;
    const r = await submit(() => api<{ student: CounterStudent | null; suggestions: Student[] }>(`/ops/students/lookup?code=${encodeURIComponent(value)}`));
    if (!r) return;
    if (r.student) onFound(r.student);
    else { setSuggestions(r.suggestions); setMissed(true); if (!r.suggestions.length) setError(`No student with ID “${value}”. Ask them to register on the website first.`); }
  };
  const pick = async (id: number) => { const r = await submit(() => api<CounterStudent>(`/ops/students/${id}`)); if (r) onFound(r); };
  return (
    <div className="find">
      <form className="find-row" onSubmit={(e: FormEvent) => { e.preventDefault(); void lookup(); }}>
        <label className="sr-only" htmlFor="idcard">ID card no., name or room</label>
        <input id="idcard" ref={input} className="find-input" value={code} onChange={e => { setCode(e.target.value); setSuggestions(null); setError(''); setMissed(false); }}
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
      {missed && !walkIn && <button type="button" className="link-btn walkin-link" onClick={() => setWalkIn(true)}>Serve without registration</button>}
      {walkIn && <WalkIn defaultMobile={/^\d{10}$/.test(code.trim()) ? code.trim() : ''} onFound={onFound} onCancel={() => setWalkIn(false)} />}
    </div>
  );
}

/** Quick counter entry for someone not registered (guest, staff member, day scholar). Normal prices apply. */
function WalkIn({ defaultMobile, onFound, onCancel }: { defaultMobile: string; onFound: (s: CounterStudent) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', mobile: defaultMobile });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<CounterStudent>('/ops/walk-in', { body: f }));
    if (r) onFound(r);
  };
  return (
    <form className="walkin stack" onSubmit={save}>
      <p className="muted small">For someone without an account. They pay normal prices and get the order no. on the bag tag. The same mobile finds them next time.</p>
      <div className="field-row">
        <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus autoCapitalize="words" /></Field>
        <Field label="Mobile"><input value={f.mobile} onChange={e => setF({ ...f, mobile: e.target.value })} inputMode="tel" placeholder="10 digits" /></Field>
      </div>
      {error && <ErrorNote error={error} />}
      <div className="btn-pair">
        <Button tone="primary" busy={busy} disabled={f.name.trim().length < 2 || f.mobile.replace(/\D/g, '').length < 10}>Continue</Button>
        <Button tone="plain" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function OrderForm({ student, settings, services, onChangeStudent, onStudent, onCreated, openOrder, openStudent }: {
  student: CounterStudent; settings?: OpsSettings; services: Service[]; onChangeStudent: () => void; onStudent: (s: CounterStudent) => void; onCreated: (o: Order) => void; openOrder: (id: number) => void; openStudent: (id: number) => void;
}) {
  const [serviceId, setServiceId] = useState<number | null>(services[0]?.id ?? null);
  const [weight, setWeight] = useState('');
  const [count, setCount] = useState('');
  const [express, setExpress] = useState(false);
  const [note, setNote] = useState('');
  const [tag, setTag] = useState('');
  const [acceptExtra, setAcceptExtra] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [over, setOver] = useState<OverLimit | null>(null);
  const rid = useRef(requestId());
  const { busy, error, setError, submit } = useFormAction();
  const approve = useAction();
  const max = settings?.max_kg_per_order ?? 7;
  const service = services.find(x => x.id === serviceId) ?? services[0];
  useEffect(() => { if (serviceId === null && services[0]) setServiceId(services[0].id); }, [services, serviceId]);
  const needsWeight = !service || service.unit === 'KG' || !!service.uses_allowance;
  const w = Number(weight);
  const c = Number(count);
  const ready = c > 0 && (!needsWeight || w > 0);
  const hosteler = student.plan.hosteler;
  const freeKg = hosteler && !!service?.uses_allowance;
  const weightRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (student.status === 'ACTIVE') weightRef.current?.focus(); }, [student.status]);
  // A different weight or service is a new question: ask again before charging extra.
  useEffect(() => { setAcceptExtra(false); }, [w, serviceId, student.id]);

  const body = () => ({ studentId: student.id, serviceId: service?.id, weightKg: needsWeight ? w : (w || 0), clothesCount: c, express, acceptExtra, tagNo: tag });
  const cardNeeded = !!settings?.card_required;
  // Live rule check: the same server function that saves the order.
  useEffect(() => {
    setQuote(null); setQuoteError(''); setOver(null);
    if (!ready || student.status !== 'ACTIVE' || !service) return;
    const t = setTimeout(() => {
      api<Quote>('/ops/quote', { body: body() }).then(setQuote).catch((e: ApiError) => {
        if (e.details?.code === 'OVER_LIMIT') setOver(e.details as OverLimit);
        setQuoteError(e.message);
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, c, express, serviceId, acceptExtra, tag, student.id, student.status, ready]);

  const take = async (e: FormEvent) => {
    e.preventDefault();
    const o = await submit(() => api<Order>('/ops/orders', { body: { ...body(), note, requestId: rid.current } }));
    if (o) { rid.current = requestId(); onCreated(o); }
  };
  const approveNow = async () => {
    const r = await approve.run(() => api<CounterStudent>(`/ops/students/${student.id}/review`, { body: { decision: 'APPROVE' } }), `${student.name} approved`);
    if (r) onStudent(r);
  };
  const keepWithin = () => { if (!over) return; setWeight(String(over.keep_kg)); setError(''); };
  const blocked = student.status !== 'ACTIVE';
  const walkIn = student.kind === 'WALKIN';
  const price = (x: Service) => {
    const r = hosteler ? x.hosteler_rate : x.rate;
    const per = x.unit === 'KG' ? 'kg' : 'pc';
    return r ? `${rupees(r)}/${per}` : hosteler && x.uses_allowance ? 'Free' : `${rupees(0)}/${per}`;
  };

  return (
    <form className="order-form" onSubmit={take}>
      <div className="who">
        <StudentLine o={{ student_name: student.name, id_card_no: walkIn ? 'walk-in' : student.id_card_no, hostel_name: walkIn ? student.mobile : student.hostel_name, room_no: walkIn ? '-' : student.room_no, mobile: student.mobile, student_photo: student.photo }} photoSize={56} />
        <div className="who-actions">
          <Button size="sm" type="button" onClick={() => openStudent(student.id)}>Details</Button>
          <Button size="sm" type="button" icon="swap" onClick={onChangeStudent}>Change</Button>
        </div>
      </div>
      {!hosteler && <p className="plan-line"><Icon name="alert" size={16} />{student.plan.label}.</p>}
      {hosteler && <p className="who-usage">This month: {plural(student.usage.orders, 'order')}, {kg(student.usage.kg)}{student.usage.kg_limit ? ` of ${kg(student.usage.kg_limit)}` : ''}. {student.open.length ? `${plural(student.open.length, 'order')} in progress.` : 'Nothing in progress.'}</p>}
      {student.open.length > 0 && (
        <ul className="who-open">
          {student.open.map(o => <li key={o.id}><button type="button" onClick={() => openOrder(o.id)}><b>{o.tag_no ?? o.order_no}</b><span>{o.service_name ? `${o.service_name}, ` : ''}{o.clothes_count} clothes</span><StatusPill status={o.status} /></button></li>)}
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
          <div className="of-cols">
          <div className="of-fields">
          {services.length > 1 && (
            <div className="service-chips" role="radiogroup" aria-label="Service">
              {services.map(x => (
                <button key={x.id} type="button" role="radio" aria-checked={x.id === service?.id} className={x.id === service?.id ? 'on' : ''} onClick={() => setServiceId(x.id)}>
                  <b>{x.name}</b><small>{price(x)}</small>
                </button>
              ))}
            </div>
          )}
          <div className="measure">
            <label className={`measure-box${freeKg && w > max ? ' over' : ''}${needsWeight ? '' : ' optional'}`}>
              <span>Weight{needsWeight ? '' : ' (optional)'}</span>
              <span className="measure-input"><input ref={weightRef} inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.0" aria-describedby="kg-hint" /><em>kg</em></span>
              <small id="kg-hint">{freeKg ? (w > max ? `Over the ${max} kg free limit` : `Free up to ${max} kg`) : service?.unit === 'KG' ? `${price(service)}` : 'Priced per piece'}</small>
            </label>
            <div className="measure-box">
              <span>Clothes</span>
              <Stepper value={count} onChange={setCount} min={0} max={300} label="clothes" />
              <small>{service?.unit === 'PIECE' ? `${price(service)}, count every piece` : 'Count every piece'}</small>
            </div>
          </div>
          <div className={`card-box${cardNeeded && !tag ? ' need' : ''}`}>
            <span>Basket card no.{cardNeeded ? '' : ' (optional)'}</span>
            <CardInput value={tag} onChange={setTag} />
          </div>
          {settings?.express_enabled && (
            <Segmented label="Speed" value={express ? 'EXPRESS' : 'REGULAR'} onChange={v => setExpress(v === 'EXPRESS')} options={[{ value: 'REGULAR', label: 'Regular' }, { value: 'EXPRESS', label: `Express, ${rupees(settings.express_fee)}` }]} />
          )}
          <details className="note-details" open={!!note}>
            <summary>Add a note</summary>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. 1 blanket, white kurta wash separately" maxLength={200} aria-label="Note" />
          </details>
          </div>

          <div className="of-side">
          {over ? (
            <div className="over-choice" role="group" aria-label="Over the free limit">
              <p><Icon name="alert" size={18} /><span>{quoteError}</span></p>
              <div className="over-options">
                {over.keep_kg > 0 && (
                  <button type="button" onClick={keepWithin}>
                    <b>Take back {kg(over.extra_kg)}</b>
                    <small>Student keeps some clothes. Order stays free at {kg(over.keep_kg)}.</small>
                  </button>
                )}
                {over.can_charge && (
                  <button type="button" className="pay" onClick={() => setAcceptExtra(true)}>
                    <b>Charge {rupees(over.extra_charge)}</b>
                    <small>{kg(over.extra_kg)} extra at {rupees(over.rate)}/kg, paid at pickup.</small>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className={`verdict${quoteError ? ' bad' : quote ? (quote.amount ? ' pay' : ' ok') : ''}`} aria-live="polite">
              {!ready ? <span>{needsWeight ? 'Enter weight and clothes count.' : 'Enter the number of pieces.'}</span>
                : quoteError ? <span><Icon name="alert" size={18} />{quoteError}</span>
                : !quote ? <span>Checking rules…</span>
                : <>
                  <b>{quote.amount ? `Collect ${rupees(quote.amount)} at pickup` : 'No charge'}</b>
                  <span>{[
                    quote.breakdown.service ? `${quote.service.name} ${rupees(quote.breakdown.service)}` : '',
                    quote.extra_kg ? `${kg(quote.extra_kg)} over the free limit ${rupees(quote.breakdown.extra)}` : '',
                    quote.breakdown.express ? `express ${rupees(quote.breakdown.express)}` : '',
                  ].filter(Boolean).join(', ') || (freeKg ? 'Within the free limit.' : quote.service.name)}</span>
                  <span>Ready by {when(quote.expected_at, 'short')}</span>
                  {acceptExtra && <button type="button" className="link-btn" onClick={() => setAcceptExtra(false)}>Don’t charge, change the weight</button>}
                </>}
            </div>
          )}
          {error && <ErrorNote error={error} />}
          <Button tone="primary" size="lg" block busy={busy} disabled={!quote || !!quoteError || (cardNeeded && !tag)}>Take order{tag ? ` on card ${tag}` : ''}: {c || 0} clothes{w ? `, ${kg(w)}` : ''}</Button>
          </div>
          </div>
        </>
      )}
    </form>
  );
}

function Created({ o, onNext, onOpen }: { o: Order; onNext: () => void; onOpen: () => void }) {
  const next = useRef<HTMLButtonElement>(null);
  const rules = useSignRules();
  const [signed, setSigned] = useState(false);
  // When the student must sign, don't put the focus on "Next student".
  useEffect(() => { if (!rules.sign_dropoff || o.customer_kind === 'WALKIN') next.current?.focus(); }, [rules.sign_dropoff, o.customer_kind]);
  return (
    <div className="sf-page created" role="status">
      {o.tag_no ? <>
        <p className="created-label">Order taken on basket card</p>
        <p className="created-no">{o.tag_no}</p>
        <p className="created-sub">Order no. {o.order_no}</p>
      </> : <>
        <p className="created-label">Order taken. Write this on the bag tag:</p>
        <p className="created-no">{o.order_no}</p>
      </>}
      <p className="created-meta">{o.student_name}{o.customer_kind === 'WALKIN' ? '' : `, room ${o.room_no}`}. {serviceLine(o)}: {plural(o.clothes_count, 'piece')}{Number(o.weight_kg) > 0 ? `, ${kg(o.weight_kg)}` : ''}{o.amount ? `. ${rupees(o.amount)} due at pickup` : ''}.</p>
      <p className="created-sub">{o.customer_kind === 'WALKIN' ? 'Walk-in: tell them the order no. They show it at pickup.' : 'The digital slip is already on the student’s phone.'}</p>
      {rules.sign_dropoff && o.customer_kind !== 'WALKIN' && !signed && <CodeEntry o={o} kind="DROPOFF" onDone={() => setSigned(true)} />}
      {signed && <div className="code-done"><Icon name="check" size={22} /><span><b>Confirmed by the student</b><small>They gave the code from their phone.</small></span></div>}
      <Button ref={next} tone={rules.sign_dropoff && !signed && o.customer_kind !== 'WALKIN' ? 'quiet' : 'primary'} size="lg" block icon="plus" onClick={onNext}>{rules.sign_dropoff && !signed && o.customer_kind !== 'WALKIN' ? 'Next student (not confirmed yet)' : 'Next student'}</Button>
      <Button block onClick={onOpen}>Open this order</Button>
    </div>
  );
}

/* ----------------------------------------------------------------- pickup */

function Pickup({ settings, onDone, openOrder, isAdmin }: { settings?: OpsSettings; onDone: () => void; openOrder: (id: number) => void; isAdmin?: boolean }) {
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
            <input id="orderno" className="find-input upper" value={code} onChange={e => setCode(e.target.value)} placeholder="or type card no. (A1002) or order no." autoCapitalize="characters" autoComplete="off" spellCheck={false} />
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
            {found.tag_no && <span className="pick-no card-no">{found.tag_no}</span>}
            <span className={found.tag_no ? 'pick-sub' : 'pick-no'}>{found.order_no}</span>
            <StatusPill status={found.status} late={found.late} />
            <PayPill o={found} />
          </div>
          {found.status === 'DELIVERED' ? (
            <div className="stop-box"><Icon name="alert" size={28} /><b>Already handed over</b><p>{when(found.delivered_at, 'short')} by {found.delivered_by_name}. Do not give clothes again.</p></div>
          ) : found.status === 'CANCELLED' ? (
            <div className="stop-box"><Icon name="x" size={28} /><b>This order was cancelled</b><p>{found.cancel_reason}</p></div>
          ) : (
            <>
              <div className={`verify${found.via !== 'QR' ? ' strict' : ''}`}>
                <StudentLine o={found} photoSize={96} />
                <p>{found.via === 'QR' ? 'Slip QR verified. Check the face matches the photo and the ID card.'
                  : found.via === 'CARD' ? `Found by card ${found.tag_no}: check the person matches the photo and their ID card before handing over.`
                  : 'Typed order no.: check the student’s physical ID card before handing over.'}</p>
              </div>
              <HandOver o={found} payFirst={settings?.pay_before_pickup ?? true} isAdmin={isAdmin} onDone={o => { setHanded(o); onDone(); }} />
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
      {selectable ? <label className="row-check"><input type="checkbox" checked={!!selected} onChange={e => onSelect?.(e.target.checked)} aria-label={`Select ${o.order_no}`} /></label>
        : onSelect && <span className="row-check lock" title="Waiting for the student’s code"><Icon name="lock" size={18} /></span>}
      <button onClick={onOpen}>
        <span className="or-no">{o.tag_no ? <span className="card-no">{o.tag_no}</span> : o.order_no}{o.tag_no && <small>{o.order_no}</small>}</span>
        <span className="or-who"><b>{o.student_name}</b><small>{o.hostel_name}, room {o.room_no}</small></span>
        <span className="or-load">{o.clothes_count}<small>pcs</small></span>
        <span className="or-load">{Number(o.weight_kg).toFixed(1)}<small>kg</small></span>
        <span className="or-state"><StatusPill status={o.status} late={o.late} awaiting={isAwaiting(o)} />{o.payment_status === 'DUE' && <PayPill o={o} />}<small>{o.status === 'READY' ? `since ${when(o.ready_at, 'time')}` : `due ${when(o.expected_at, 'short')}`}</small></span>
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
  // Orders the student has not confirmed with the code stay where they are: they can't be selected to move.
  const movable = rows.filter(r => !isAwaiting(r));
  const allOn = movable.length > 0 && movable.every(r => sel.has(r.id));
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
        {movable.length > 0 && <label className="select-all"><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(movable.map(r => r.id)) : new Set())} />Select all</label>}
      </div>
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !rows.length ? <Empty icon="washer" title={lane === 'LATE' ? 'Nothing is late' : `No orders in ${lane.toLowerCase()}`} /> : (
        <ul className="order-rows">
          {rows.map(o => <OrderRow key={o.id} o={o} onOpen={() => openOrder(o.id)} selectable={!isAwaiting(o)} selected={sel.has(o.id)} onSelect={on => { const n = new Set(sel); if (on) n.add(o.id); else n.delete(o.id); setSel(n); }} />)}
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

function Students({ openStudent, pending, roomChanges }: { openStudent: (id: number) => void; pending: number; roomChanges: number }) {
  const [view, setView] = useState<'PENDING' | 'ROOMS' | ''>(pending ? 'PENDING' : roomChanges ? 'ROOMS' : '');
  const [q, setQ] = useState('');
  // Each answer remembers which list it is, so rows of one list are never drawn as another.
  const loaded = useLoad<{ rows: Student[]; total: number; view: typeof view }>(() => view === 'ROOMS'
    ? api<{ rows: Student[] }>('/ops/room-changes').then(r => ({ rows: r.rows, total: r.rows.length, view }))
    : api<{ rows: Student[]; total: number }>(`/ops/students?status=${view}&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(r => ({ ...r, view })), [view, q], { every: 30_000 });
  const list = { ...loaded, data: loaded.data?.view === view ? loaded.data : undefined };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
  return (
    <div className="sf-page">
      <h1>Students</h1>
      <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'PENDING', label: `New${pending ? ` (${pending})` : ''}` }, { value: 'ROOMS', label: `Room changes${roomChanges ? ` (${roomChanges})` : ''}` }, { value: '', label: 'Everyone' }]} />
      {view !== 'ROOMS' && <input className="filter-input" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search name, ID card, room or mobile" aria-label="Search students" />}
      {!list.data ? <Loading /> : !list.data.rows.length ? <Empty icon="users" title={view === 'PENDING' ? 'No one is waiting' : view === 'ROOMS' ? 'No room changes waiting' : 'No students found'}>{view === 'PENDING' ? 'New sign-ups appear here for you to check against the university portal.' : view === 'ROOMS' ? 'When a student changes hostel or room in their profile, it waits here for you to check.' : ''}</Empty> : (
        <ul className="student-rows">
          {list.data.rows.map(s => (
            <li key={s.id}><button onClick={() => openStudent(s.id)}>
              <Avatar name={s.name} photo={s.photo} size={40} />
              <span className="sr-who"><b>{s.name}</b><small>{view === 'ROOMS' ? `${s.hostel_name} ${s.room_no} → ${s.pending_hostel_name} ${s.pending_room_no}` : `${s.id_card_no}, ${s.hostel_name}, room ${s.room_no}`}</small></span>
              {view === 'ROOMS' ? <span className="pill acc-pending">Check</span> : s.status !== 'ACTIVE' ? <span className={`pill acc-${s.status.toLowerCase()}`}>{s.status === 'PENDING' ? 'Check' : s.status.toLowerCase()}</span> : <small className="sr-month">{s.month_orders} this month</small>}
              <Icon name="next" size={18} />
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { OrderRow };
