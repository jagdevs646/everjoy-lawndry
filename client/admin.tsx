import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Announcement, api, download, Hostel, Order, Student, User } from './api';
import { ChangePassword } from './auth';
import { ago, kg, plural, rupees, shiftDay, toast, todayKey, useAction, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { ComplaintsBoard, OrderSheet, StudentSheet } from './ops';
import { Brand, Button, Empty, ErrorNote, Field, Icon, IconButton, IconName, Loading, PayPill, Segmented, Sheet, StatusPill, Switch } from './ui';

type Overview = {
  today: { orders: number; kg: number; delivered: number };
  month: { orders: number; kg: number; revenue: number; students: number };
  open: { in_progress: number; ready: number; late: number; uncollected: number; dues: number; pending_students: number; complaints: number };
  totals: { students: number; staff: number };
  days: { day: string; orders: number; kg: number }[];
  hostels: { name: string; orders: number; kg: number }[];
  setup: { key: string; label: string; done: boolean }[];
  upi_configured: boolean;
  recent: { action: string; entity_id: string | null; detail: string; created_at: string; actor_name: string | null }[];
};

const NAV: { key: string; label: string; icon: IconName }[] = [
  { key: '', label: 'Overview', icon: 'chart' },
  { key: 'register', label: 'Register', icon: 'list' },
  { key: 'students', label: 'Students', icon: 'users' },
  { key: 'complaints', label: 'Complaints', icon: 'help' },
  { key: 'notices', label: 'Notices', icon: 'megaphone' },
  { key: 'reports', label: 'Reports', icon: 'download' },
  { key: 'staff', label: 'Staff', icon: 'card' },
  { key: 'settings', label: 'Rules & pricing', icon: 'sliders' },
  { key: 'activity', label: 'Activity log', icon: 'activity' },
];

export function AdminApp({ user, onSignOut, onUser, onCounter }: { user: User; onSignOut: () => void; onUser: (u: User) => void; onCounter: () => void }) {
  const [page] = useRoute();
  const current = NAV.find(n => n.key === (page ?? '')) ?? NAV[0];
  const [drawer, setDrawer] = useState(false);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [studentId, setStudentId] = useState<number | null>(null);
  const [bump, setBump] = useState(0);   // refresh the page behind a sheet after a change
  const [pw, setPw] = useState(false);
  useEffect(() => setDrawer(false), [page]);
  useScrollTop(current.key);
  const changed = () => setBump(b => b + 1);
  const open = { order: setOrderId, student: setStudentId };

  return (
    <div className={`ad-shell${drawer ? ' drawer-open' : ''}`}>
      <aside className="ad-side">
        <div className="ad-side-head"><Brand sub="Office" /></div>
        <nav aria-label="Admin">
          {NAV.map(n => <a key={n.key} href={`#/${n.key}`} className={current.key === n.key ? 'on' : ''} aria-current={current.key === n.key ? 'page' : undefined}><Icon name={n.icon} size={18} />{n.label}</a>)}
        </nav>
        <div className="ad-side-foot">
          <button onClick={onCounter}><Icon name="washer" size={18} />Open the counter</button>
          <button onClick={() => setPw(true)}><Icon name="lock" size={18} />Change password</button>
          <button onClick={onSignOut}><Icon name="logout" size={18} />Sign out</button>
          <small>{user.name}</small>
        </div>
      </aside>
      <div className="ad-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <div className="ad-body">
        <header className="ad-top">
          <IconButton icon="menu" label="Menu" className="ad-menu" onClick={() => setDrawer(true)} />
          <div>
            <h1>{current.label}</h1>
            <p>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          </div>
          <Button icon="washer" onClick={onCounter} className="ad-counter-btn">Counter</Button>
        </header>
        <main className="ad-main" key={bump}>
          {current.key === '' && <OverviewPage open={open} />}
          {current.key === 'register' && <Register open={open} />}
          {current.key === 'students' && <Students open={open} />}
          {current.key === 'complaints' && <div className="ad-narrow"><ComplaintsBoard onOpenOrder={setOrderId} /></div>}
          {current.key === 'notices' && <Notices />}
          {current.key === 'reports' && <Reports />}
          {current.key === 'staff' && <Staff me={user} />}
          {current.key === 'settings' && <Settings />}
          {current.key === 'activity' && <Activity />}
        </main>
      </div>
      {orderId && <OrderSheet id={orderId} isAdmin payFirst close={() => setOrderId(null)} onChanged={changed} />}
      {studentId && <StudentSheet id={studentId} isAdmin close={() => setStudentId(null)} onChanged={changed} onOpenOrder={id => { setStudentId(null); setOrderId(id); }} />}
      {pw && <Sheet title="Change password" onClose={() => setPw(false)} size="sm"><ChangePassword user={user} onDone={u => { onUser(u); setPw(false); }} /></Sheet>}
    </div>
  );
}

type Openers = { order: (id: number) => void; student: (id: number) => void };

/* --------------------------------------------------------------- overview */

function OverviewPage(_: { open: Openers }) {
  const d = useLoad(() => api<Overview>('/admin/overview'), [], { every: 60_000 });
  if (!d.data) return d.error ? <ErrorNote error={d.error} retry={d.reload} /> : <Loading />;
  const o = d.data;
  const setupLeft = o.setup.filter(s => !s.done);
  const items: { n: number; text: string; to: string; icon: IconName; tone?: string }[] = [
    { n: o.open.pending_students, text: `${plural(o.open.pending_students, 'student')} waiting for approval`, to: 'students', icon: 'card' },
    { n: o.open.late, text: `${plural(o.open.late, 'order')} past the promised time`, to: 'register?LATE', icon: 'clock', tone: 'bad' },
    { n: o.open.uncollected, text: `${plural(o.open.uncollected, 'order')} ready for over 3 days, not collected`, to: 'register?READY', icon: 'shirt' },
    { n: o.open.complaints, text: `${plural(o.open.complaints, 'complaint')} open`, to: 'complaints', icon: 'help', tone: 'bad' },
    { n: o.open.dues, text: `${rupees(o.open.dues)} still to be collected`, to: 'register?DUE', icon: 'rupee' },
  ];
  const attention = items.filter(a => a.n > 0);

  return (
    <div className="ad-overview">
      <p className="ad-summary">
        Today <b>{plural(o.today.orders, 'order')}</b> and <b>{kg(o.today.kg)}</b> came in, and <b>{o.today.delivered}</b> {o.today.delivered === 1 ? 'was' : 'were'} handed back.{' '}
        <b>{o.open.in_progress}</b> {o.open.in_progress === 1 ? 'is' : 'are'} in washing and <b>{o.open.ready}</b> {o.open.ready === 1 ? 'is' : 'are'} waiting on the shelf.
      </p>

      {setupLeft.length > 0 && (
        <section className="ad-card setup">
          <h2>Finish setting up</h2>
          <ul>{o.setup.map(s => <li key={s.key} className={s.done ? 'done' : ''}><Icon name={s.done ? 'check' : 'clock'} size={18} /><a href={`#/${s.key === 'hostels' || s.key === 'rules' ? 'settings' : s.key === 'staff' ? 'staff' : ''}`} onClick={e => { if (s.key === 'password') { e.preventDefault(); toast('Use “Change password” at the bottom of the menu.'); } }}>{s.label}</a></li>)}</ul>
        </section>
      )}

      <div className="ad-grid">
        <section className="ad-card chart-card">
          <h2>Orders per day, last 14 days</h2>
          <DayBars days={o.days} />
        </section>
        <section className="ad-card">
          <h2>Needs attention</h2>
          {attention.length ? (
            <ul className="attention">
              {attention.map(a => <li key={a.text} className={a.tone}><a href={`#/${a.to.split('?')[0]}`} onClick={() => a.to.includes('?') && sessionStorage.setItem('ej-register-preset', a.to.split('?')[1])}><Icon name={a.icon} size={18} />{a.text}<Icon name="next" size={16} /></a></li>)}
            </ul>
          ) : <p className="muted">All clear. Nothing late, nothing waiting.</p>}
        </section>
      </div>

      <div className="ad-grid">
        <section className="ad-card">
          <h2>This month</h2>
          <dl className="month-facts">
            <div><dt>Orders</dt><dd>{o.month.orders}</dd></div>
            <div><dt>Washed</dt><dd>{kg(o.month.kg)}</dd></div>
            <div><dt>Students served</dt><dd>{o.month.students}<small> of {o.totals.students}</small></dd></div>
            <div><dt>Collected</dt><dd>{rupees(o.month.revenue)}</dd></div>
          </dl>
          {o.hostels.length > 0 && (
            <table className="hostel-bars">
              <caption>By hostel</caption>
              <tbody>
                {o.hostels.map(h => {
                  const max = Math.max(...o.hostels.map(x => x.orders));
                  return <tr key={h.name}><th scope="row">{h.name}</th><td><span className="hbar" style={{ width: `${(h.orders / max) * 100}%` }} /></td><td className="num">{h.orders}</td><td className="num muted">{kg(h.kg)}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </section>
        <section className="ad-card">
          <h2>Recent activity</h2>
          <ul className="recent">
            {o.recent.map((r, i) => <li key={i}><span><b>{r.actor_name ?? 'System'}</b> {actionText(r.action)} {r.entity_id ?? ''}</span><small>{ago(r.created_at)}</small></li>)}
          </ul>
          <a className="more-link" href="#/activity">Full activity log</a>
        </section>
      </div>
    </div>
  );
}

/** Single-series bar chart. One hue; the title names the series; hover or focus a bar for its numbers. */
function DayBars({ days }: { days: Overview['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width so tick text stays readable on phones.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(4, ...days.map(d => d.orders));
  const nice = Math.ceil(max / 4) * 4;
  const H = 180, pad = { l: 28, r: 8, t: 10, b: 26 };
  const bw = (W - pad.l - pad.r) / days.length;
  const every = bw < 26 ? 3 : bw < 44 ? 2 : 1;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  const label = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const wk = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="daybars" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Orders per day. ${days.map(d => `${label(d.day)}: ${d.orders}`).join(', ')}`}>
        {[0, nice / 2, nice].map(t => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 6} y={y(t) + 4} className="tick" textAnchor="end">{t}</text></g>)}
        {days.map((d, i) => {
          const x = pad.l + i * bw + 2;
          const top = y(d.orders);
          const hgt = H - pad.b - top;
          const r = Math.min(4, hgt / 2, (bw - 4) / 2);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} className="bar-hit">
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {d.orders > 0 && <path className={`bar${hover === i ? ' on' : ''}`} d={`M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - 4 - r} Q${x + bw - 4},${top} ${x + bw - 4},${top + r} V${H - pad.b} Z`} />}
              {(days.length - 1 - i) % every === 0 && <text x={pad.l + i * bw + bw / 2} y={H - 8} className="tick" textAnchor="middle">{i === days.length - 1 ? 'Today' : label(d.day)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="base" />
      </svg>
      <p className="daybars-tip" aria-live="polite">{h ? <><b>{wk(h.day)} {label(h.day)}</b>: {plural(h.orders, 'order')}, {kg(h.kg)}</> : <>Total {days.reduce((a, d) => a + d.orders, 0)} orders, {kg(days.reduce((a, d) => a + d.kg, 0))}. Hover a bar for the day.</>}</p>
    </div>
  );
}

export function actionText(a: string) {
  return ({
    ORDER_CREATED: 'took order', ORDER_STATUS: 'updated', ORDER_DELIVERED: 'handed over', ORDER_CANCELLED: 'cancelled', ORDER_CORRECTED: 'corrected',
    PAYMENT_RECORDED: 'recorded payment for', PAYMENT_WAIVED: 'waived payment for', STUDENT_SIGNUP: 'registered as', STUDENT_APPROVED: 'approved', STUDENT_REJECTED: 'rejected',
    STUDENT_EDITED: 'edited student', STUDENT_SUSPENDED: 'put on hold', STUDENT_REACTIVATED: 'reactivated', STUDENT_RESUBMITTED: 'resubmitted details for', PROFILE_UPDATED: 'updated profile',
    PASSWORD_RESET: 'reset password for', PASSWORD_CHANGED: 'changed password', SETTINGS_CHANGED: 'changed rules', HOSTEL_ADDED: 'added hostel', HOSTEL_UPDATED: 'updated hostel',
    STAFF_CREATED: 'created staff', STAFF_DEACTIVATED: 'switched off', STAFF_REACTIVATED: 'switched on', STAFF_UPDATED: 'updated staff', ANNOUNCEMENT_POSTED: 'posted notice',
    ANNOUNCEMENT_REMOVED: 'removed notice', COMPLAINT_RAISED: 'raised complaint', COMPLAINT_UPDATED: 'replied to complaint', EXPORTED: 'exported register', BACKUP_DOWNLOADED: 'downloaded backup', DEMO_SEEDED: 'loaded demo data',
  } as Record<string, string>)[a] ?? a.toLowerCase().replace(/_/g, ' ');
}

/* --------------------------------------------------------------- register */

const monthStart = () => `${todayKey().slice(0, 7)}-01`;

function Register({ open }: { open: Openers }) {
  const preset = (() => { try { const p = sessionStorage.getItem('ej-register-preset'); sessionStorage.removeItem('ej-register-preset'); return p; } catch { return null; } })();
  const [f, setF] = useState({ q: '', from: preset ? '' : monthStart(), to: '', status: preset && preset !== 'DUE' ? preset : '', hostel: '', payment: preset === 'DUE' ? 'DUE' : '' });
  const [limit, setLimit] = useState(100);
  const hostels = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: String(limit) }).filter(([, v]) => v)).toString();
  const list = useLoad(() => api<{ rows: Order[]; total: number }>(`/ops/orders?${qs}`), [qs], { every: 60_000 });
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setLimit(100); };
  const exportXlsx = () => run(async () => {
    const from = f.from || '2000-01-01';
    const to = f.to || todayKey();
    await download(`/admin/export?${new URLSearchParams(Object.entries({ from, to, status: f.status === 'OPEN' || f.status === 'LATE' ? '' : f.status, hostel: f.hostel, payment: f.payment }).filter(([, v]) => v))}`, 'everjoy-register.xlsx');
  }, 'Excel file downloaded');
  return (
    <div className="stack">
      <div className="filters">
        <input className="grow" value={f.q} onChange={set('q')} placeholder="Search order no., name, ID card, room, mobile" aria-label="Search" />
        <label>From <input type="date" value={f.from} onChange={set('from')} /></label>
        <label>To <input type="date" value={f.to} onChange={set('to')} /></label>
        <select value={f.status} onChange={set('status')} aria-label="Status">
          <option value="">Any status</option><option value="OPEN">In progress</option><option value="LATE">Late</option>
          <option value="RECEIVED">Received</option><option value="WASHING">Washing</option><option value="READY">Ready</option><option value="DELIVERED">Handed over</option><option value="CANCELLED">Cancelled</option>
        </select>
        <select value={f.hostel} onChange={set('hostel')} aria-label="Hostel">
          <option value="">All hostels</option>{hostels.data?.hostels.map(h => <option key={h.id}>{h.name}</option>)}
        </select>
        <select value={f.payment} onChange={set('payment')} aria-label="Payment">
          <option value="">Any payment</option><option value="DUE">Due</option><option value="PAID">Paid</option><option value="WAIVED">Waived</option><option value="NONE">No charge</option>
        </select>
        <Button tone="primary" icon="download" busy={busy} onClick={exportXlsx}>Excel</Button>
      </div>
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !list.data.rows.length ? <Empty icon="list" title="No orders match">Try a wider date range or clear the filters.</Empty> : (
        <>
          <p className="muted small">{list.data.total} {list.data.total === 1 ? 'order' : 'orders'}{f.from ? ` from ${when(`${f.from}T12:00:00`, 'date')}` : ''}{f.to ? ` to ${when(`${f.to}T12:00:00`, 'date')}` : ''}</p>
          <div className="ledger-wrap">
            <table className="ledger">
              <thead><tr><th>Order</th><th>Date in</th><th>Student</th><th>Room</th><th className="num">Clothes</th><th className="num">Kg</th><th>Status</th><th>Payment</th><th>Handed over</th></tr></thead>
              <tbody>
                {list.data.rows.map(o => (
                  <tr key={o.id} onClick={() => open.order(o.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open.order(o.id)}>
                    <td className="ord">{o.order_no}</td>
                    <td>{when(o.received_at)}</td>
                    <td><b>{o.student_name}</b><small>{o.id_card_no}</small></td>
                    <td>{o.room_no}<small>{o.hostel_name}</small></td>
                    <td className="num">{o.clothes_count}{o.returned_count != null && o.returned_count !== o.clothes_count && <small className="bad">{o.returned_count} back</small>}</td>
                    <td className="num">{Number(o.weight_kg).toFixed(1)}</td>
                    <td><StatusPill status={o.status} late={o.late} /></td>
                    <td>{o.amount > 0 ? <PayPill o={o} /> : <span className="muted">–</span>}</td>
                    <td>{o.delivered_at ? <>{when(o.delivered_at)}<small>{o.delivered_by_name}</small></> : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data.rows.length < list.data.total && <Button onClick={() => setLimit(limit + 200)}>Show more</Button>}
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- students */

function Students({ open }: { open: Openers }) {
  const [f, setF] = useState({ q: '', status: '', hostelId: '' });
  const hostels = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: '300' }).filter(([, v]) => v)).toString();
  const list = useLoad(() => api<{ rows: Student[]; total: number }>(`/ops/students?${qs}`), [qs]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const label: Record<string, string> = { ACTIVE: 'Approved', PENDING: 'Waiting', REJECTED: 'Rejected', SUSPENDED: 'On hold' };
  return (
    <div className="stack">
      <div className="filters">
        <input className="grow" value={f.q} onChange={set('q')} placeholder="Search name, ID card, mobile or room" aria-label="Search students" />
        <select value={f.status} onChange={set('status')} aria-label="Account status"><option value="">Everyone</option><option value="PENDING">Waiting for approval</option><option value="ACTIVE">Approved</option><option value="REJECTED">Rejected</option><option value="SUSPENDED">On hold</option></select>
        <select value={f.hostelId} onChange={set('hostelId')} aria-label="Hostel"><option value="">All hostels</option>{hostels.data?.hostels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      </div>
      {!list.data ? <Loading /> : !list.data.rows.length ? <Empty icon="users" title="No students found">Students appear here after they register on the website.</Empty> : (
        <>
          <p className="muted small">{plural(list.data.total, 'student')}</p>
          <div className="ledger-wrap">
            <table className="ledger">
              <thead><tr><th>Name</th><th>ID card no.</th><th>Hostel, room</th><th>Mobile</th><th>Account</th><th className="num">This month</th><th className="num">In progress</th></tr></thead>
              <tbody>
                {list.data.rows.map(s => (
                  <tr key={s.id} onClick={() => open.student(s.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open.student(s.id)}>
                    <td><b>{s.name}</b><small>Joined {when(s.created_at, 'date')}</small></td>
                    <td className="ord">{s.id_card_no}</td>
                    <td>{s.hostel_name}, {s.room_no}</td>
                    <td>{s.mobile}</td>
                    <td><span className={`pill acc-${s.status.toLowerCase()}`}>{label[s.status]}</span></td>
                    <td className="num">{s.month_orders}<small>{kg(s.month_kg)}</small></td>
                    <td className="num">{s.open_orders || <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ staff */

type StaffRow = { id: number; name: string; login_id: string; mobile: string | null; role: 'STAFF' | 'ADMIN'; active: number; created_at: string; month_received: number; month_delivered: number };

function Staff({ me }: { me: User }) {
  const list = useLoad(() => api<{ rows: StaffRow[] }>('/admin/staff'), []);
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ name: string; pass: string } | null>(null);
  const { busy, run } = useAction();
  const toggle = async (s: StaffRow) => {
    if (s.active && !window.confirm(`Switch off ${s.name}? They will be signed out and cannot sign in again until switched back on. Their past records stay.`)) return;
    if (await run(() => api(`/admin/staff/${s.id}`, { method: 'PATCH', body: { active: !s.active } }), s.active ? `${s.name} switched off` : `${s.name} switched on`) !== undefined) void list.reload();
  };
  const reset = async (s: StaffRow) => {
    if (!window.confirm(`Reset ${s.name}'s password?`)) return;
    const r = await run(() => api<{ tempPassword: string }>(`/admin/staff/${s.id}/reset-password`, { method: 'POST' }));
    if (r) setTemp({ name: s.name, pass: r.tempPassword });
  };
  return (
    <div className="stack ad-narrow">
      <div className="row-between"><p className="muted">People who can sign in to the counter or this office. Switch someone off when they leave; their history stays.</p><Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add staff</Button></div>
      {temp && <div className="temp-pass" role="status"><span>Temporary password for {temp.name}</span><b>{temp.pass}</b><small>They will choose a new one after signing in.</small></div>}
      {!list.data ? <Loading /> : (
        <div className="ledger-wrap">
          <table className="ledger">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Mobile</th><th className="num">Taken this month</th><th className="num">Handed over</th><th>Account</th><th /></tr></thead>
            <tbody>
              {list.data.rows.map(s => (
                <tr key={s.id} className={s.active ? '' : 'off'}>
                  <td><b>{s.name}</b>{s.id === me.id && <small>You</small>}</td>
                  <td className="ord">{s.login_id}</td>
                  <td>{s.role === 'ADMIN' ? 'Admin' : 'Counter staff'}</td>
                  <td>{s.mobile ?? <span className="muted">–</span>}</td>
                  <td className="num">{s.month_received}</td>
                  <td className="num">{s.month_delivered}</td>
                  <td><span className={`pill ${s.active ? 'acc-active' : 'acc-suspended'}`}>{s.active ? 'Active' : 'Switched off'}</span></td>
                  <td className="row-actions">
                    <Button size="sm" busy={busy} onClick={() => reset(s)}>Reset password</Button>
                    {s.id !== me.id && <Button size="sm" tone={s.active ? 'danger' : 'quiet'} onClick={() => toggle(s)}>{s.active ? 'Switch off' : 'Switch on'}</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddStaff close={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); }} />}
    </div>
  );
}

function AddStaff({ close, onDone }: { close: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', loginId: '', mobile: '', password: '', role: 'STAFF' as 'STAFF' | 'ADMIN' });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await submit(() => api('/admin/staff', { body: f }), `Account created for ${f.name}`)) onDone();
  };
  return (
    <Sheet title="Add staff" onClose={close} size="sm">
      <form className="stack" onSubmit={save}>
        <Field label="Full name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Username" hint="They sign in with this, e.g. RAMESH"><input value={f.loginId} onChange={e => setF({ ...f, loginId: e.target.value })} autoCapitalize="characters" required /></Field>
        <Field label="Mobile (optional)"><input value={f.mobile} onChange={e => setF({ ...f, mobile: e.target.value })} inputMode="tel" /></Field>
        <Field label="First password" hint="At least 8 characters. They must change it on first sign-in."><input value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></Field>
        <Segmented label="Role" value={f.role} onChange={role => setF({ ...f, role })} options={[{ value: 'STAFF', label: 'Counter staff' }, { value: 'ADMIN', label: 'Admin' }]} />
        {error && <ErrorNote error={error} />}
        <Button tone="primary" block busy={busy}>Create account</Button>
      </form>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- notices */

function Notices() {
  const list = useLoad(() => api<{ rows: Announcement[] }>('/admin/announcements'), []);
  const hostels = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  const [f, setF] = useState({ title: '', body: '', hostelId: '', expiresOn: '', notify: true });
  const { busy, error, submit } = useFormAction();
  const del = useAction();
  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (await submit(() => api('/admin/announcements', { body: f }), f.notify ? 'Notice posted and sent to students' : 'Notice posted')) { setF({ title: '', body: '', hostelId: '', expiresOn: '', notify: true }); void list.reload(); }
  };
  const remove = async (a: Announcement) => {
    if (!window.confirm(`Remove “${a.title}”? Students will no longer see it.`)) return;
    if (await del.run(() => api(`/admin/announcements/${a.id}`, { method: 'DELETE' }), 'Notice removed') !== undefined) void list.reload();
  };
  return (
    <div className="ad-two">
      <form className="ad-card stack" onSubmit={post}>
        <h2>Post a notice</h2>
        <Field label="Title"><input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="e.g. Counter closed on Sunday" maxLength={80} /></Field>
        <Field label="Message"><textarea rows={4} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} maxLength={600} placeholder="What students need to know and do" /></Field>
        <div className="field-row">
          <Field label="Who sees it"><select value={f.hostelId} onChange={e => setF({ ...f, hostelId: e.target.value })}><option value="">All students</option>{hostels.data?.hostels.map(h => <option key={h.id} value={h.id}>{h.name} only</option>)}</select></Field>
          <Field label="Hide after (optional)"><input type="date" value={f.expiresOn} min={todayKey()} onChange={e => setF({ ...f, expiresOn: e.target.value })} /></Field>
        </div>
        <Switch checked={f.notify} onChange={notify => setF({ ...f, notify })} label="Also send as a notification" hint="Shows on the bell icon on each student’s phone" />
        {error && <ErrorNote error={error} />}
        <Button tone="primary" busy={busy} icon="megaphone" disabled={f.title.trim().length < 3 || f.body.trim().length < 3}>Post notice</Button>
      </form>
      <section className="stack">
        <h2 className="sub">Showing to students</h2>
        {!list.data ? <Loading /> : !list.data.rows.length ? <Empty icon="megaphone" title="No notices">Post holidays, closures or timing changes here.</Empty> : list.data.rows.map(a => (
          <article key={a.id} className={`ad-card notice-item${a.expired ? ' expired' : ''}`}>
            <div className="row-between"><b>{a.title}</b><Button size="sm" tone="plain" icon="x" onClick={() => remove(a)} aria-label={`Remove ${a.title}`} /></div>
            <p>{a.body}</p>
            <small className="muted">{a.hostel_name ? `${a.hostel_name} only` : 'All students'}. Posted {ago(a.created_at)} by {a.created_by_name}.{a.expires_on ? ` ${a.expired ? 'Expired' : 'Hides after'} ${when(`${a.expires_on}T12:00:00`, 'date')}.` : ''}</small>
          </article>
        ))}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- reports */

type Report = {
  totals: { orders: number; kg: number; clothes: number; delivered: number; cancelled: number; students: number; mismatches: number; extra_kg: number; express: number };
  money: { collected: number; cash: number; upi: number; due: number; waived: number };
  byHostel: { name: string; orders: number; kg: number; clothes: number }[];
  byStaff: { name: string; received: number; delivered: number }[];
  topStudents: { name: string; id_card_no: string; orders: number; kg: number }[];
};

function Reports() {
  const today = todayKey();
  const presets = [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'week', label: 'Last 7 days', from: shiftDay(today, -6), to: today },
    { key: 'month', label: 'This month', from: `${today.slice(0, 7)}-01`, to: today },
    { key: 'last', label: 'Last month', from: (() => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00`); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })(), to: shiftDay(`${today.slice(0, 7)}-01`, -1) },
  ];
  const [r, setR] = useState({ from: presets[2].from, to: presets[2].to });
  const rep = useLoad(() => api<Report>(`/admin/report?from=${r.from}&to=${r.to}`), [r.from, r.to]);
  const { busy, run } = useAction();
  const backup = useAction();
  const t = rep.data;
  return (
    <div className="stack">
      <div className="filters">
        <Segmented label="Period" value={presets.find(p => p.from === r.from && p.to === r.to)?.key ?? ''} onChange={k => { const p = presets.find(x => x.key === k)!; setR({ from: p.from, to: p.to }); }} options={presets.map(p => ({ value: p.key, label: p.label }))} />
        <label>From <input type="date" value={r.from} onChange={e => setR({ ...r, from: e.target.value })} /></label>
        <label>To <input type="date" value={r.to} onChange={e => setR({ ...r, to: e.target.value })} /></label>
        <Button tone="primary" icon="download" busy={busy} onClick={() => run(() => download(`/admin/export?from=${r.from}&to=${r.to}`, 'everjoy-register.xlsx'), 'Excel file downloaded')}>Download register (Excel)</Button>
      </div>
      {!t ? (rep.error ? <ErrorNote error={rep.error} /> : <Loading />) : (
        <>
          <div className="ad-grid three">
            <ReportBlock title="Laundry">
              <Row k="Orders" v={t.totals.orders} /><Row k="Clothes" v={t.totals.clothes} /><Row k="Weight" v={kg(t.totals.kg)} />
              <Row k="Handed over" v={t.totals.delivered} /><Row k="Cancelled" v={t.totals.cancelled} /><Row k="Students" v={t.totals.students} />
              <Row k="Count mismatches at pickup" v={t.totals.mismatches} warn={t.totals.mismatches > 0} />
            </ReportBlock>
            <ReportBlock title="Money">
              <Row k="Collected" v={rupees(t.money.collected)} /><Row k="Cash" v={rupees(t.money.cash)} /><Row k="UPI" v={rupees(t.money.upi)} />
              <Row k="Still due" v={rupees(t.money.due)} warn={t.money.due > 0} /><Row k="Waived" v={rupees(t.money.waived)} />
              <Row k="Weight over monthly limit" v={kg(t.totals.extra_kg)} /><Row k="Express orders" v={t.totals.express} />
            </ReportBlock>
            <ReportBlock title="Staff">
              {t.byStaff.length ? t.byStaff.map(s => <Row key={s.name} k={s.name} v={`${s.received} taken, ${s.delivered} handed over`} />) : <p className="muted">No activity.</p>}
            </ReportBlock>
          </div>
          <div className="ad-grid">
            <ReportBlock title="By hostel">
              {t.byHostel.length ? <table className="mini-table"><thead><tr><th>Hostel</th><th className="num">Orders</th><th className="num">Clothes</th><th className="num">Kg</th></tr></thead><tbody>{t.byHostel.map(h => <tr key={h.name}><td>{h.name}</td><td className="num">{h.orders}</td><td className="num">{h.clothes}</td><td className="num">{h.kg}</td></tr>)}</tbody></table> : <p className="muted">No orders.</p>}
            </ReportBlock>
            <ReportBlock title="Heaviest users">
              {t.topStudents.length ? <table className="mini-table"><thead><tr><th>Student</th><th className="num">Orders</th><th className="num">Kg</th></tr></thead><tbody>{t.topStudents.map(s => <tr key={s.id_card_no}><td>{s.name}<small>{s.id_card_no}</small></td><td className="num">{s.orders}</td><td className="num">{s.kg}</td></tr>)}</tbody></table> : <p className="muted">No orders.</p>}
            </ReportBlock>
          </div>
        </>
      )}
      <section className="ad-card backup">
        <div><h2>Backup</h2><p className="muted">Download a full copy of the database (students, orders, payments, complaints). Keep one copy every week on a pen drive or Google Drive.</p></div>
        <Button icon="database" busy={backup.busy} onClick={() => backup.run(() => download('/admin/backup', 'everjoy-backup.db'), 'Backup downloaded')}>Download backup</Button>
      </section>
    </div>
  );
}
const ReportBlock = ({ title, children }: { title: string; children: ReactNode }) => <section className="ad-card report-block"><h2>{title}</h2>{children}</section>;
const Row = ({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) => <div className={`kv${warn ? ' warn' : ''}`}><span>{k}</span><b>{v}</b></div>;

/* --------------------------------------------------------------- settings */

type Settings = {
  max_kg_per_order: number; max_active_orders: number; monthly_order_limit: number; monthly_kg_limit: number; over_limit_action: 'BLOCK' | 'CHARGE';
  regular_rate_per_kg: number; extra_rate_per_kg: number; express_enabled: boolean; express_fee: number; regular_turnaround_hours: number; express_turnaround_hours: number;
  pay_before_pickup: boolean; upi_id: string; upi_name: string; counter_hours: string;
};

function Settings() {
  const s = useLoad(() => api<Settings>('/admin/settings'), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const { busy, error, submit } = useFormAction();
  useEffect(() => { if (s.data) setDraft(s.data); }, [s.data]);
  if (!draft) return <Loading />;
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value as unknown as number });
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.data);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Settings>('/admin/settings', { method: 'PUT', body: draft }), 'Rules saved. They apply to new orders from now.');
    if (r) s.set(r);
  };
  return (
    <div className="settings">
      <form className="stack" onSubmit={save}>
        <section className="ad-card settings-group">
          <h2>Each order</h2>
          <div className="field-grid">
            <Field label="Weight limit per order (kg)" hint="The counter blocks anything heavier"><input type="number" step="0.5" min="0.5" value={draft.max_kg_per_order} onChange={num('max_kg_per_order')} /></Field>
            <Field label="Orders a student can have in progress" hint="0 = no limit"><input type="number" min="0" value={draft.max_active_orders} onChange={num('max_active_orders')} /></Field>
            <Field label="Regular ready time (hours)"><input type="number" min="1" value={draft.regular_turnaround_hours} onChange={num('regular_turnaround_hours')} /></Field>
          </div>
        </section>
        <section className="ad-card settings-group">
          <h2>Monthly limit per student</h2>
          <div className="field-grid">
            <Field label="Kg per month" hint="0 = no monthly limit"><input type="number" step="0.5" min="0" value={draft.monthly_kg_limit} onChange={num('monthly_kg_limit')} /></Field>
            <Field label="Orders per month" hint="0 = no limit"><input type="number" min="0" value={draft.monthly_order_limit} onChange={num('monthly_order_limit')} /></Field>
          </div>
          <Field label="When a student goes over the kg limit">
            <Segmented label="Over limit" value={draft.over_limit_action} onChange={v => setDraft({ ...draft, over_limit_action: v })} options={[{ value: 'BLOCK', label: 'Do not accept' }, { value: 'CHARGE', label: 'Accept and charge extra' }]} />
          </Field>
          {draft.over_limit_action === 'CHARGE' && <Field label="Extra charge per kg (₹)"><input type="number" min="0" value={draft.extra_rate_per_kg} onChange={num('extra_rate_per_kg')} /></Field>}
        </section>
        <section className="ad-card settings-group">
          <h2>Pricing</h2>
          <div className="field-grid">
            <Field label="Regular wash, per kg (₹)" hint="0 if laundry is included in hostel fees"><input type="number" min="0" value={draft.regular_rate_per_kg} onChange={num('regular_rate_per_kg')} /></Field>
          </div>
          <Switch checked={draft.express_enabled} onChange={v => setDraft({ ...draft, express_enabled: v })} label="Offer express service" hint="Faster turnaround for a fixed fee" />
          {draft.express_enabled && (
            <div className="field-grid">
              <Field label="Express fee per order (₹)"><input type="number" min="0" value={draft.express_fee} onChange={num('express_fee')} /></Field>
              <Field label="Express ready time (hours)"><input type="number" min="1" value={draft.express_turnaround_hours} onChange={num('express_turnaround_hours')} /></Field>
            </div>
          )}
        </section>
        <section className="ad-card settings-group">
          <h2>Payments</h2>
          <Switch checked={draft.pay_before_pickup} onChange={v => setDraft({ ...draft, pay_before_pickup: v })} label="Payment needed before pickup" hint="Staff cannot hand over clothes while money is due" />
          <div className="field-grid">
            <Field label="UPI ID for students" hint="Adds a “Pay with UPI” button on the student’s phone"><input value={draft.upi_id} onChange={e => setDraft({ ...draft, upi_id: e.target.value })} placeholder="e.g. everjoylaundry@okaxis" /></Field>
            <Field label="Name shown in UPI apps"><input value={draft.upi_name} onChange={e => setDraft({ ...draft, upi_name: e.target.value })} /></Field>
          </div>
        </section>
        <section className="ad-card settings-group">
          <h2>Counter</h2>
          <Field label="Counter timings" hint="Shown on the sign-in page and in student Help"><input value={draft.counter_hours} onChange={e => setDraft({ ...draft, counter_hours: e.target.value })} /></Field>
        </section>
        <div className={`save-bar${dirty ? ' dirty' : ''}`}>
          {error && <ErrorNote error={error} />}
          <span>{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
          <Button type="button" tone="plain" disabled={!dirty} onClick={() => setDraft(s.data!)}>Undo</Button>
          <Button tone="primary" busy={busy} disabled={!dirty}>Save rules</Button>
        </div>
      </form>
      <Hostels />
    </div>
  );
}

function Hostels() {
  const list = useLoad(() => api<{ rows: Hostel[] }>('/admin/hostels'), []);
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/admin/hostels', { body: { name } }), `${name} added`) !== undefined) { setName(''); void list.reload(); }
  };
  const toggle = async (h: Hostel) => { if (await run(() => api(`/admin/hostels/${h.id}`, { method: 'PATCH', body: { active: !h.active } })) !== undefined) void list.reload(); };
  const rename = async (h: Hostel) => {
    const n = window.prompt('New name for this hostel', h.name)?.trim();
    if (n && n !== h.name && await run(() => api(`/admin/hostels/${h.id}`, { method: 'PATCH', body: { name: n } }), 'Hostel renamed') !== undefined) void list.reload();
  };
  return (
    <section className="ad-card settings-group hostels">
      <h2>Hostels</h2>
      <p className="muted small">Students choose from this list when they register. Hide a hostel instead of deleting it; old orders keep its name.</p>
      {list.data?.rows.map(h => (
        <div key={h.id} className={`hostel-row${h.active ? '' : ' off'}`}>
          <span><b>{h.name}</b><small>{plural(h.students ?? 0, 'student')}</small></span>
          <Button size="sm" tone="plain" icon="edit" onClick={() => rename(h)} aria-label={`Rename ${h.name}`} />
          <Button size="sm" onClick={() => toggle(h)}>{h.active ? 'Hide' : 'Show'}</Button>
        </div>
      ))}
      <form className="find-row" onSubmit={add}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New hostel name, e.g. Boys Hostel 3" aria-label="New hostel name" />
        <Button tone="primary" busy={busy} icon="plus" disabled={!name.trim()}>Add</Button>
      </form>
    </section>
  );
}

/* --------------------------------------------------------------- activity */

function Activity() {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const list = useLoad(() => api<{ rows: { id: number; action: string; entity: string | null; entity_id: string | null; detail: string | null; created_at: string; actor_name: string | null; actor_role: string | null }[] }>(`/admin/activity?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, limit]);
  return (
    <div className="stack">
      <div className="filters"><input className="grow" value={q} onChange={e => setQ(e.target.value)} placeholder="Search by order no., ID card, person or action" aria-label="Search activity" /></div>
      <p className="muted small">Every important action is recorded here: who did it and when. Records cannot be edited.</p>
      {!list.data ? <Loading /> : (
        <div className="ledger-wrap">
          <table className="ledger">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {list.data.rows.map(a => (
                <tr key={a.id}>
                  <td>{when(a.created_at)}</td>
                  <td>{a.actor_name ?? 'System'}<small>{a.actor_role === 'STUDENT' ? 'Student' : a.actor_role === 'ADMIN' ? 'Admin' : a.actor_role ? 'Staff' : ''}</small></td>
                  <td><b>{actionText(a.action)}</b> {a.entity_id && <span className="ord">{a.entity_id}</span>}</td>
                  <td className="detail">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.rows.length >= limit && <Button onClick={() => setLimit(limit + 100)}>Show more</Button>}
    </div>
  );
}

