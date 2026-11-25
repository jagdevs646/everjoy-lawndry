import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Announcement, api, ApiError, blobUrl, download, Hostel, Order, Service, Student, User } from './api';
import { ChangePassword } from './auth';
import { ago, kg, planPeriod, plural, rupees, shiftDay, toast, todayKey, useAction, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { ComplaintsBoard, OrderSheet, SemesterChips, StudentSheet } from './ops';
import { Avatar, Brand, Button, Empty, ErrorNote, Field, Icon, IconButton, IconName, invalidatePaymentInfo, Loading, PayPill, Segmented, Sheet, StatusPill, Switch } from './ui';

type Overview = {
  today: { orders: number; kg: number; delivered: number };
  month: { orders: number; kg: number; revenue: number; students: number };
  open: { in_progress: number; ready: number; late: number; uncollected: number; dues: number; pending_students: number; complaints: number; unsigned?: number; disputed?: number };
  totals: { students: number; staff: number };
  days: { day: string; orders: number; kg: number }[];
  hostels: { name: string; orders: number; kg: number }[];
  setup: { key: string; label: string; done: boolean }[];
  upi_configured: boolean;
  recent: { action: string; entity_id: string | null; detail: string; created_at: string; actor_name: string | null }[];
};

/**
 * On phones the admin tables turn into one card per row (admin.css). Each cell gets its column title
 * as data-label so the card can show "Hostel, room: Boys Hostel 2, B-108". Kept up to date as pages change.
 */
function useTableLabels(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const label = () => {
      for (const table of el.querySelectorAll<HTMLTableElement>('table.ledger')) {
        const heads = [...table.querySelectorAll('thead th')].map(th => (th.textContent ?? '').trim());
        for (const row of table.querySelectorAll('tbody tr')) {
          [...row.children].forEach((td, i) => { const t = heads[i] ?? ''; if (td.getAttribute('data-label') !== t) td.setAttribute('data-label', t); });
        }
      }
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [root]);
}

/** Bottom tab bar on phones: the pages used most; "More" opens the full menu. */
const PHONE_TABS = ['', 'register', 'students', 'complaints'];

const NAV: { key: string; label: string; icon: IconName }[] = [
  { key: '', label: 'Overview', icon: 'chart' },
  { key: 'register', label: 'Register', icon: 'list' },
  { key: 'students', label: 'Students', icon: 'users' },
  { key: 'complaints', label: 'Complaints', icon: 'help' },
  { key: 'notices', label: 'Notices', icon: 'megaphone' },
  { key: 'stats', label: 'Stats', icon: 'clock' },
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
  const mainRef = useRef<HTMLElement>(null);
  useTableLabels(mainRef);
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
        <main className="ad-main" key={bump} ref={mainRef}>
          {current.key === '' && <OverviewPage open={open} />}
          {current.key === 'register' && <Register open={open} />}
          {current.key === 'students' && <Students open={open} />}
          {current.key === 'complaints' && <div className="ad-narrow"><ComplaintsBoard onOpenOrder={setOrderId} /></div>}
          {current.key === 'notices' && <Notices />}
          {current.key === 'stats' && <Stats />}
          {current.key === 'reports' && <Reports />}
          {current.key === 'staff' && <Staff me={user} />}
          {current.key === 'settings' && <Settings />}
          {current.key === 'activity' && <Activity />}
        </main>
      </div>
      <nav className="ad-tabs" aria-label="Admin, main pages">
        {NAV.filter(n => PHONE_TABS.includes(n.key)).map(n => (
          <a key={n.key} href={`#/${n.key}`} className={current.key === n.key ? 'on' : ''} aria-current={current.key === n.key ? 'page' : undefined}>
            <span className="tab-icon"><Icon name={n.icon} size={22} /></span>{n.key === 'complaints' ? 'Issues' : n.label}
          </a>
        ))}
        <button type="button" className={!PHONE_TABS.includes(current.key) ? 'on' : ''} onClick={() => setDrawer(true)} aria-label="More pages">
          <span className="tab-icon"><Icon name="menu" size={22} /></span>{!PHONE_TABS.includes(current.key) ? current.label.split(' ')[0] : 'More'}
        </button>
      </nav>
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
    { n: o.open.disputed ?? 0, text: `${plural(o.open.disputed ?? 0, 'drop-off')} the student says is wrong`, to: 'register?DISPUTED', icon: 'alert', tone: 'bad' },
    { n: o.open.unsigned ?? 0, text: `${plural(o.open.unsigned ?? 0, 'drop-off')} not confirmed by the student for over 12 hours`, to: 'register?UNSIGNED', icon: 'edit' },
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
          <OrdersTrend />
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
type By = 'day' | 'week' | 'month';
const BY_TITLE: Record<By, string> = { day: 'Orders per day, last 14 days', week: 'Orders per week, last 12 weeks', month: 'Orders per month, last 12 months' };

/** The orders chart on the overview: daily, weekly or monthly. */
function OrdersTrend() {
  const [by, setBy] = useState<By>('day');
  const t = useLoad(() => api<{ rows: { key: string; orders: number; kg: number }[] }>(`/admin/trend?by=${by}`), [by], { every: 120_000 });
  return (
    <>
      <div className="row-between chart-head">
        <h2>{BY_TITLE[by]}</h2>
        <Segmented label="Show" value={by} onChange={setBy} options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
      </div>
      {t.data ? <DayBars days={t.data.rows.map(r => ({ day: r.key, orders: r.orders, kg: r.kg }))} by={by} /> : t.error ? <ErrorNote error={t.error} retry={t.reload} /> : <Loading />}
    </>
  );
}

/** Label for a chart bucket: "24 Nov", "w/c 18 Nov", "Nov 26". */
function bucketLabel(key: string, by: By, short = false) {
  if (by === 'month') { const d = new Date(`${key}-01T12:00:00`); return d.toLocaleDateString('en-IN', { month: 'short', year: short ? '2-digit' : 'numeric' }); }
  const d = new Date(`${key}T12:00:00`);
  const t = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return by === 'week' && !short ? `Week of ${t}` : t;
}

function DayBars({ days, by = 'day', unit = 'order' }: { days: Overview['days']; by?: By; unit?: 'order' | 'complaint' }) {
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
  const label = (d: string) => bucketLabel(d, by, true);
  const wk = (d: string) => (by === 'day' ? new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' }) : '');
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
              {(days.length - 1 - i) % every === 0 && <text x={pad.l + i * bw + bw / 2} y={H - 8} className="tick" textAnchor="middle">{i === days.length - 1 ? (by === 'day' ? 'Today' : by === 'week' ? 'This week' : 'This month') : label(d.day)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="base" />
      </svg>
      <p className="daybars-tip" aria-live="polite">{h ? <><b>{by === 'day' ? `${wk(h.day)} ${label(h.day)}` : bucketLabel(h.day, by)}</b>: {plural(h.orders, unit)}{unit === 'order' ? `, ${kg(h.kg)}` : ''}</> : <>Total {plural(days.reduce((a, d) => a + d.orders, 0), unit)}{unit === 'order' ? `, ${kg(days.reduce((a, d) => a + d.kg, 0))}` : ''}. Tap or hover a bar for details.</>}</p>
    </div>
  );
}

/** Register column: did the student confirm the drop-off (in) and the collection (out)? */
function AckMarks({ o }: { o: Order }) {
  const mark = (label: string, ack?: string | null, show = true) => {
    if (!show) return null;
    const tone = ack === 'SIGNATURE' || ack === 'PHONE' ? 'ok' : ack === 'DISPUTED' ? 'bad' : ack === 'OVERRIDE' ? 'warn' : 'wait';
    const title = `${label}: ${ack === 'SIGNATURE' ? 'signed at the counter' : ack === 'PHONE' ? 'confirmed on phone' : ack === 'DISPUTED' ? 'disputed' : ack === 'OVERRIDE' ? 'admin override' : 'not confirmed'}`;
    return <span className={`ack-mark ${tone}`} title={title} aria-label={title}>{label} {tone === 'ok' ? '✓' : tone === 'wait' ? '–' : '!'}</span>;
  };
  if (o.status === 'CANCELLED') return <span className="muted">–</span>;
  return <span className="ack-marks">{mark('In', o.dropoff_ack)}{mark('Out', o.pickup_ack, o.status === 'DELIVERED')}</span>;
}

export function actionText(a: string) {
  return ({
    ORDER_CREATED: 'took order', ORDER_STATUS: 'updated', ORDER_DELIVERED: 'handed over', ORDER_CANCELLED: 'cancelled', ORDER_CORRECTED: 'corrected',
    DROPOFF_SIGNED: 'drop-off confirmed by student:', DROPOFF_DISPUTED: 'student disputes drop-off of', PICKUP_SIGNED: 'collection confirmed by student:',
    PICKUP_DISPUTED: 'student disputes collection of', PICKUP_OVERRIDE: 'handed over without the student’s confirmation:',
    PAYMENT_RECORDED: 'recorded payment for', PAYMENT_WAIVED: 'waived payment for', STUDENT_SIGNUP: 'registered as', STUDENT_APPROVED: 'approved', STUDENT_REJECTED: 'rejected',
    STUDENT_EDITED: 'edited student', STUDENT_SUSPENDED: 'put on hold', STUDENT_REACTIVATED: 'reactivated', STUDENT_RESUBMITTED: 'resubmitted details for', PROFILE_UPDATED: 'updated profile',
    PASSWORD_RESET: 'reset password for', PASSWORD_CHANGED: 'changed password', SETTINGS_CHANGED: 'changed rules', HOSTEL_ADDED: 'added hostel', HOSTEL_UPDATED: 'updated hostel',
    STAFF_CREATED: 'created staff', STAFF_DEACTIVATED: 'switched off', STAFF_REACTIVATED: 'switched on', STAFF_UPDATED: 'updated staff', ANNOUNCEMENT_POSTED: 'posted notice',
    ANNOUNCEMENT_REMOVED: 'removed notice', COMPLAINT_RAISED: 'raised complaint', COMPLAINT_UPDATED: 'replied to complaint', EXPORTED: 'exported register', BACKUP_DOWNLOADED: 'downloaded backup', DEMO_SEEDED: 'loaded demo data',
    ROOM_CHANGE_REQUESTED: 'asked to change room:', ROOM_CHANGE_APPROVED: 'approved room change for', ROOM_CHANGE_REJECTED: 'turned down room change for', WALKIN_ADDED: 'served walk-in',
    PHOTO_ADDED: 'added own photo:', PHOTO_SET: 'took photo of', PHOTO_REMOVED: 'removed photo of', EMAIL_ADDED: 'added email:', ORDER_CARD: 'changed basket card of',
    STUDENT_LEFT: 'removed (left hostel):', STUDENT_RESTORED: 'put back on the list:', AUTO_STATUS: 'moved orders automatically:', PASSWORD_RESET_BY_EMAIL: 'reset password by email code:',
    SERVICE_ADDED: 'added service', SERVICE_UPDATED: 'changed service', PLAN_DATES_SET: 'set hostel plan dates', STUDENTS_IMPORTED: 'imported students', STAFF_IMPORTED: 'imported staff', STUDENT_CLAIMED: 'set up imported account',
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
          <option value="UNSIGNED">Drop-off not confirmed</option><option value="DISPUTED">Disputed by student</option>
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
              <thead><tr><th>Order</th><th>Card</th><th>Date in</th><th>Student</th><th>Room</th><th>Service</th><th className="num">Clothes</th><th className="num">Kg</th><th>Status</th><th>Payment</th><th>Handed over</th><th>Student signed</th></tr></thead>
              <tbody>
                {list.data.rows.map(o => (
                  <tr key={o.id} onClick={() => open.order(o.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open.order(o.id)}>
                    <td className="ord">{o.order_no}</td>
                    <td>{o.tag_no ? <span className="card-no">{o.tag_no}</span> : <span className="muted">–</span>}</td>
                    <td>{when(o.received_at)}</td>
                    <td><b>{o.student_name}</b><small>{o.id_card_no}</small></td>
                    <td>{o.room_no}<small>{o.hostel_name}</small></td>
                    <td>{o.service_name || 'Wash & fold'}{o.charge_note ? <small>{o.charge_note}</small> : null}</td>
                    <td className="num">{o.clothes_count}{o.returned_count != null && o.returned_count !== o.clothes_count && <small className="bad">{o.returned_count} back</small>}</td>
                    <td className="num">{Number(o.weight_kg).toFixed(1)}</td>
                    <td><StatusPill status={o.status} late={o.late} /></td>
                    <td>{o.amount > 0 ? <PayPill o={o} /> : <span className="muted">–</span>}</td>
                    <td>{o.delivered_at ? <>{when(o.delivered_at)}<small>{o.delivered_by_name}</small></> : <span className="muted">–</span>}</td>
                    <td><AckMarks o={o} /></td>
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
  const [f, setF] = useState({ q: '', status: '', hostelId: '', plan: '' });
  const [sheet, setSheet] = useState<'import' | 'plan' | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [temp, setTemp] = useState<{ name: string; pass: string } | null>(null);
  const hostels = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: '300' }).filter(([, v]) => v)).toString();
  const list = useLoad(() => api<{ rows: Student[]; total: number }>(`/ops/students?${qs}`), [qs]);
  const { busy, run } = useAction();
  useEffect(() => setSel(new Set()), [qs]);
  const today = todayKey();
  const leftView = f.status === 'LEFT';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const label: Record<string, string> = { ACTIVE: 'Approved', PENDING: 'Waiting', REJECTED: 'Rejected', SUSPENDED: 'On hold' };
  const rows = list.data?.rows ?? [];
  const allOn = rows.length > 0 && rows.every(r => sel.has(r.id));
  const toggle = (id: number, on: boolean) => { const n = new Set(sel); if (on) n.add(id); else n.delete(id); setSel(n); };

  const markLeft = async () => {
    const n = sel.size;
    if (!window.confirm(`Remove ${plural(n, 'student')} from the hostel list (left the hostel)? Their accounts are switched off; their orders and payments stay in the register. You can restore them later from “Left hostel”.`)) return;
    const r = await run(() => api<{ changed: number; blocked: string[] }>('/admin/students/leave', { body: { ids: [...sel] } }));
    if (!r) return;
    toast(`${plural(r.changed, 'student')} removed from the list${r.blocked.length ? `. Not removed (laundry at the counter or money due): ${r.blocked.join(', ')}` : ''}`, r.blocked.length ? 'bad' : 'ok');
    setSel(new Set());
    void list.reload();
  };
  const restore = async (s: Student) => {
    if (await run(() => api(`/admin/students/${s.id}/restore`, { method: 'POST' }), `${s.name} is back on the list`) !== undefined) void list.reload();
  };
  const reset = async (s: Student) => {
    if (!window.confirm(`Give ${s.name} a new temporary password? Their old password stops working and they are signed out everywhere.`)) return;
    const r = await run(() => api<{ tempPassword: string }>(`/ops/students/${s.id}/reset-password`, { method: 'POST' }));
    if (r) setTemp({ name: s.name, pass: r.tempPassword });
  };

  return (
    <div className="stack">
      <div className="filters">
        <input className="grow" value={f.q} onChange={set('q')} placeholder="Search name, ID card, mobile or room" aria-label="Search students" />
        <select value={f.status} onChange={set('status')} aria-label="Account status"><option value="">Everyone on the list</option><option value="PENDING">Waiting for approval</option><option value="ACTIVE">Approved</option><option value="REJECTED">Rejected</option><option value="SUSPENDED">On hold</option><option value="LEFT">Left hostel (removed)</option></select>
        <select value={f.hostelId} onChange={set('hostelId')} aria-label="Hostel"><option value="">All hostels</option>{hostels.data?.hostels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
        <select value={f.plan} onChange={set('plan')} aria-label="Hostel plan"><option value="">Any plan</option><option value="VALID">Plan valid</option><option value="UPCOMING">Plan not started</option><option value="EXPIRED">Plan ended</option><option value="WALKIN">Walk-ins</option></select>
        <Button icon="clock" onClick={() => setSheet('plan')}>Plan dates</Button>
        <Button tone="primary" icon="plus" onClick={() => setSheet('import')}>Add from Excel</Button>
      </div>
      {sheet === 'import' && <ImportSheet type="students" close={() => setSheet(null)} onDone={() => void list.reload()} />}
      {sheet === 'plan' && <PlanDates hostels={hostels.data?.hostels ?? []} close={() => setSheet(null)} onDone={() => { setSheet(null); void list.reload(); }} />}
      {temp && <div className="temp-pass" role="status"><span>Temporary password for {temp.name}</span><b>{temp.pass}</b><small>Tell them in person. It works for 7 days; they choose a new one at sign-in.</small></div>}
      {!list.data ? <Loading /> : !rows.length ? <Empty icon="users" title={leftView ? 'Nobody has been removed' : 'No students found'}>{leftView ? 'Students you remove because they left the hostel appear here.' : 'Students appear here after they register or are added from Excel.'}</Empty> : (
        <>
          <div className="row-between">
            <p className="muted small">{plural(list.data.total, 'student')}{leftView ? ' removed from the hostel list' : ''}</p>
            {!leftView && <label className="select-all"><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} />Select all shown</label>}
          </div>
          <div className="ledger-wrap">
            <table className="ledger fit">
              <thead><tr>{!leftView && <th className="check-col" />}<th>Name</th><th>ID card no., mobile</th><th>Hostel, room</th><th>Account</th><th>Hostel plan</th><th className="num">This month</th><th className="num">In progress</th><th /></tr></thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id} className={sel.has(s.id) ? 'sel' : ''} onClick={() => open.student(s.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open.student(s.id)}>
                    {!leftView && <td className="check-col" onClick={e => e.stopPropagation()}><input type="checkbox" checked={sel.has(s.id)} onChange={e => toggle(s.id, e.target.checked)} aria-label={`Select ${s.name}`} /></td>}
                    <td><span className="who-cell"><Avatar name={s.name} photo={s.photo} size={32} /><span><b>{s.name}</b><small>{s.left_at ? `Left ${when(s.left_at, 'date')}` : `Joined ${when(s.created_at, 'date')}`}</small></span></span></td>
                    <td><span className="ord">{s.id_card_no}</span><small>{s.mobile}</small></td>
                    <td>{s.kind === 'WALKIN' ? <span className="muted">Walk-in</span> : <>{s.hostel_name}, {s.room_no}</>}{s.pending_hostel_id ? <small className="bad">Moving to {s.pending_hostel_name} {s.pending_room_no}</small> : null}</td>
                    <td>{s.left_at ? <span className="pill acc-suspended">Left hostel</span> : <span className={`pill acc-${s.status.toLowerCase()}`}>{label[s.status]}</span>}{s.claimable ? <small>Not signed in yet</small> : null}</td>
                    <td>{s.kind === 'WALKIN' ? <span className="muted">–</span> : s.valid_until || s.valid_from
                      ? <span className={(s.valid_until && s.valid_until < today) || (s.valid_from && s.valid_from > today) ? 'bad' : ''}>{planPeriod(s.valid_from, s.valid_until)}</span>
                      : <span className="muted">No dates</span>}</td>
                    <td className="num">{s.month_orders}<small>{kg(s.month_kg)}</small></td>
                    <td className="num">{s.open_orders || <span className="muted">–</span>}</td>
                    <td className="row-actions" onClick={e => e.stopPropagation()}>
                      {s.left_at ? <Button size="sm" busy={busy} onClick={() => restore(s)}>Restore</Button>
                        : s.kind !== 'WALKIN' && <Button size="sm" icon="lock" busy={busy} onClick={() => reset(s)} title={`Reset ${s.name}'s password`} aria-label={`Reset ${s.name}'s password`}>Reset</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {sel.size > 0 && (
        <div className="bulk-bar ad-bulk" role="region" aria-label="Selected students">
          <span>{sel.size} selected</span>
          <Button tone="danger" icon="x" busy={busy} onClick={markLeft}>Remove (left hostel)</Button>
          <Button tone="plain" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ staff */

type StaffRow = { id: number; name: string; login_id: string; mobile: string | null; role: 'STAFF' | 'ADMIN'; active: number; created_at: string; month_received: number; month_delivered: number; month_collected: number; last_active: string | null };

function Staff({ me }: { me: User }) {
  const list = useLoad(() => api<{ rows: StaffRow[] }>('/admin/staff'), []);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [work, setWork] = useState<StaffRow | null>(null);
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
    <div className="stack">
      <div className="row-between"><p className="muted">People who can sign in to the counter or this office. Switch someone off when they leave; their history stays.</p><div className="btn-pair"><Button icon="download" onClick={() => setImporting(true)}>Add from Excel</Button><Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add staff</Button></div></div>
      {temp && <div className="temp-pass" role="status"><span>Temporary password for {temp.name}</span><b>{temp.pass}</b><small>They will choose a new one after signing in.</small></div>}
      {!list.data ? <Loading /> : (
        <div className="ledger-wrap">
          <table className="ledger fit">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th className="num">Taken this month</th><th className="num">Handed over</th><th className="num">Collected</th><th>Last active</th><th>Account</th><th /></tr></thead>
            <tbody>
              {list.data.rows.map(s => (
                <tr key={s.id} className={s.active ? '' : 'off'}>
                  <td><b>{s.name}</b>{s.id === me.id && <small>You</small>}</td>
                  <td className="ord">{s.login_id}</td>
                  <td>{s.role === 'ADMIN' ? 'Admin' : 'Counter staff'}{s.mobile ? <small>{s.mobile}</small> : null}</td>
                  <td className="num">{s.month_received}</td>
                  <td className="num">{s.month_delivered}</td>
                  <td className="num">{rupees(s.month_collected)}</td>
                  <td>{s.last_active ? ago(s.last_active) : <span className="muted">Never</span>}</td>
                  <td><span className={`pill ${s.active ? 'acc-active' : 'acc-suspended'}`}>{s.active ? 'Active' : 'Switched off'}</span></td>
                  <td className="row-actions">
                    <Button size="sm" icon="chart" onClick={() => setWork(s)}>Work</Button>
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
      {importing && <ImportSheet type="staff" close={() => setImporting(false)} onDone={() => void list.reload()} />}
      {work && <StaffWork id={work.id} name={work.name} close={() => setWork(null)} />}
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
  byService?: { name: string; orders: number; kg: number; clothes: number; collected: number }[];
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
              <Row k="Weight charged over the free limit" v={kg(t.totals.extra_kg)} /><Row k="Express orders" v={t.totals.express} />
            </ReportBlock>
            <ReportBlock title="Staff">
              {t.byStaff.length ? t.byStaff.map(s => <Row key={s.name} k={s.name} v={`${s.received} taken, ${s.delivered} handed over`} />) : <p className="muted">No activity.</p>}
            </ReportBlock>
          </div>
          {!!t.byService?.length && (
            <ReportBlock title="By service">
              <table className="mini-table"><thead><tr><th>Service</th><th className="num">Orders</th><th className="num">Clothes</th><th className="num">Kg</th><th className="num">Collected</th></tr></thead>
                <tbody>{t.byService.map(x => <tr key={x.name}><td>{x.name}</td><td className="num">{x.orders}</td><td className="num">{x.clothes}</td><td className="num">{x.kg}</td><td className="num">{rupees(x.collected)}</td></tr>)}</tbody></table>
            </ReportBlock>
          )}
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
  max_kg_per_order: number; max_active_orders: number; monthly_order_limit: number; monthly_kg_limit: number; allow_paid_extra: boolean;
  extra_rate_per_kg: number; express_enabled: boolean; express_fee: number; regular_turnaround_hours: number; express_turnaround_hours: number;
  pay_before_pickup: boolean; upi_id: string; upi_name: string; upi_qr_file?: string; semester_start: string; semester_end: string; counter_hours: string;
  student_email_otp: boolean; student_email_domain: string; card_required: boolean; card_series: Series[]; order_no_format: OrderNoFormat;
  dropoff_from: string; dropoff_to: string; pickup_from: string; pickup_to: string; ready_after_days: number; express_ready_after_days: number;
  auto_status: boolean; auto_washing_hours: number; sign_dropoff: boolean; sign_pickup: boolean;
};

const SETTING_TABS = [
  { key: 'orders', label: 'Orders & limits' },
  { key: 'timings', label: 'Timings' },
  { key: 'services', label: 'Prices & services' },
  { key: 'payments', label: 'Payments' },
  { key: 'students', label: 'Students & sign-in' },
  { key: 'orderno', label: 'Order numbers' },
  { key: 'cards', label: 'Basket cards' },
] as const;
type SettingTab = typeof SETTING_TABS[number]['key'];

/** "19:00" → "7:00 PM" */
const time12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

function Settings() {
  const s = useLoad(() => api<Settings>('/admin/settings'), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [tab, setTab] = useState<SettingTab>(() => { try { return (sessionStorage.getItem('ej-settings-tab') as SettingTab) || 'orders'; } catch { return 'orders'; } });
  const { busy, error, setError, submit } = useFormAction();
  useEffect(() => { if (s.data) setDraft(d => d && JSON.stringify(d) !== JSON.stringify(s.data) && d.upi_qr_file !== s.data!.upi_qr_file ? { ...d, upi_qr_file: s.data!.upi_qr_file } : s.data!); }, [s.data]);
  useEffect(() => { try { sessionStorage.setItem('ej-settings-tab', tab); } catch { /* ignore */ } }, [tab]);
  // Phones: the tab strip scrolls sideways; keep the chosen tab in view.
  useEffect(() => { document.querySelector('.tabs button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [tab, !!draft]);
  if (!draft) return <Loading />;
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value as unknown as number });
  const text = (k: keyof Settings) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.data);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Settings>('/admin/settings', { method: 'PUT', body: draft }), 'Rules saved. They apply to new orders from now.');
    if (r) s.set(r);
  };
  const example = (() => {
    const d = new Date();
    const fmt = (x: Date) => x.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const ready = new Date(d.getTime() + Number(draft.ready_after_days) * 86400_000);
    return `Given on ${fmt(d)} → ready on ${fmt(ready)} from ${time12(draft.pickup_from)}`;
  })();

  return (
    <div className="settings-page">
      <nav className="tabs" role="tablist" aria-label="Rules and pricing">
        {SETTING_TABS.map(t => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>

      <form onSubmit={save} className="settings-form">
        {tab === 'orders' && (
          <div className="settings-cards">
            <section className="ad-card settings-group">
              <h2>Each order</h2>
              <div className="field-grid">
                <Field label="Free kg per order" hint="For hostelers with a valid plan"><input type="number" step="0.5" min="0.5" value={draft.max_kg_per_order} onChange={num('max_kg_per_order')} /></Field>
                <Field label="Orders in progress per student" hint="0 = no limit"><input type="number" min="0" value={draft.max_active_orders} onChange={num('max_active_orders')} /></Field>
              </div>
            </section>
            <section className="ad-card settings-group">
              <h2>Free washing each month</h2>
              <div className="field-grid">
                <Field label="Free kg per month" hint="0 = no monthly limit"><input type="number" step="0.5" min="0" value={draft.monthly_kg_limit} onChange={num('monthly_kg_limit')} /></Field>
                <Field label="Free orders per month" hint="0 = no limit"><input type="number" min="0" value={draft.monthly_order_limit} onChange={num('monthly_order_limit')} /></Field>
              </div>
            </section>
            <section className="ad-card settings-group">
              <h2>Over the free limit</h2>
              <Switch checked={draft.allow_paid_extra} onChange={v => setDraft({ ...draft, allow_paid_extra: v })} label="Let students pay for extra kg" hint="The counter offers two choices: take clothes back, or charge for the extra kg. Off = only take clothes back." />
              {draft.allow_paid_extra && <Field label="Price per extra kg (₹)"><input type="number" min="0" value={draft.extra_rate_per_kg} onChange={num('extra_rate_per_kg')} /></Field>}
            </section>
            <section className="ad-card settings-group">
              <h2>Student confirmation (two-sided register)</h2>
              <p className="muted small">Like signing the paper register: the student confirms what they gave and what they got back, by signing with a finger on the counter screen or tapping Yes in their app. Each confirmation keeps the exact sentence, the time, who was at the counter and a tamper-proof fingerprint.</p>
              <Switch checked={draft.sign_dropoff} onChange={v => setDraft({ ...draft, sign_dropoff: v })} label="Student confirms every drop-off"
                hint="The counter shows a signature pad after each order, and the student's app asks “Did you give this?”. Disputes open a complaint." />
              <Switch checked={draft.sign_pickup} onChange={v => setDraft({ ...draft, sign_pickup: v })} label="No hand-over without the student's confirmation"
                hint="Staff can hand over only after the student signs on the counter screen or confirms on their phone. Only the admin can skip it, with a written reason." />
            </section>
            <section className="ad-card settings-group">
              <h2>Express</h2>
              <Switch checked={draft.express_enabled} onChange={v => setDraft({ ...draft, express_enabled: v })} label="Offer express service" hint="Ready sooner for a fixed fee" />
              {draft.express_enabled && (
                <div className="field-grid">
                  <Field label="Express fee per order (₹)"><input type="number" min="0" value={draft.express_fee} onChange={num('express_fee')} /></Field>
                  <Field label="Express ready after (days)" hint="0 = same day"><input type="number" min="0" max="14" value={draft.express_ready_after_days} onChange={num('express_ready_after_days')} /></Field>
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'timings' && (
          <div className="settings-cards">
            <section className="ad-card settings-group">
              <h2>Counter hours</h2>
              <p className="muted small">Shown to students on their phones. Times are campus time.</p>
              <div className="field-grid">
                <Field label="Give laundry from"><input type="time" value={draft.dropoff_from} onChange={text('dropoff_from')} /></Field>
                <Field label="Give laundry till"><input type="time" value={draft.dropoff_to} onChange={text('dropoff_to')} /></Field>
                <Field label="Collect from"><input type="time" value={draft.pickup_from} onChange={text('pickup_from')} /></Field>
                <Field label="Collect till"><input type="time" value={draft.pickup_to} onChange={text('pickup_to')} /></Field>
              </div>
              <Field label="Days the counter is open (text)" hint="Shown on the sign-in page and in student Help"><input value={draft.counter_hours} onChange={text('counter_hours')} placeholder="e.g. Mon–Sat" /></Field>
            </section>
            <section className="ad-card settings-group">
              <h2>When laundry is ready</h2>
              <Field label="Ready after (days)" hint="Counted from the day it is given in; ready at the start of collection hours.">
                <input type="number" min="0" max="14" value={draft.ready_after_days} onChange={num('ready_after_days')} />
              </Field>
              <p className="example-line"><Icon name="clock" size={16} />{example}</p>
            </section>
            <section className="ad-card settings-group">
              <h2>Automatic status</h2>
              <Switch checked={draft.auto_status} onChange={v => setDraft({ ...draft, auto_status: v })} label="Move orders along automatically"
                hint="Received → Washing after the hours below, and Washing → Ready at the ready time. Students are told when it is ready. Staff can still change a status by hand." />
              {draft.auto_status && <Field label="Show “Washing” after (hours)"><input type="number" min="1" max="168" value={draft.auto_washing_hours} onChange={num('auto_washing_hours')} /></Field>}
            </section>
          </div>
        )}

        {tab === 'payments' && (
          <div className="settings-cards">
            <section className="ad-card settings-group">
              <h2>Payments</h2>
              <Switch checked={draft.pay_before_pickup} onChange={v => setDraft({ ...draft, pay_before_pickup: v })} label="Payment needed before pickup" hint="Staff cannot hand over clothes while money is due" />
              <div className="field-grid">
                <Field label="UPI ID" hint="Used for the “Open UPI app” button, and for a QR if no image is uploaded"><input value={draft.upi_id} onChange={text('upi_id')} placeholder="e.g. everjoylaundry@okaxis" /></Field>
                <Field label="Name shown in UPI apps"><input value={draft.upi_name} onChange={text('upi_name')} /></Field>
              </div>
            </section>
            <section className="ad-card settings-group"><UpiQrSetting onChanged={() => void s.reload()} /></section>
          </div>
        )}

        {tab === 'students' && (
          <div className="settings-cards">
            <section className="ad-card settings-group">
              <h2>Hostel plan (current semester)</h2>
              <p className="muted small">Given to students approved from now on. Outside their dates they pay normal prices.</p>
              <SemesterChips from={draft.semester_start} until={draft.semester_end} onPick={(from, until) => setDraft({ ...draft, semester_start: from, semester_end: until })} />
              <div className="field-grid">
                <Field label="Semester starts"><input type="date" value={draft.semester_start} onChange={text('semester_start')} /></Field>
                <Field label="Semester ends"><input type="date" value={draft.semester_end} onChange={text('semester_end')} /></Field>
              </div>
            </section>
            <section className="ad-card settings-group">
              <h2>Student sign-in</h2>
              <MailStatus />
              <Switch checked={draft.student_email_otp} onChange={v => setDraft({ ...draft, student_email_otp: v })} label="Email code on a new phone or browser"
                hint="Students type a 6-digit code sent to their university email the first time they sign in on a device." />
              <Field label="University email domain" hint="Only addresses ending with this are accepted, e.g. university.edu.in. Recommended.">
                <input value={draft.student_email_domain} onChange={text('student_email_domain')} placeholder="university.edu.in" autoCapitalize="none" />
              </Field>
            </section>
          </div>
        )}

        {tab === 'orderno' && (
          <OrderNoStyle f={draft.order_no_format} saved={s.data!.order_no_format} onChange={order_no_format => setDraft({ ...draft, order_no_format })} />
        )}

        {tab === 'cards' && (
          <CardSeries series={draft.card_series} orderFormat={draft.order_no_format} onChange={card_series => setDraft({ ...draft, card_series })}
            required={draft.card_required} onRequired={v => setDraft({ ...draft, card_required: v })} />
        )}

        {tab !== 'services' && (
          <div className={`save-bar${dirty ? ' dirty' : ''}`}>
            {error && <ErrorNote error={error} />}
            <span>{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
            <Button type="button" tone="plain" disabled={!dirty} onClick={() => { setDraft(s.data!); setError(''); }}>Undo</Button>
            <Button tone="primary" busy={busy} disabled={!dirty}>Save rules</Button>
          </div>
        )}
      </form>

      {tab === 'services' && <Services />}
      {tab === 'students' && <Hostels />}
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

type ActivityRow = { id: number; action: string; entity: string | null; entity_id: string | null; detail: string | null; created_at: string; actor_name: string | null; actor_role: string | null };

/** Every recorded action, newest first, 100 per page. The first page refreshes itself, so new entries appear on top. */
function Activity() {
  const PAGE = 100;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [q]);
  const list = useLoad(() => api<{ rows: ActivityRow[]; total: number }>(`/admin/activity?limit=${PAGE}&offset=${page * PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, page], { every: page === 0 ? 15_000 : undefined });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const first = page * PAGE + 1;
  const last = Math.min(total, (page + 1) * PAGE);
  const pager = (
    <div className="pager">
      <span className="muted small">{total ? `${first}–${last} of ${total.toLocaleString('en-IN')}` : 'No entries'}</span>
      <Button size="sm" icon="back" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
      <span className="small">Page {page + 1} of {pages}</span>
      <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older <Icon name="next" size={16} /></Button>
    </div>
  );
  return (
    <div className="stack">
      <div className="filters">
        <input className="grow" value={q} onChange={e => setQ(e.target.value)} placeholder="Search by order no., ID card, person or action" aria-label="Search activity" />
        {page === 0 && <span className="live-dot" title="New entries appear automatically">Live</span>}
      </div>
      <p className="muted small">Every important action is recorded here, with who did it and when. Records cannot be edited.</p>
      {pager}
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : (
        <div className="ledger-wrap">
          <table className="ledger fit activity-table">
            <thead><tr><th className="num">#</th><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {list.data.rows.map((a, i) => (
                <tr key={a.id}>
                  <td className="num muted">{first + i}</td>
                  <td className="nowrap">{when(a.created_at)}<small>{ago(a.created_at)}</small></td>
                  <td>{a.actor_name ?? 'System'}<small>{a.actor_role === 'STUDENT' ? 'Student' : a.actor_role === 'ADMIN' ? 'Admin' : a.actor_role ? 'Staff' : 'Automatic'}</small></td>
                  <td><b>{actionText(a.action)}</b> {a.entity_id && <span className="ord">{a.entity_id}</span>}</td>
                  <td className="detail">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.rows.length > 20 && pager}
    </div>
  );
}

/* ------------------------------------------------------- services & prices */

function Services() {
  const list = useLoad(() => api<{ rows: Service[] }>('/admin/services'), []);
  const [edit, setEdit] = useState<Service | 'new' | null>(null);
  return (
    <section className="ad-card settings-group">
      <div className="row-between"><h2>Services and prices</h2><Button size="sm" icon="plus" onClick={() => setEdit('new')}>Add service</Button></div>
      <p className="muted small">Each service gets its own slip. “Hosteler price” is for students with a valid hostel plan; everyone else (plan ended, walk-ins) pays the normal price. Services marked “uses the free kg” are free for hostelers up to the kg limits above.</p>
      {!list.data ? <Loading /> : (
        <table className="mini-table services-table">
          <thead><tr><th>Service</th><th className="num">Hosteler price</th><th className="num">Normal price</th><th /></tr></thead>
          <tbody>
            {list.data.rows.map(x => (
              <tr key={x.id} className={x.active ? '' : 'off'}>
                <td><b>{x.name}</b><small>{x.uses_allowance ? 'Uses the free kg' : x.unit === 'KG' ? 'Per kg' : 'Per piece'}{x.active ? '' : ', hidden'}</small></td>
                <td className="num">{x.uses_allowance && !x.hosteler_rate ? 'Free' : `${rupees(x.hosteler_rate)}/${x.unit === 'KG' ? 'kg' : 'pc'}`}</td>
                <td className="num">{rupees(x.rate)}/{x.unit === 'KG' ? 'kg' : 'pc'}</td>
                <td className="row-actions"><Button size="sm" tone="plain" icon="edit" onClick={() => setEdit(x)} aria-label={`Edit ${x.name}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <ServiceForm s={edit === 'new' ? null : edit} close={() => setEdit(null)} onDone={() => { setEdit(null); void list.reload(); }} />}
    </section>
  );
}

function ServiceForm({ s, close, onDone }: { s: Service | null; close: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: s?.name ?? '', unit: s?.unit ?? 'PIECE' as 'KG' | 'PIECE', rate: String(s?.rate ?? ''), hosteler_rate: String(s?.hosteler_rate ?? ''), uses_allowance: !!s?.uses_allowance, active: s ? !!s.active : true, sort: String(s?.sort ?? 10) });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, rate: Number(f.rate || 0), hosteler_rate: Number(f.hosteler_rate || 0), sort: Number(f.sort || 0) };
    if (await submit(() => s ? api(`/admin/services/${s.id}`, { method: 'PATCH', body }) : api('/admin/services', { body }), s ? 'Service saved' : `${f.name} added`) !== undefined) onDone();
  };
  return (
    <Sheet title={s ? `Edit ${s.name}` : 'Add a service'} onClose={close} size="sm">
      <form className="stack" onSubmit={save}>
        <Field label="Name" hint="Shown on the slip, e.g. Dry cleaning, Blanket wash"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={40} /></Field>
        <Segmented label="Charged" value={f.unit} onChange={unit => setF({ ...f, unit })} options={[{ value: 'KG', label: 'Per kg' }, { value: 'PIECE', label: 'Per piece' }]} />
        <div className="field-row">
          <Field label="Hosteler price (₹)"><input type="number" min="0" step="0.5" value={f.hosteler_rate} onChange={e => setF({ ...f, hosteler_rate: e.target.value })} /></Field>
          <Field label="Normal price (₹)"><input type="number" min="0" step="0.5" value={f.rate} onChange={e => setF({ ...f, rate: e.target.value })} /></Field>
        </div>
        <Switch checked={f.uses_allowance} onChange={v => setF({ ...f, uses_allowance: v })} label="Uses the free kg" hint="Weight counts toward the per-order and monthly free kg for hostelers" />
        <Switch checked={f.active} onChange={v => setF({ ...f, active: v })} label="Offered at the counter" hint="Hide a service instead of deleting it; old slips keep its name" />
        <Field label="Order in the list" hint="Smaller numbers come first"><input type="number" min="0" max="999" value={f.sort} onChange={e => setF({ ...f, sort: e.target.value })} /></Field>
        {error && <ErrorNote error={error} />}
        <Button tone="primary" block busy={busy} disabled={f.name.trim().length < 2}>{s ? 'Save' : 'Add service'}</Button>
      </form>
    </Sheet>
  );
}

/* ----------------------------------------------------------------- UPI QR */

function UpiQrSetting({ onChanged }: { onChanged: () => void }) {
  const info = useLoad(() => api<{ upi_id: string; upi_name: string; has_upi_qr: boolean }>('/payment-info'), []);
  const [preview, setPreview] = useState('');
  const { busy, run } = useAction();
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!info.data?.has_upi_qr) { setPreview(''); return; }
    let url = '';
    let live = true;
    blobUrl('/upi-qr').then(u => { url = u; if (live) setPreview(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [info.data?.has_upi_qr, info.data]);
  const upload = async (f: File) => {
    const form = new FormData();
    form.append('qr', f);
    if (await run(() => api('/admin/upi-qr', { form }), 'UPI QR saved. Students and the counter see it now.') !== undefined) { invalidatePaymentInfo(); await info.reload(); onChanged(); }
  };
  const remove = async () => {
    if (!window.confirm('Remove the UPI QR? The counter will show a QR made from the UPI ID instead (if set).')) return;
    if (await run(() => api('/admin/upi-qr', { method: 'DELETE' }), 'UPI QR removed') !== undefined) { invalidatePaymentInfo(); await info.reload(); onChanged(); }
  };
  return (
    <div className="upi-setting">
      {preview ? <img src={preview} alt="Current UPI QR" className="qr-img" width={140} height={140} /> : <div className="qr-empty"><Icon name="qr" size={34} /></div>}
      <div className="stack">
        <b>UPI QR code</b>
        <p className="muted small">Upload the QR from your GPay / PhonePe / Paytm business app (a screenshot or photo is fine). Students see it when they choose UPI; staff mark the order paid after checking the payment.</p>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
        <div className="btn-pair">
          <Button size="sm" icon="camera" busy={busy} type="button" onClick={() => file.current?.click()}>{preview ? 'Replace QR' : 'Upload QR'}</Button>
          {preview && <Button size="sm" tone="plain" type="button" onClick={remove}>Remove</Button>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Excel import */

type ImportResult = { created: number; updated?: number; newHostels?: string[]; codes?: { idCardNo: string; name: string; code: string }[]; accounts?: { name: string; username: string; role: string; tempPassword: string }[] };

/** Claim codes as tab-separated text: pastes straight into Excel or a message. */
async function copyCodes(codes: { idCardNo: string; name: string; code: string }[]) {
  const text = ['ID card no.\tName\tClaim code', ...codes.map(c => `${c.idCardNo}\t${c.name}\t${c.code}`)].join('\n');
  try { await navigator.clipboard.writeText(text); toast('Claim codes copied'); } catch { toast('Could not copy. Use Print instead.', 'bad'); }
}

function ImportSheet({ type, close, onDone }: { type: 'students' | 'staff'; close: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const tpl = useAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setErrors([]); setError(''); setBusy(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api<ImportResult>(`/admin/import/${type}`, { form });
      setResult(r);
      onDone();
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.message);
      setErrors(ae.details?.errors ?? []);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={type === 'students' ? 'Add students from Excel' : 'Add staff from Excel'} onClose={close} size="md">
      {result ? (
        <div className="stack">
          <p className="import-done"><Icon name="check" size={20} />
            {type === 'students'
              ? `${plural(result.created, 'student')} added${result.updated ? `, ${result.updated} updated` : ''}.${result.newHostels?.length ? ` New hostels: ${result.newHostels.join(', ')}.` : ''}`
              : `${plural(result.created, 'account')} created.`}
          </p>
          {type === 'students' && <p className="muted">Each student <b>Registers</b> with the same ID card no. and mobile number from the sheet plus their <b>claim code</b>, and chooses a password. Give each student their own code privately (print this list or send it one by one). The codes are shown only now and work for 30 days. Lost a code? Upload the student again for a new one, or reset their password at the counter.</p>}
          {!!result.codes?.length && (
            <>
              <div className="ledger-wrap claim-codes">
                <table className="mini-table"><thead><tr><th>ID card no.</th><th>Name</th><th>Claim code</th></tr></thead>
                  <tbody>{result.codes.map(c => <tr key={c.idCardNo}><td className="ord">{c.idCardNo}</td><td>{c.name}</td><td className="ord">{c.code}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="btn-pair">
                <Button type="button" icon="download" onClick={() => void copyCodes(result.codes!)}>Copy list</Button>
                <Button type="button" onClick={() => window.print()}>Print</Button>
              </div>
            </>
          )}
          {result.accounts && result.accounts.length > 0 && (
            <>
              <p className="muted">Temporary passwords. Share each one privately; it is shown only now. They choose their own at first sign-in.</p>
              <table className="mini-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Temporary password</th></tr></thead>
                <tbody>{result.accounts.map(a => <tr key={a.username}><td>{a.name}</td><td className="ord">{a.username}</td><td>{a.role === 'ADMIN' ? 'Admin' : 'Staff'}</td><td className="ord">{a.tempPassword}</td></tr>)}</tbody>
              </table>
            </>
          )}
          <Button tone="primary" block onClick={close}>Done</Button>
        </div>
      ) : (
        <form className="stack" onSubmit={send}>
          <ol className="how">
            <li>Download the template. Keep the header row as it is.</li>
            <li>Fill one {type === 'students' ? 'student' : 'person'} per row{type === 'students' ? ' (Valid Until = last day of the hostel plan, e.g. 2027-05-31)' : ' (Role = STAFF or ADMIN)'}.</li>
            <li>Upload it here. If any row has a problem, nothing is added and each problem is listed.</li>
          </ol>
          <Button type="button" icon="download" busy={tpl.busy} onClick={() => tpl.run(() => download(`/admin/import/template/${type}`, `everjoy-${type}-import-template.xlsx`), 'Template downloaded')}>Download template</Button>
          <Field label="Filled-in file" hint=".xlsx from Excel or Google Sheets (File → Download → .xlsx)">
            <input type="file" accept=".xlsx,.csv" onChange={e => { setFile(e.target.files?.[0] ?? null); setErrors([]); setError(''); }} />
          </Field>
          {error && <ErrorNote error={error} />}
          {errors.length > 0 && (
            <ul className="import-errors">
              {errors.map((x, i) => <li key={i}><b>Row {x.row}</b>{x.message}</li>)}
            </ul>
          )}
          <Button tone="primary" block busy={busy} disabled={!file}>Import</Button>
        </form>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------- hostel plan dates */

function PlanDates({ close, onDone, hostels }: { close: () => void; onDone: () => void; hostels: Hostel[] }) {
  const [f, setF] = useState({ scope: 'ALL' as 'ALL' | 'HOSTEL', hostelId: '', validFrom: '', validUntil: '' });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { scope: f.scope, validFrom: f.validFrom, validUntil: f.validUntil, ...(f.scope === 'HOSTEL' ? { hostelId: Number(f.hostelId) } : {}) };
    const r = await submit(() => api<{ changed: number }>('/admin/students/validity', { body }));
    if (r) { toast(`Plan date set for ${plural(r.changed, 'student')}`); onDone(); }
  };
  return (
    <Sheet title="Set hostel plan dates" onClose={close} size="sm">
      <form className="stack" onSubmit={save}>
        <p className="muted small">For a new semester (January–June or July–December). Outside these dates students pay normal prices. To give one student different dates, open the student and edit.</p>
        <Segmented label="Who" value={f.scope} onChange={scope => setF({ ...f, scope })} options={[{ value: 'ALL', label: 'All approved students' }, { value: 'HOSTEL', label: 'One hostel' }]} />
        {f.scope === 'HOSTEL' && <Field label="Hostel"><select value={f.hostelId} onChange={e => setF({ ...f, hostelId: e.target.value })}><option value="">Choose</option>{hostels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>}
        <SemesterChips from={f.validFrom} until={f.validUntil} onPick={(validFrom, validUntil) => setF({ ...f, validFrom, validUntil })} />
        <div className="field-row">
          <Field label="From"><input type="date" value={f.validFrom} onChange={e => setF({ ...f, validFrom: e.target.value })} /></Field>
          <Field label="Till"><input type="date" value={f.validUntil} onChange={e => setF({ ...f, validUntil: e.target.value })} /></Field>
        </div>
        <p className="muted small">Leave both empty to remove the dates.</p>
        {error && <ErrorNote error={error} />}
        <Button tone="primary" block busy={busy} disabled={f.scope === 'HOSTEL' && !f.hostelId}>Save plan date</Button>
      </form>
    </Sheet>
  );
}

/* ---------------------------------------------------------- staff work */

type StaffReport = {
  person: { id: number; name: string; login_id: string; role: string };
  taken: { orders: number; clothes: number; kg: number };
  delivered: { orders: number; clothes: number; mismatches: number };
  money: { cash: number; upi: number; payments: number };
  approvals: { approved: number; rejected: number; walkins: number; resets: number };
  complaints: { handled: number; resolved: number };
  room_changes: number; last_active: string | null;
  by_day: { day: string; orders: number; kg: number }[];
};

function StaffWork({ id, name, close }: { id: number; name: string; close: () => void }) {
  const today = todayKey();
  const presets = [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'week', label: '7 days', from: shiftDay(today, -6), to: today },
    { key: 'month', label: 'This month', from: `${today.slice(0, 7)}-01`, to: today },
  ];
  const [r, setR] = useState({ from: presets[2].from, to: presets[2].to });
  const d = useLoad(() => api<StaffReport>(`/admin/staff/${id}/report?from=${r.from}&to=${r.to}`), [id, r.from, r.to]);
  const t = d.data;
  return (
    <Sheet title={`${name}: work`} onClose={close} size="md">
      <div className="stack">
        <Segmented label="Period" value={presets.find(p => p.from === r.from && p.to === r.to)?.key ?? ''} onChange={k => { const p = presets.find(x => x.key === k)!; setR({ from: p.from, to: p.to }); }} options={presets.map(p => ({ value: p.key, label: p.label }))} />
        <div className="field-row">
          <label className="mini-date">From <input type="date" value={r.from} max={r.to} onChange={e => setR({ ...r, from: e.target.value })} /></label>
          <label className="mini-date">To <input type="date" value={r.to} min={r.from} onChange={e => setR({ ...r, to: e.target.value })} /></label>
        </div>
        {!t ? (d.error ? <ErrorNote error={d.error} retry={d.reload} /> : <Loading />) : (
          <>
            <p className="muted small">Last active {t.last_active ? `${ago(t.last_active)} (${when(t.last_active)})` : 'never'}.</p>
            <div className="work-grid">
              <div><span>Orders taken</span><b>{t.taken.orders}</b><small>{t.taken.clothes} clothes, {kg(t.taken.kg)}</small></div>
              <div><span>Handed over</span><b>{t.delivered.orders}</b><small>{t.delivered.mismatches ? `${t.delivered.mismatches} with a count mismatch` : 'No count mismatches'}</small></div>
              <div><span>Money collected</span><b>{rupees(Number(t.money.cash) + Number(t.money.upi))}</b><small>Cash {rupees(t.money.cash)}, UPI {rupees(t.money.upi)}</small></div>
              <div><span>Complaints handled</span><b>{t.complaints.handled}</b><small>{t.complaints.resolved} marked resolved</small></div>
              <div><span>Students approved</span><b>{t.approvals.approved}</b><small>{t.approvals.rejected} rejected, {t.room_changes} room changes</small></div>
              <div><span>Walk-ins and resets</span><b>{t.approvals.walkins}</b><small>{plural(Number(t.approvals.resets), 'password reset')}</small></div>
            </div>
            {t.by_day.length > 0 && (
              <table className="mini-table">
                <caption>Orders taken per day</caption>
                <thead><tr><th>Day</th><th className="num">Orders</th><th className="num">Kg</th></tr></thead>
                <tbody>{t.by_day.map(x => <tr key={x.day}><td>{when(`${x.day}T12:00:00`, 'date')}</td><td className="num">{x.orders}</td><td className="num">{x.kg}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Whether this server can send email (Render: BREVO_API_KEY and MAIL_FROM). */
function MailStatus() {
  const m = useLoad(() => api<{ configured: boolean; from: string | null; local: boolean }>('/admin/mail-status'), []);
  if (!m.data) return null;
  if (m.data.configured) return <p className="mail-ok"><Icon name="check" size={16} />Email is set up. Codes are sent from {m.data.from}.</p>;
  if (m.data.local) return <p className="muted small">Test server: codes are printed in the server window instead of emailed.</p>;
  return <p className="mail-off"><Icon name="alert" size={16} />Email is not set up on the server yet, so email codes are off. See SECURITY-TODO.md → “Email codes (Brevo)”.</p>;
}

type Series = { prefix: string; suffix: string; from: number; to: number; pad: number; blocked?: CardBlock[] };

/** Only letters and digits, like the server: staff can type a card no. without its signs and spaces. */
const looseCard = (v: string) => v.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
const formatCard = (x: Series, n: number) => `${x.prefix}${String(n).padStart(x.pad, '0')}${x.suffix}`;
const cardCount = (x: Series) => (x.to - x.from + 1).toLocaleString('en-IN');

/** Ready-made patterns the admin can start from. */
const CARD_PATTERNS: Series[] = [
  { prefix: 'A', suffix: '', from: 1, to: 3000, pad: 0 },
  { prefix: 'BLUE-', suffix: '', from: 1, to: 500, pad: 3 },
  { prefix: 'H1/', suffix: '', from: 1, to: 200, pad: 0 },
  { prefix: '', suffix: '-B', from: 1, to: 999, pad: 0 },
  { prefix: '#', suffix: '', from: 100, to: 999, pad: 0 },
];

/** Text equal apart from extra digits on the inside (A and A1). Same check as the server. */
const textFits = (x: string, y: string, atEnd: boolean) => {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const rest = atEnd ? long.slice(0, long.length - short.length) : long.slice(short.length);
  return (atEnd ? long.endsWith(short) : long.startsWith(short)) && /^\d*$/.test(rest);
};
/** Could a card of this series be read as an order no.? */
const looksLikeOrders = (x: Series, f: OrderNoFormat) => {
  const d = todayKey();
  return textFits(looseCard(x.prefix), looseCard(fillDate(f.prefix.toUpperCase(), d)), false) && textFits(looseCard(x.suffix), looseCard(fillDate(f.suffix.toUpperCase(), d)), true);
};

type CardBlock = { from: number; to: number; reason: 'LOST' | 'DAMAGED' | 'REMOVED' | 'OTHER'; note: string };
const BLOCK_REASONS: { value: CardBlock['reason']; label: string }[] = [
  { value: 'LOST', label: 'Lost' }, { value: 'DAMAGED', label: 'Damaged' }, { value: 'REMOVED', label: 'Taken out of use' }, { value: 'OTHER', label: 'Other' },
];
const blockedCount = (x: Series) => (x.blocked ?? []).reduce((n, b) => n + b.to - b.from + 1, 0);

/** "12, 40-45" → [{12,12}, {40,45}], or the first problem. */
function parseNumbers(text: string, x: Series): { ranges: { from: number; to: number }[]; problem: string | null } {
  const ranges: { from: number; to: number }[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,6})(?:[-–](\d{1,6}))?$/.exec(part);
    if (!m) return { ranges, problem: `“${part}” is not a number or a range like 40-45.` };
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a > b) return { ranges, problem: `In ${part} the first number is bigger than the second.` };
    if (a < x.from || b > x.to) return { ranges, problem: `${part} is outside this series (${x.from} to ${x.to}).` };
    ranges.push({ from: a, to: b });
  }
  return { ranges, problem: ranges.length ? null : 'Type card numbers, e.g. 12, 40-45.' };
}

/** Cards of one series that must not be given at the counter: lost, damaged, taken out of use. */
function BlockedCards({ x, onChange }: { x: Series; onChange: (blocked: CardBlock[]) => void }) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState<CardBlock['reason']>('LOST');
  const [note, setNote] = useState('');
  const blocked = x.blocked ?? [];
  const parsed = parseNumbers(text, x);
  const label = (b: CardBlock) => b.from === b.to ? formatCard(x, b.from) : `${formatCard(x, b.from)} – ${formatCard(x, b.to)}`;
  const add = () => {
    if (parsed.problem) return;
    onChange([...blocked, ...parsed.ranges.map(r => ({ ...r, reason, note: note.trim().slice(0, 80) }))]);
    setText(''); setNote('');
  };
  return (
    <div className="blocked-panel">
      <p className="muted small">Staff can’t give these cards at the counter. Type the numbers only, e.g. <b>12, 40-45</b>.</p>
      {blocked.length > 0 && (
        <ul className="blocked-list">
          {blocked.map((b, i) => (
            <li key={i}>
              <b className="card-no">{label(b)}</b>
              <span>{BLOCK_REASONS.find(r => r.value === b.reason)?.label}{b.note ? `: ${b.note}` : ''}</span>
              <Button size="sm" tone="plain" icon="x" type="button" aria-label={`Allow ${label(b)} again`} onClick={() => onChange(blocked.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      )}
      <div className="blocked-add">
        <Field label="Card numbers"><input value={text} onChange={e => setText(e.target.value)} placeholder="12, 40-45" inputMode="numeric" /></Field>
        <Field label="Why">
          <select value={reason} onChange={e => setReason(e.target.value as CardBlock['reason'])}>{BLOCK_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
        </Field>
        <Field label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. torn, lost on 20 Nov" maxLength={80} /></Field>
        <Button type="button" icon="plus" disabled={!!parsed.problem} onClick={add}>Add</Button>
      </div>
      {text && parsed.problem && <p className="bad small">{parsed.problem}</p>}
    </div>
  );
}

type SeriesForm = { prefix: string; suffix: string; from: string; to: string; zeros: boolean };
const BLANK_SERIES: SeriesForm = { prefix: '', suffix: '', from: '1', to: '', zeros: false };
const toForm = (x: Series): SeriesForm => ({ prefix: x.prefix, suffix: x.suffix, from: String(x.from).padStart(x.pad, '0'), to: String(x.to).padStart(x.pad, '0'), zeros: x.pad > 0 });

/** Basket cards tab: the card series the counter uses (anything before and after the number), and a builder with a live preview. */
function CardSeries({ series, orderFormat, onChange, required, onRequired }: { series: Series[]; orderFormat: OrderNoFormat; onChange: (s: Series[]) => void; required: boolean; onRequired: (v: boolean) => void }) {
  const [f, setF] = useState<SeriesForm>(BLANK_SERIES);
  const [editing, setEditing] = useState<number | null>(null);
  const [blocking, setBlocking] = useState<number | null>(null);
  const from = Number(f.from), to = Number(f.to);
  const draft: Series = {
    prefix: f.prefix.toUpperCase().replace(/\s+/g, ' ').trimStart(),
    suffix: f.suffix.toUpperCase().replace(/\s+/g, ' ').trimEnd(),
    from, to, pad: f.zeros ? Math.max(f.from.length, f.to.length) : 0,
  };
  const problem = !f.from || !f.to ? 'Enter the first and the last number.'
    : from > to ? '“From” must not be bigger than “To”.'
    : draft.prefix.length > 12 || draft.suffix.length > 12 ? 'Up to 12 characters before and after the number.'
    : /[<>"`\\]/.test(draft.prefix + draft.suffix) ? 'These signs can’t be used: < > " ` \\'
    : looksLikeOrders(draft, orderFormat) ? `These cards look like your order numbers (${formatOrderNo(orderFormat, orderFormat.start)}). Use other letters or signs.`
    : series.some((x, i) => i !== editing && looseCard(x.prefix) === looseCard(draft.prefix) && looseCard(x.suffix) === looseCard(draft.suffix) && x.from <= to && from <= x.to)
      ? 'These cards overlap a series you already have.'
      : null;
  const sample = problem ? [] : [...new Set([from, from + 1, from + 2].filter(n => n < to))];
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  const save = () => {
    if (problem) return;
    const next = [...series];
    // An edited series keeps its not-usable cards that are still inside it.
    if (editing !== null) next[editing] = { ...draft, blocked: (series[editing].blocked ?? []).filter(b => b.from >= from && b.to <= to) }; else next.push({ ...draft, blocked: [] });
    onChange(next);
    setF(BLANK_SERIES);
    setEditing(null);
  };
  const edit = (i: number) => { setF(toForm(series[i])); setEditing(i); };
  const remove = (i: number) => { onChange(series.filter((_, j) => j !== i)); setBlocking(null); if (editing === i) { setEditing(null); setF(BLANK_SERIES); } };

  return (
    <div className="settings-cards cards-tab">
      <section className="ad-card settings-group">
        <h2>Basket cards</h2>
        <p className="muted small">The numbered card hung on each laundry basket. At the counter staff pick the series and type only the number: 256 becomes A256. A card stays on one basket until it is collected, then it can be used again. Numbers outside a series, cards marked not usable and cards on a basket waiting for pickup are refused.</p>
        <Switch checked={required} onChange={onRequired} label="Card no. needed for every order" hint="Off: staff can leave it empty." />
        <div className="series-head"><h3>Your card series</h3>{series.length > 0 && <span className="muted small">{series.length} of 20</span>}</div>
        {series.length ? (
          <ul className="series-list">
            {series.map((x, i) => (
              <li key={i} className={editing === i ? 'editing' : ''}>
                <span className="series-range"><b className="card-no">{formatCard(x, x.from)}</b><span className="muted">to</span><b className="card-no">{formatCard(x, x.to)}</b></span>
                <small className="muted">{cardCount(x)} cards{blockedCount(x) ? <>, <span className="bad">{blockedCount(x)} not usable</span></> : null}</small>
                <span className="series-actions">
                  <Button size="sm" tone="plain" type="button" aria-expanded={blocking === i} onClick={() => setBlocking(blocking === i ? null : i)}>Not usable</Button>
                  <Button size="sm" tone="plain" type="button" onClick={() => edit(i)}>Edit</Button>
                  <Button size="sm" tone="plain" icon="x" type="button" aria-label={`Remove series ${formatCard(x, x.from)}`} onClick={() => remove(i)} />
                </span>
                {blocking === i && <BlockedCards x={x} onChange={blocked => onChange(series.map((y, j) => j === i ? { ...y, blocked } : y))} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="series-empty">No series yet, so staff can type any card no. Add a series to accept only your own cards.</p>
        )}
      </section>

      <section className="ad-card settings-group series-builder">
        <h2>{editing !== null ? 'Change series' : 'Add a series'}</h2>
        <p className="muted small">Put anything before or after the number: letters, a word, signs like - / # or a hostel code.</p>
        <div className="series-fields">
          <Field label="Before the number"><input value={f.prefix} onChange={e => setF({ ...f, prefix: e.target.value.slice(0, 12) })} placeholder="e.g. A, BLUE-, H1/" autoCapitalize="characters" spellCheck={false} /></Field>
          <Field label="From"><input inputMode="numeric" value={f.from} onChange={e => { const v = digits(e.target.value); setF({ ...f, from: v, zeros: f.zeros || (v.length > 1 && v.startsWith('0')) }); }} placeholder="1" /></Field>
          <Field label="To"><input inputMode="numeric" value={f.to} onChange={e => setF({ ...f, to: digits(e.target.value) })} placeholder="3000" /></Field>
          <Field label="After the number"><input value={f.suffix} onChange={e => setF({ ...f, suffix: e.target.value.slice(0, 12) })} placeholder="e.g. -B, /H2" autoCapitalize="characters" spellCheck={false} /></Field>
        </div>
        <label className="check-line"><input type="checkbox" checked={f.zeros} onChange={e => setF({ ...f, zeros: e.target.checked })} />Same number of digits on every card (0001, 0002 … 3000)</label>

        <div className={`card-preview${problem ? ' empty' : ''}`} aria-live="polite">
          {problem ? <span>{f.to || f.prefix || f.suffix ? problem : 'Fill in the boxes to see how the cards will look.'}</span> : (
            <>
              <span className="card-preview-label">Cards will look like</span>
              <span className="card-preview-row">
                {sample.map(n => <b key={n} className="card-no">{formatCard(draft, n)}</b>)}
                {to - from > 3 && <span className="muted">…</span>}
                <b className="card-no">{formatCard(draft, to)}</b>
              </span>
              <small>{cardCount(draft)} cards. Staff can type them without signs or spaces: {looseCard(formatCard(draft, to)).toLowerCase()} finds {formatCard(draft, to)}.</small>
            </>
          )}
        </div>

        <div className="series-buttons">
          {editing !== null && <Button type="button" tone="plain" onClick={() => { setEditing(null); setF(BLANK_SERIES); }}>Cancel</Button>}
          <Button type="button" tone="primary" icon={editing !== null ? 'check' : 'plus'} disabled={!!problem || series.length >= 20 && editing === null} onClick={save}>{editing !== null ? 'Update series' : 'Add series'}</Button>
        </div>

        <div className="series-patterns">
          <span className="muted small">Start from an example:</span>
          {CARD_PATTERNS.map(x => (
            <button key={formatCard(x, x.from)} type="button" onClick={() => { setF(toForm(x)); }}>{formatCard(x, x.from)} – {formatCard(x, x.to)}</button>
          ))}
        </div>
        <p className="muted small">Then press “Save rules” below. Two series that could give the same card no. are not allowed.</p>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- order numbers */

type OrderNoFormat = { prefix: string; suffix: string; pad: number; start: number; reset: 'NEVER' | 'YEARLY' | 'FY' | 'MONTHLY' };
const ORDER_DATE_PARTS = ['{YYYY}', '{YY}', '{MM}', '{FY}'];

/** Indian financial year: 2026-11-25 → "26-27" (April to March). */
const financialYear = (day: string) => {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  const a = m >= 4 ? y : y - 1;
  return `${String(a % 100).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`;
};
const fillDate = (t: string, day: string) =>
  t.replace(/\{YYYY\}/g, day.slice(0, 4)).replace(/\{YY\}/g, day.slice(2, 4)).replace(/\{MM\}/g, day.slice(5, 7)).replace(/\{FY\}/g, financialYear(day));
const formatOrderNo = (f: OrderNoFormat, n: number, day = todayKey()) =>
  `${fillDate(f.prefix.toUpperCase(), day)}${String(n).padStart(f.pad, '0')}${fillDate(f.suffix.toUpperCase(), day)}`;

/** Same rules as the server, so the admin sees the problem while typing. */
function orderNoProblem(f: OrderNoFormat) {
  const all = (f.prefix + f.suffix).toUpperCase();
  if (!f.start || f.start < 1) return 'Enter the first number (1 or more).';
  if (f.prefix.length > 20 || f.suffix.length > 20) return 'Up to 20 characters before and after the number.';
  if (/[<>"`\\:]/.test(all)) return 'These signs can’t be used: < > " ` \\ :';
  const unknown = (all.match(/\{[^}]*\}?/g) ?? []).filter(t => !ORDER_DATE_PARTS.includes(t));
  if (unknown.length) return `${unknown[0]} is not a date part. Use the date buttons below.`;
  const has = (...t: string[]) => t.some(p => all.includes(p));
  if (f.reset === 'YEARLY' && !has('{YYYY}', '{YY}')) return 'Numbers start again every year, so add the year to the order no. Otherwise numbers would repeat.';
  if (f.reset === 'FY' && !has('{FY}')) return 'Numbers start again every financial year, so add the financial year to the order no. Otherwise numbers would repeat.';
  if (f.reset === 'MONTHLY' && !(has('{MM}') && has('{YYYY}', '{YY}', '{FY}'))) return 'Numbers start again every month, so add the month and the year to the order no. Otherwise numbers would repeat.';
  return null;
}

const ORDER_PATTERNS: { label: string; f: OrderNoFormat }[] = [
  { label: 'EJ-1001', f: { prefix: 'EJ-', suffix: '', pad: 0, start: 1001, reset: 'NEVER' } },
  { label: 'INV/26-27/0001', f: { prefix: 'INV/{FY}/', suffix: '', pad: 4, start: 1, reset: 'FY' } },
  { label: 'LDY2611-001', f: { prefix: 'LDY{YY}{MM}-', suffix: '', pad: 3, start: 1, reset: 'MONTHLY' } },
  { label: '2026/00001/EVJ', f: { prefix: '{YYYY}/', suffix: '/EVJ', pad: 5, start: 1, reset: 'YEARLY' } },
  { label: 'EVERJOY#5001', f: { prefix: 'EVERJOY#', suffix: '', pad: 0, start: 5001, reset: 'NEVER' } },
];
const DATE_BUTTONS = [
  { part: '{YYYY}', label: 'Year', example: (d: string) => d.slice(0, 4) },
  { part: '{YY}', label: 'Year (short)', example: (d: string) => d.slice(2, 4) },
  { part: '{MM}', label: 'Month', example: (d: string) => d.slice(5, 7) },
  { part: '{FY}', label: 'Financial year', example: financialYear },
];
const RESET_LABEL: Record<OrderNoFormat['reset'], string> = {
  NEVER: 'Never: keep counting up',
  FY: 'Every financial year (1 April)',
  YEARLY: 'Every year (1 January)',
  MONTHLY: 'Every month',
};

/** Order numbers tab: the admin's own style of order no. (like an invoice no.), with a live preview. */
function OrderNoStyle({ f, saved, onChange }: { f: OrderNoFormat; saved: OrderNoFormat; onChange: (f: OrderNoFormat) => void }) {
  const info = useLoad(() => api<{ last: { order_no: string; received_at: string } | null; next: string; next_n: number; total: number }>('/admin/order-no'), [JSON.stringify(saved)]);
  const [focus, setFocus] = useState<'prefix' | 'suffix'>('prefix');
  const today = todayKey();
  const problem = orderNoProblem(f);
  const set = (patch: Partial<OrderNoFormat>) => onChange({ ...f, ...patch });
  const addPart = (part: string) => set(focus === 'prefix' ? { prefix: f.prefix + part } : { suffix: f.suffix + part });
  const changed = JSON.stringify(f) !== JSON.stringify(saved);
  // Same style as saved: numbering carries on from the counter. A new style starts at "Start at".
  const sameCounter = f.prefix.toUpperCase() === saved.prefix && f.suffix.toUpperCase() === saved.suffix && f.reset === saved.reset;
  const base = sameCounter && info.data ? Math.max(f.start, info.data.next_n) : f.start;

  return (
    <div className="settings-cards cards-tab">
      <section className="ad-card settings-group">
        <h2>Order numbers</h2>
        <p className="muted small">Every order gets its own no., like an invoice no. It is printed on the student’s slip, in the register and in reports.</p>
        <dl className="order-no-facts">
          <div><dt>Last order no. given</dt><dd>{info.data?.last ? <><b className="order-no-chip">{info.data.last.order_no}</b><small className="muted">{when(info.data.last.received_at, 'date')}</small></> : <span className="muted">No orders yet</span>}</dd></div>
          <div><dt>Next order no.</dt><dd>{info.data ? <b className="order-no-chip next">{info.data.next}</b> : <span className="muted">…</span>}{changed && <small className="muted">Changes after you save</small>}</dd></div>
          <div><dt>Orders so far</dt><dd>{info.data ? info.data.total.toLocaleString('en-IN') : '…'}</dd></div>
        </dl>
        <ul className="rule-list">
          <li><Icon name="check" size={16} />An order no. is never given twice. If your style would repeat a no. that was used before, that no. is skipped.</li>
          <li><Icon name="check" size={16} />A new style applies to new orders only. Old orders keep their numbers.</li>
          <li><Icon name="check" size={16} />Staff can find an order by typing it without signs or spaces, e.g. {codeLike(formatOrderNo(f, f.start || 1, today))}.</li>
        </ul>
      </section>

      <section className="ad-card settings-group series-builder">
        <h2>Order no. style</h2>
        <p className="muted small">Put anything before or after the number: letters, a word, signs like - / # and the date.</p>
        <div className="series-fields order-fields">
          <Field label="Before the number"><input value={f.prefix} onFocus={() => setFocus('prefix')} onChange={e => set({ prefix: e.target.value.slice(0, 20) })} placeholder="e.g. EJ-, INV/" autoCapitalize="characters" spellCheck={false} /></Field>
          <Field label="Start at"><input inputMode="numeric" value={f.start || ''} onChange={e => set({ start: Number(e.target.value.replace(/\D/g, '').slice(0, 8)) })} placeholder="1001" /></Field>
          <Field label="Digits">
            <select value={f.pad} onChange={e => set({ pad: Number(e.target.value) })}>
              <option value={0}>1, 2, 3 …</option>
              {[3, 4, 5, 6].map(d => <option key={d} value={d}>{'1'.padStart(d, '0')}</option>)}
            </select>
          </Field>
          <Field label="After the number"><input value={f.suffix} onFocus={() => setFocus('suffix')} onChange={e => set({ suffix: e.target.value.slice(0, 20) })} placeholder="e.g. /H1" autoCapitalize="characters" spellCheck={false} /></Field>
        </div>
        <div className="date-parts">
          <span className="muted small">Add the date {focus === 'prefix' ? 'before' : 'after'} the number:</span>
          {DATE_BUTTONS.map(b => <button key={b.part} type="button" onClick={() => addPart(b.part)}>{b.label} <b>{b.example(today)}</b></button>)}
        </div>
        <Field label="Start numbering again">
          <select value={f.reset} onChange={e => set({ reset: e.target.value as OrderNoFormat['reset'] })}>
            {(Object.keys(RESET_LABEL) as OrderNoFormat['reset'][]).map(k => <option key={k} value={k}>{RESET_LABEL[k]}</option>)}
          </select>
        </Field>

        <div className={`card-preview${problem ? ' empty' : ''}`} aria-live="polite">
          {problem ? <span>{problem}</span> : (
            <>
              <span className="card-preview-label">New orders will look like</span>
              <span className="card-preview-row">
                {[0, 1, 2].map(i => <b key={i} className="order-no-chip">{formatOrderNo(f, base + i, today)}</b>)}
                <span className="muted">…</span>
              </span>
              {sameCounter && base > f.start && <small>Numbering carries on after the last order in this style ({base - 1}).</small>}
              {f.reset !== 'NEVER' && <small>On {f.reset === 'MONTHLY' ? 'the 1st of next month' : f.reset === 'FY' ? '1 April' : '1 January'} the date part changes and numbering starts again at {f.start}.</small>}
            </>
          )}
        </div>

        <div className="series-patterns">
          <span className="muted small">Start from an example:</span>
          {ORDER_PATTERNS.map(x => <button key={x.label} type="button" onClick={() => onChange(x.f)}>{formatOrderNo(x.f, x.f.start, today)}</button>)}
        </div>
        <p className="muted small">Then press “Save rules” below.</p>
      </section>
    </div>
  );
}
const codeLike = (no: string) => no.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/* ------------------------------------------------------------------ stats */

type TAT = { orders: number; ready: number; collected: number; to_ready_h: number | null; wait_h: number | null; total_h: number | null; on_time: number | null };
type StatsData = {
  from: string; to: string; by: By;
  overall: TAT;
  byService: (TAT & { name: string })[];
  byStaff: { name: string; taken: number; marked_ready: number; to_ready_h: number | null; handed_over: number; wait_h: number | null }[];
  complaints: {
    total: number; open: number; per_100_orders: number | null; students: number; share_of_customers: number | null; resolve_h: number | null;
    series: { key: string; count: number }[]; byCategory: { name: string; count: number }[];
    repeat: { name: string; id_card_no: string; complaints: number }[];
  };
};

/** 30 h → "30 h", 54 h → "2.3 days" */
const fmtH = (h: number | null) => (h === null ? '–' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`);

/** How fast the laundry works (per service and per person) and how often students complain. */
function Stats() {
  const today = todayKey();
  const presets = [
    { key: '7', label: '7 days', from: shiftDay(today, -6), to: today, by: 'day' as By },
    { key: '14', label: '14 days', from: shiftDay(today, -13), to: today, by: 'day' as By },
    { key: '30', label: '30 days', from: shiftDay(today, -29), to: today, by: 'day' as By },
    { key: 'week12', label: '12 weeks', from: shiftDay(today, -83), to: today, by: 'week' as By },
    { key: 'year', label: '12 months', from: shiftDay(today, -364), to: today, by: 'month' as By },
  ];
  const [p, setP] = useState(presets[2]);
  const d = useLoad(() => api<StatsData>(`/admin/stats?from=${p.from}&to=${p.to}&by=${p.by}`), [p.key]);
  const t = d.data;
  const maxReady = Math.max(1, ...(t?.byService.map(x => x.to_ready_h ?? 0) ?? [1]));
  return (
    <div className="stack">
      <div className="filters">
        <Segmented label="Period" value={p.key} onChange={k => setP(presets.find(x => x.key === k)!)} options={presets.map(x => ({ value: x.key, label: x.label }))} />
        <span className="muted small">{when(`${p.from}T12:00:00`, 'date')} – {when(`${p.to}T12:00:00`, 'date')}</span>
      </div>
      {!t ? (d.error ? <ErrorNote error={d.error} retry={d.reload} /> : <Loading />) : (
        <>
          <div className="kpis">
            <Kpi label="Drop-off → ready" value={fmtH(t.overall.to_ready_h)} note="average turnaround" />
            <Kpi label="Ready → collected" value={fmtH(t.overall.wait_h)} note="how long baskets wait" />
            <Kpi label="Drop-off → collected" value={fmtH(t.overall.total_h)} note={`${t.overall.collected} of ${t.overall.orders} orders collected`} />
            <Kpi label="Ready on time" value={t.overall.on_time === null ? '–' : `${t.overall.on_time}%`} note="by the promised time" warn={t.overall.on_time !== null && t.overall.on_time < 80} />
            <Kpi label="Complaints" value={String(t.complaints.total)} note={t.complaints.per_100_orders === null ? 'no orders' : `${t.complaints.per_100_orders} per 100 orders`} warn={(t.complaints.per_100_orders ?? 0) > 5} />
          </div>

          <section className="ad-card">
            <h2>Turnaround by service</h2>
            {!t.byService.length ? <p className="muted">No orders in this period.</p> : (
              <div className="ledger-wrap flat">
                <table className="ledger fit">
                  <thead><tr><th>Service</th><th className="num">Orders</th><th>Drop-off → ready</th><th className="num">Ready → collected</th><th className="num">Total</th><th className="num">On time</th></tr></thead>
                  <tbody>{t.byService.map(x => (
                    <tr key={x.name}>
                      <td><b>{x.name}</b><small>{x.ready} ready, {x.collected} collected</small></td>
                      <td className="num">{x.orders}</td>
                      <td><span className="meter-row"><span className="hbar" style={{ width: `${((x.to_ready_h ?? 0) / maxReady) * 100}%` }} /><b>{fmtH(x.to_ready_h)}</b></span></td>
                      <td className="num">{fmtH(x.wait_h)}</td>
                      <td className="num">{fmtH(x.total_h)}</td>
                      <td className="num">{x.on_time === null ? '–' : <span className={x.on_time < 80 ? 'bad' : ''}>{x.on_time}%</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <section className="ad-card">
            <h2>Staff</h2>
            <p className="muted small">Who took orders, who marked them ready (and how long after drop-off), and who handed them over. “Automatic” is the automatic status step.</p>
            {!t.byStaff.length ? <p className="muted">No activity in this period.</p> : (
              <div className="ledger-wrap flat">
                <table className="ledger fit">
                  <thead><tr><th>Person</th><th className="num">Orders taken</th><th className="num">Marked ready</th><th className="num">Avg time to ready</th><th className="num">Handed over</th><th className="num">Avg wait before pickup</th></tr></thead>
                  <tbody>{t.byStaff.map(x => (
                    <tr key={x.name}><td><b>{x.name}</b></td><td className="num">{x.taken}</td><td className="num">{x.marked_ready}</td><td className="num">{fmtH(x.to_ready_h)}</td><td className="num">{x.handed_over}</td><td className="num">{fmtH(x.wait_h)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <div className="ad-grid">
            <section className="ad-card chart-card">
              <h2>Complaints per {p.by === 'day' ? 'day' : p.by === 'week' ? 'week' : 'month'}</h2>
              <DayBars days={t.complaints.series.map(x => ({ day: x.key, orders: x.count, kg: 0 }))} by={p.by} unit="complaint" />
            </section>
            <section className="ad-card report-block">
              <h2>How often students complain</h2>
              <Row k="Complaints" v={t.complaints.total} />
              <Row k="Still open" v={t.complaints.open} warn={t.complaints.open > 0} />
              <Row k="Per 100 orders" v={t.complaints.per_100_orders ?? '–'} />
              <Row k="Students who complained" v={`${t.complaints.students}${t.complaints.share_of_customers !== null ? ` (${t.complaints.share_of_customers}% of customers)` : ''}`} />
              <Row k="Average time to resolve" v={fmtH(t.complaints.resolve_h)} />
            </section>
          </div>
          <div className="ad-grid">
            <ReportBlock title="Complaints by type">
              {t.complaints.byCategory.length ? <table className="mini-table"><tbody>{t.complaints.byCategory.map(c => <tr key={c.name}><td>{c.name}</td><td className="num">{c.count}</td></tr>)}</tbody></table> : <p className="muted">No complaints.</p>}
            </ReportBlock>
            <ReportBlock title="Complain often (2 or more)">
              {t.complaints.repeat.length ? <table className="mini-table"><tbody>{t.complaints.repeat.map(c => <tr key={c.id_card_no}><td>{c.name}<small>{c.id_card_no}</small></td><td className="num">{c.complaints}</td></tr>)}</tbody></table> : <p className="muted">Nobody complained more than once.</p>}
            </ReportBlock>
          </div>
        </>
      )}
    </div>
  );
}

const Kpi = ({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) => (
  <div className={`kpi${warn ? ' warn' : ''}`}><span>{label}</span><b>{value}</b>{note && <small>{note}</small>}</div>
);
