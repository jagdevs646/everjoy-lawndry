import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Announcement, api, Complaint, Hostel, Notice, OtpStart, Order, Pending, Plan, Service, Student, Usage, User } from './api';
import { ackLabel, isConfirmed, SignatureImage, useRotatingCode } from './signoff';
import { ChangePassword, OtpStep } from './auth';
import { isApp, serverAddress } from './platform';
import { ago, back, firstName, go, kg, noteServerTime, plural, rupees, shrinkPhoto, toast, useAction, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { Avatar, Brand, Button, Empty, ErrorNote, Field, Icon, IconButton, IconName, Loading, PayPill, Photo, Progress, QrImage, Sheet, SlipQr, StatusPill, UpiQr, useNoScreenshots } from './ui';

type Home = {
  profile: Student; plan?: Plan; services?: Service[]; usage: Usage; open: Order[]; due: number; unread: number; open_complaints: number; announcements: Announcement[];
  pending?: Pending;
  info: { max_kg_per_order: number; counter_hours: string; upi_id: string; upi_name: string; pay_before_pickup: boolean; express_enabled: boolean; express_fee: number;
    monthly_kg_limit: number; monthly_order_limit: number; allow_paid_extra?: boolean; extra_rate_per_kg: number; has_upi_qr?: boolean;
    dropoff_from?: string; dropoff_to?: string; pickup_from?: string; pickup_to?: string };
};
/** A copy saved by an older version of the app may not have the plan yet. */
const planOf = (h: Home): Plan => h.plan ?? { hosteler: true, label: 'Hostel plan' };

/** "19:00" → "7:00 PM" */
const t12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

const cacheKey = (id: number) => `ej-home-${id}`;
function readCache(id: number): Home | undefined { try { return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null') ?? undefined; } catch { return undefined; } }
function writeCache(id: number, h: Home) { try { localStorage.setItem(cacheKey(id), JSON.stringify(h)); } catch { /* storage full or blocked */ } }

export function StudentApp({ user, onSignOut, onUser }: { user: User; onSignOut: () => void; onUser: (u: User) => void }) {
  const parts = useRoute();
  // Home is polled so "Ready for pickup" shows up without a refresh. The last copy is kept
  // on the phone, so the slip QR still opens with weak network at the counter.
  const home = useLoad(async () => { const h = await api<Home & { server_time?: number }>('/me/home'); noteServerTime(h.server_time); writeCache(user.id, h); return h; }, [user.id], { every: 30_000 });
  const data = home.data ?? readCache(user.id);
  const offline = !home.data && !!data && !!home.error;

  const signOut = () => { try { localStorage.removeItem(cacheKey(user.id)); } catch { /* ignore */ } onSignOut(); };

  // Codes the counter is waiting for. Checked every few seconds while the app is open, so the pop-up
  // appears as soon as staff take the order or press "Hand over".
  const [pending, setPendingRaw] = useState<Pending | undefined>(undefined);
  const pendingJson = useRef('');
  const keyOf = (r: Pending['requests'][number]) => `${r.order_id}:${r.kind}:${r.created_at}`;
  // Only re-render when the set of requests changed (polls usually return the same thing).
  const setPending = useCallback((p: Pending) => { const j = JSON.stringify((p.requests ?? []).map(keyOf)); if (j !== pendingJson.current) { pendingJson.current = j; setPendingRaw(p); } }, []);
  const asked = useRef(0);   // bumped on every answer: a poll that started before it is stale
  useEffect(() => { if (home.data?.pending?.requests) setPending(home.data.pending); }, [home.data, setPending]);
  useEffect(() => {
    if (!data) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const n = asked.current;
      api<Pending>('/me/pending').then(p => { if (n === asked.current) setPending(p); }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [!!data, setPending]);   // eslint-disable-line react-hooks/exhaustive-deps
  const reqs = pending?.requests ?? [];
  // A request that went away was confirmed by staff (or expired): refresh the slips.
  const seenKeys = useRef<string[]>([]);
  useEffect(() => {
    const now = reqs.map(keyOf);
    const gone = seenKeys.current.filter(k => !now.includes(k));
    seenKeys.current = now;
    if (gone.length) { toast('Confirmed at the counter'); void home.reload(); }
  }, [pending]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [dismissed, setDismissed] = useState<string[]>([]);
  const openReq = reqs.find(r => !dismissed.includes(keyOf(r)));
  const openKey = openReq ? keyOf(openReq) : '';
  const closeCode = useCallback(() => setDismissed(d => [...d, openKey]), [openKey]);
  const answered = (p?: Pending) => { asked.current++; if (p) setPending(p); void home.reload(); };
  const tab = ['orders', 'help', 'me'].includes(parts[0]) ? parts[0] : 'home';
  const base = tab === 'home' ? '' : tab;
  const [overlay, arg] = tab === 'home' ? parts : parts.slice(1);
  const closeOverlay = () => back(base);
  useScrollTop(tab);

  return (
    <div className="st-shell">
      <header className="st-top">
        <Brand />
        <IconButton icon="bell" label="Notifications" badge={data?.unread} onClick={() => go(base ? `${base}/inbox` : 'inbox')} />
      </header>
      {offline && <div className="offline-bar">{isApp ? `Can’t reach ${serverAddress().replace(/^https?:\/\//, '')}.` : 'You are offline.'} Showing your saved slips.</div>}
      <main className="st-main">
        {!data ? (home.error ? <div className="stack"><ErrorNote error={home.error} retry={home.reload} /><Button tone="plain" icon="logout" onClick={signOut}>Sign out</Button></div> : <Loading />) :
          tab === 'orders' ? <MyOrders /> :
          tab === 'help' ? <Help home={data} /> :
          tab === 'me' ? <Profile home={data} onSaved={home.reload} onSignOut={signOut} user={user} onUser={onUser} /> :
          <HomePage home={data} pending={pending ?? data.pending} onOpenCodes={() => setDismissed([])} />}
      </main>
      <nav className="st-tabs" aria-label="Main">
        <Tab to="" icon="home" label="Home" on={tab === 'home'} />
        <Tab to="orders" icon="list" label="My orders" on={tab === 'orders'} />
        <Tab to="help" icon="help" label="Help" on={tab === 'help'} badge={data?.open_complaints} />
        <Tab to="me" icon="user" label="Profile" on={tab === 'me'} />
        {/* Computer only: who is signed in, under the menu */}
        {data && (
          <a href="#/me" className="st-side-user">
            <Avatar name={data.profile.name} photo={data.profile.photo} size={40} />
            <span><b>{data.profile.name}</b><small>{data.profile.id_card_no}</small></span>
          </a>
        )}
      </nav>
      {overlay === 'slip' && arg && <Slip id={Number(arg)} cached={data?.open} close={closeOverlay} />}
      {overlay === 'inbox' && <Inbox close={() => { closeOverlay(); void home.reload(); }} />}
      {overlay === 'myqr' && data && <MyQr profile={data.profile} close={closeOverlay} />}
      {openReq && <CodePopup key={openKey} r={openReq} onClose={closeCode} onDone={answered} />}
    </div>
  );
}

function Tab({ to, icon, label, on, badge }: { to: string; icon: IconName; label: string; on: boolean; badge?: number }) {
  return (
    <a href={`#/${to}`} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
      <span className="tab-icon"><Icon name={icon} size={22} />{!!badge && <i className="dot-badge">{badge}</i>}</span>
      {label}
    </a>
  );
}

/* ------------------------------------------------------------------- home */

function HomePage({ home, pending, onOpenCodes }: { home: Home; pending?: Pending; onOpenCodes: () => void }) {
  const { profile: p, open, usage, info } = home;
  const ready = open.filter(o => o.status === 'READY');
  return (
    <div className="st-home">
      <div className="home-main">
      <section className="hello">
        <button className="hello-photo" onClick={() => go('me')} aria-label="Profile"><Avatar name={p.name} photo={p.photo} size={56} /></button>
        <div>
          <h1>Hi {firstName(p.name)}</h1>
          <p>{p.hostel_name}, room {p.room_no}</p>
          {p.status === 'ACTIVE' && <p className={`plan-chip${planOf(home).hosteler ? '' : ' ended'}`}>{planOf(home).label}</p>}
        </div>
      </section>
      {p.pending_hostel_id && <p className="ready-banner pending"><Icon name="clock" size={18} />Moving to {p.pending_hostel_name}, room {p.pending_room_no}: waiting for the counter to check.</p>}

      {p.status !== 'ACTIVE' ? <AccountState p={p} /> : (
        <>
          {pending?.requests?.map(r => (
            <button key={`${r.order_id}:${r.kind}`} type="button" className="handover-waiting" onClick={onOpenCodes}>
              <Icon name="lock" size={22} />
              <span><b>The counter is waiting for your code</b><small>{r.kind === 'DROPOFF' ? 'Confirm your drop-off' : 'Confirm you received'} {r.tag_no ?? r.order_no}</small></span>
              <Icon name="next" size={18} />
            </button>
          ))}
          {ready.length > 0 && <p className="ready-banner"><Icon name="check" size={18} />{ready.length === 1 ? `${ready[0].order_no} is ready. Collect it with your slip.` : `${ready.length} orders are ready to collect.`}</p>}
          <section aria-label="Laundry at the counter" className="tag-stack">
            {open.length ? open.map(o => <OrderTag key={o.id} o={o} />) : (
              <Empty icon="shirt" title="Nothing at the counter">
                {planOf(home).hosteler ? `Drop off up to ${info.max_kg_per_order} kg free at the laundry counter.` : 'Drop off at the laundry counter. Normal prices apply.'} Your digital slip appears here straight away.
              </Empty>
            )}
          </section>
          <button className="id-qr-btn" onClick={() => go('myqr')}>
            <Icon name="qr" size={22} />
            <span><b>Show my ID at the counter</b><small>Staff scan this to find you instantly</small></span>
            <Icon name="next" size={18} />
          </button>
        </>
      )}
      </div>

      <div className="home-side">
      {info.dropoff_from && <p className="timings-line"><Icon name="clock" size={16} />Give laundry {t12(info.dropoff_from)}–{t12(info.dropoff_to!)} · Collect {t12(info.pickup_from!)}–{t12(info.pickup_to!)}</p>}
      {home.due > 0 && <PayDue amount={home.due} info={info} orders={open.filter(o => o.payment_status === 'DUE')} />}

      {p.status === 'ACTIVE' && planOf(home).hosteler && <MonthUsage usage={usage} info={info} />}

      {home.announcements.length > 0 && (
        <section className="notices" aria-label="Notices from the laundry">
          <h2>From the laundry</h2>
          {home.announcements.map(a => (
            <article key={a.id} className="notice">
              <Icon name="megaphone" size={18} />
              <div><b>{a.title}</b><p>{a.body}</p><small>{ago(a.created_at)}{a.hostel_name ? `, for ${a.hostel_name}` : ''}</small></div>
            </article>
          ))}
        </section>
      )}
      </div>
    </div>
  );
}

function AccountState({ p }: { p: Student }) {
  if (p.status === 'PENDING') return (
    <section className="state-card pending">
      <Icon name="card" size={26} />
      <h2>One step left: show your ID card</h2>
      <p>{p.photo ? '' : 'Add a clear photo of your face first. '}Take your university ID card to the laundry counter. Staff will check your details on the university portal and approve you. It takes a minute.</p>
      {!p.photo && <Button icon="camera" onClick={() => go('me')}>Add my photo</Button>}
      <Button tone="primary" icon="qr" onClick={() => go('myqr')}>Show my ID QR</Button>
    </section>
  );
  if (p.status === 'REJECTED') return (
    <section className="state-card rejected">
      <Icon name="alert" size={26} />
      <h2>Your details need a fix</h2>
      <p>Staff said: “{p.review_note}”. Correct your details and send them again.</p>
      <Button tone="primary" icon="edit" onClick={() => go('me')}>Fix my details</Button>
    </section>
  );
  return (
    <section className="state-card rejected">
      <Icon name="lock" size={26} />
      <h2>Your laundry account is on hold</h2>
      <p>{p.review_note ? `Reason: ${p.review_note}. ` : ''}Please speak to the laundry office.</p>
    </section>
  );
}

function OrderTag({ o }: { o: Order }) {
  const timeLine = o.status === 'READY' ? `Ready since ${when(o.ready_at, 'short')}` : `Expected ${when(o.expected_at, 'short')}`;
  return (
    <button className={`order-tag s-${o.status.toLowerCase()}`} onClick={() => go(`slip/${o.id}`)}>
      <span className="order-tag-hole" aria-hidden="true" />
      <span className="order-tag-top">
        <span className="order-tag-no">{o.tag_no ? <>Card {o.tag_no}</> : o.order_no}</span>
        <StatusPill status={o.status} />
      </span>
      <span className="order-tag-meta">{o.service_name ? `${o.service_name}: ` : ''}{plural(o.clothes_count, 'piece')}{Number(o.weight_kg) > 0 ? `, ${kg(o.weight_kg)}` : ''}{o.service === 'EXPRESS' ? ', express' : ''}</span>
      <Progress status={o.status} />
      <span className="order-tag-foot">
        <span>{timeLine}</span>
        <PayPill o={o} />
        <span className="order-tag-open">Open slip <Icon name="next" size={16} /></span>
      </span>
    </button>
  );
}

function PayDue({ amount, info, orders }: { amount: number; info: Home['info']; orders: Order[] }) {
  const [qr, setQr] = useState(false);
  const note = orders.map(o => o.order_no).join(' ');
  const canUpi = !!info.upi_id || !!info.has_upi_qr;
  return (
    <section className="pay-card">
      <div>
        <b>{rupees(amount)} to pay</b>
        <p>{orders.map(o => `${o.order_no}: ${rupees(o.amount)}${o.charge_note ? ` (${o.charge_note})` : o.service_name ? ` (${o.service_name})` : ''}`).join('. ')}.
          {info.pay_before_pickup ? ' Pay before you collect.' : ''}</p>
      </div>
      {canUpi && (qr
        ? <UpiQr amount={amount} note={note} size={200} showButton />
        : <Button tone="primary" icon="qr" onClick={() => setQr(true)}>Pay by UPI</Button>)}
      <small>{canUpi ? 'After paying, show the payment screen at the counter. Staff mark it paid. ' : ''}Cash is also fine at the counter.</small>
    </section>
  );
}

function MonthUsage({ usage, info }: { usage: Usage; info: Home['info'] }) {
  const pct = usage.kg_limit ? Math.min(100, (usage.kg / usage.kg_limit) * 100) : 0;
  return (
    <section className="usage" aria-label="This month">
      <h2>This month</h2>
      <p className="usage-line"><b>{plural(usage.orders, 'order')}</b>, {kg(usage.kg)} washed{usage.order_limit ? ` (limit ${usage.order_limit} orders)` : ''}</p>
      {usage.kg_limit > 0 && <>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={usage.kg_limit} aria-valuenow={usage.kg} aria-label="Monthly kg used"><span style={{ width: `${pct}%` }} className={pct >= 90 ? 'hot' : ''} /></div>
        <p className="usage-note">{usage.kg_left ? `${kg(usage.kg_left)} left of your ${kg(usage.kg_limit)} monthly limit.` : `Monthly limit of ${kg(usage.kg_limit)} reached.`}
          {info.allow_paid_extra !== false && info.extra_rate_per_kg ? ` Extra weight costs ${rupees(info.extra_rate_per_kg)} per kg.` : usage.kg_left === 0 ? ' New orders open next month.' : ''}</p>
      </>}
      <p className="usage-note">Each order is free up to {kg(info.max_kg_per_order)}.{info.allow_paid_extra !== false && info.extra_rate_per_kg ? ` Over that, you can pay ${rupees(info.extra_rate_per_kg)} per extra kg or take some clothes back.` : ''}{info.express_enabled ? ` Express (faster) service costs ${rupees(info.express_fee)}.` : ''}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ slip */

function Slip({ id, cached, close }: { id: number; cached?: Order[]; close: () => void }) {
  const o = useLoad(async () => { const r = await api<Order & { server_time?: number }>(`/me/orders/${id}`); noteServerTime(r.server_time); return r; }, [id], { every: 20_000 });
  const order = o.data ?? cached?.find(x => x.id === id);
  const live = order && ['RECEIVED', 'WASHING', 'READY'].includes(order.status);
  useNoScreenshots(!!live);
  return (
    <Sheet title="Laundry slip" onClose={close} size="sm" className="slip-sheet">
      {!order ? (o.error ? <ErrorNote error={o.error} retry={o.reload} /> : <Loading />) : (
        <>
          <article className={`slip s-${order.status.toLowerCase()}`}>
            <span className="slip-hole" aria-hidden="true" />
            <header>
              <span className="slip-brand">Everjoy Lawndry</span>
              <span className="slip-no">{order.tag_no ? <span className="card-no">{order.tag_no}</span> : order.order_no}</span>
              {order.tag_no && <span className="slip-order">Order {order.order_no}</span>}
              <StatusPill status={order.status} />
            </header>
            {live && order.qr_key ? (
              <div className="slip-qr"><SlipQr orderId={order.id} slipKey={order.qr_key} size={220} /></div>
            ) : live ? (
              <p className="slip-noqr">The QR could not load. Pull down to refresh, or update the app. At the counter you can also give your basket card no. and show your ID card.</p>
            ) : (
              <div className={`slip-stamp ${order.status === 'CANCELLED' ? 'void' : ''}`}>{order.status === 'CANCELLED' ? 'Cancelled' : `Collected ${when(order.delivered_at, 'short')}`}</div>
            )}
            <dl className="slip-facts">
              <div><dt>Clothes</dt><dd>{order.clothes_count}{order.returned_count != null && order.returned_count !== order.clothes_count ? ` (${order.returned_count} returned)` : ''}</dd></div>
              <div><dt>Weight</dt><dd>{kg(order.weight_kg)}</dd></div>
              <div><dt>Given in</dt><dd>{when(order.received_at, 'short')}</dd></div>
              <div><dt>{order.status === 'READY' || order.ready_at ? 'Ready' : 'Expected'}</dt><dd>{when(order.ready_at || order.expected_at, 'short')}</dd></div>
              <div><dt>Room</dt><dd>{order.room_no}, {order.hostel_name}</dd></div>
              <div><dt>Service</dt><dd>{order.service_name || 'Wash & fold'}{order.service === 'EXPRESS' ? ', express' : ''}</dd></div>
              {order.amount > 0 && <div className="wide"><dt>Amount</dt><dd>{rupees(order.amount)} <PayPill o={order} />{order.charge_note ? <small>{order.charge_note}</small> : null}</dd></div>}
              {order.note && <div className="wide"><dt>Note</dt><dd>{order.note}</dd></div>}
              {order.cancel_reason && <div className="wide"><dt>Reason</dt><dd>{order.cancel_reason}</dd></div>}
            </dl>
            <SlipConfirmations order={order} />
            {order.events && (
              <ol className="slip-timeline">
                {order.events.map((e, i) => <li key={i}><b>{eventLabel(e.type)}</b><span>{when(e.at, 'short')}{e.by_name && e.by_role !== 'STUDENT' ? `, by ${e.by_name}` : ''}</span></li>)}
              </ol>
            )}
          </article>
          {live && <p className="slip-help">Show this QR at the counter when you collect{order.tag_no ? `, or tell them card ${order.tag_no} and show your ID card` : ''}. The QR changes every 30 seconds, so a screenshot or a photo of it won't work.</p>}
          <Button icon="help" block onClick={() => go(`help/new/${order.id}`)}>Report a problem with this order</Button>
        </>
      )}
    </Sheet>
  );
}

/* ---------------------------------------------------- two-sided register */

/**
 * The pop-up when the counter takes your laundry or hands it back: what you confirm, and a code that
 * changes every 30 seconds. Read it out to the staff member; they type it in. That's your signature.
 */
function CodePopup({ r, onClose, onDone }: { r: Pending['requests'][number]; onClose: () => void; onDone: (p?: Pending) => void }) {
  const { code, left, failed } = useRotatingCode(r.key, r.order_id, r.kind, r.step_seconds);
  useNoScreenshots();   // the code is only for the person at the counter
  const [wrong, setWrong] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useFormAction();
  const dispute = async () => {
    const res = await submit(() => api<{ pending: Pending }>(`/me/orders/${r.order_id}/dispute`, { body: { kind: r.kind, reason } }), 'Told the counter. A complaint was opened for you.');
    if (res) onDone(res.pending);
  };
  return (
    <Sheet title={r.kind === 'DROPOFF' ? 'Confirm your drop-off' : 'Confirm your collection'} onClose={onClose} size="sm" className="code-popup">
      <div className="stack">
        <p className="handover-ask-head"><span className="card-no">{r.tag_no ?? r.order_no}</span><span>{r.staff_name} at the counter is waiting for your code.</span></p>
        <p className="confirm-sentence">“{r.statement}”</p>
        {r.amount > 0 && <p className="handover-ask-pay"><Icon name="rupee" size={18} />You pay {rupees(r.amount)} at the counter{r.pay_method ? ` (${r.pay_method === 'UPI' ? 'UPI' : 'cash'})` : ''}.</p>}
        {wrong ? (
          <>
            <Field label="What is wrong?" hint="The counter sees this straight away, and the office gets a complaint.">
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={300} placeholder={r.kind === 'DROPOFF' ? 'e.g. I gave 9 clothes, not 8' : 'e.g. One shirt is missing'} autoFocus />
            </Field>
            {error && <ErrorNote error={error} />}
            <div className="btn-pair">
              <Button tone="plain" onClick={() => setWrong(false)}>Back</Button>
              <Button tone="danger" busy={busy} disabled={reason.trim().length < 3} onClick={dispute}>Tell the counter</Button>
            </div>
          </>
        ) : (
          <>
            <div className="code-show" aria-live="polite">
              <span className="code-show-label">If this is right, read this code to the staff:</span>
              {failed ? <b className="code-digits">—</b> : <b className="code-digits">{code ? `${code.slice(0, 3)} ${code.slice(3)}` : '··· ···'}</b>}
              <span className="code-timer"><i style={{ width: `${(left / r.step_seconds) * 100}%` }} />New code in {left} s</span>
            </div>
            {failed && <ErrorNote error="This screen can't make the code (it needs a secure https page). Ask the staff to help." />}
            <button type="button" className="link-btn confirm-wrong" onClick={() => setWrong(true)}>Something is wrong</button>
            <small className="muted">{r.kind === 'PICKUP' ? 'Check your clothes before you give the code. ' : ''}Never give this code to anyone who is not at the laundry counter.</small>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** On the slip: what the student confirmed, like their signature in the old register. */
function SlipConfirmations({ order }: { order: Order }) {
  const live = ['RECEIVED', 'WASHING', 'READY'].includes(order.status);
  const sig = (kind: 'DROPOFF' | 'PICKUP') => order.signoffs?.find(s => s.kind === kind && !s.superseded_at);
  const line = (kind: 'DROPOFF' | 'PICKUP', ack?: string | null, at?: string | null) => {
    const s = sig(kind);
    const ok = isConfirmed(ack);
    const label = kind === 'DROPOFF' ? 'Drop-off' : 'Collection';
    return (
      <div className={`slip-confirm ${ok ? 'ok' : ack === 'DISPUTED' ? 'bad' : ack === 'OVERRIDE' ? 'warn' : 'wait'}`}>
        <Icon name={ok ? 'check' : ack ? 'alert' : 'clock'} size={16} />
        <span>
          <b>{label}: </b>
          {ok ? `${ack === 'CODE' ? 'you confirmed with your code' : ack === 'COUNTER' ? 'confirmed at the counter' : ack === 'SIGNATURE' ? 'you signed at the counter' : 'you confirmed in the app'}, ${when(at, 'short')}`
            : ack === 'DISPUTED' ? `you reported a problem${s?.reason ? `: “${s.reason}”` : ''}`
            : ack === 'OVERRIDE' ? `handed over by the admin without your confirmation${s?.reason ? ` (${s.reason})` : ''}`
            : live && kind === 'DROPOFF' ? 'not confirmed yet. Staff can send you a code at the counter.' : ackLabel(ack)}
        </span>
        {s?.signature && <SignatureImage name={s.signature} />}
      </div>
    );
  };
  if (order.status === 'CANCELLED') return null;
  return (
    <div className="slip-confirms">
      {line('DROPOFF', order.dropoff_ack, order.dropoff_ack_at)}
      {(order.status === 'DELIVERED' || order.pickup_ack) && line('PICKUP', order.pickup_ack, order.pickup_ack_at)}
    </div>
  );
}

export function eventLabel(t: string) {
  return ({ RECEIVED: 'Received at counter', WASHING: 'Washing started', READY: 'Ready for pickup', DELIVERED: 'Handed over', CANCELLED: 'Cancelled', PAID: 'Payment received', PAYMENT_WAIVED: 'Payment waived', CORRECTED: 'Details corrected',
    DROPOFF_SIGNED: 'Drop-off confirmed by student', DROPOFF_DISPUTED: 'Student reported a problem with the drop-off', DROPOFF_RESET: 'Student must confirm again',
    PICKUP_SIGNED: 'Collection confirmed by student', PICKUP_DISPUTED: 'Student reported a problem at collection' } as Record<string, string>)[t] ?? t;
}

/* ---------------------------------------------------------------- orders */

function MyOrders() {
  const [limit, setLimit] = useState(30);
  const list = useLoad(() => api<{ rows: Order[]; total: number }>(`/me/orders?limit=${limit}`), [limit]);
  if (!list.data) return list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />;
  const { rows, total } = list.data;
  return (
    <div className="st-page">
      <h1>My orders</h1>
      {!rows.length ? <Empty title="No orders yet">Your laundry history will show up here after your first drop-off.</Empty> : (
        <ul className="history">
          {rows.map(o => (
            <li key={o.id}>
              <button onClick={() => go(`orders/slip/${o.id}`)}>
                <span className="h-no">{o.order_no}</span>
                <span className="h-meta">{when(o.received_at, 'date')}, {o.service_name ? `${o.service_name}, ` : ''}{plural(o.clothes_count, 'piece')}{Number(o.weight_kg) > 0 ? `, ${kg(o.weight_kg)}` : ''}</span>
                <span className="h-right"><StatusPill status={o.status} /><PayPill o={o} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length < total && <Button block onClick={() => setLimit(limit + 30)}>Show older orders</Button>}
    </div>
  );
}

/* ------------------------------------------------------------------ help */

function Help({ home }: { home: Home }) {
  const [, sub, orderId] = useRoute();
  const list = useLoad(() => api<{ rows: Complaint[]; categories: string[] }>('/me/complaints'), []);
  return (
    <div className="st-page">
      <h1>Help</h1>
      <Button tone="primary" icon="plus" block onClick={() => go('help/new')} disabled={home.profile.status !== 'ACTIVE'}>Report a problem</Button>
      <a className="guide-link" href="guide/students.html"><Icon name="help" size={20} /><span><b>How to use Everjoy</b><small>Step-by-step guide with pictures</small></span><Icon name="next" size={18} /></a>
      <h2 className="sub">My complaints</h2>
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !list.data.rows.length
        ? <p className="muted">No complaints. If clothes go missing or come back damaged, report it here with the order number.</p>
        : <div className="complaints">{list.data.rows.map(c => <ComplaintCard key={c.id} c={c} />)}</div>}
      {!!home.services?.length && <>
        <h2 className="sub">Services and prices</h2>
        <table className="price-list">
          <thead><tr><th>Service</th><th className="num">{planOf(home).hosteler ? 'Your price' : 'Price'}</th></tr></thead>
          <tbody>
            {home.services.map(x => {
              const r = planOf(home).hosteler ? x.hosteler_rate : x.rate;
              const per = x.unit === 'KG' ? 'kg' : 'piece';
              return <tr key={x.id}><td>{x.name}{planOf(home).hosteler && x.uses_allowance ? <small>Free up to {kg(home.info.max_kg_per_order)} per order</small> : null}</td><td className="num">{r ? `${rupees(r)} / ${per}` : 'Free'}</td></tr>;
            })}
          </tbody>
        </table>
        <p className="muted small">{planOf(home).label}. Each service gets its own slip.</p>
      </>}
      <h2 className="sub">Good to know</h2>
      <dl className="faq">
        <dt>How much can I give at once?</dt><dd>{kg(home.info.max_kg_per_order)} per order is free with the hostel plan.{home.info.allow_paid_extra !== false && home.info.extra_rate_per_kg ? ` If your clothes weigh more, you can pay ${rupees(home.info.extra_rate_per_kg)} per extra kg or take some back.` : ' Heavier loads need a second order.'} Staff weigh and count your clothes, and the slip appears on your phone.</dd>
        <dt>Can I pay by UPI?</dt><dd>{home.info.upi_id || home.info.has_upi_qr ? 'Yes. Tap “Pay by UPI” on Home to see the QR, pay, and show the payment screen at the counter. Cash also works.' : 'Pay in cash at the counter.'}</dd>
        <dt>My phone is dead at pickup</dt><dd>Tell staff your order number and show your ID card. They can find the order without the QR.</dd>
        <dt>I forgot my password</dt><dd>Tap “Forgot your password?” on the sign-in page to get a code by university email, or ask at the counter for a temporary password.</dd>
        <dt>Counter timings</dt><dd>{home.info.dropoff_from ? <>Give laundry: {t12(home.info.dropoff_from)}–{t12(home.info.dropoff_to!)}. Collect: {t12(home.info.pickup_from!)}–{t12(home.info.pickup_to!)}. </> : null}{home.info.counter_hours}</dd>
      </dl>
      {sub === 'new' && list.data && <NewComplaint categories={list.data.categories} orderId={orderId} close={() => back('help')} onDone={() => { void list.reload(); back('help'); }} />}
    </div>
  );
}

function ComplaintCard({ c }: { c: Complaint }) {
  return (
    <article className={`complaint c-${c.status.toLowerCase()}`}>
      <header><b>{c.category}</b><span className={`pill cs-${c.status.toLowerCase()}`}>{c.status === 'IN_PROGRESS' ? 'Being checked' : c.status === 'OPEN' ? 'Sent' : 'Resolved'}</span></header>
      <p>{c.description}</p>
      <small>{c.order_no ? `${c.order_no}, ` : ''}{ago(c.created_at)}</small>
      {c.photo && <Photo name={c.photo} alt="Photo you attached" />}
      {c.updates?.filter(u => u.message).map((u, i) => (
        <blockquote key={i} className={u.by_role === 'STUDENT' ? 'mine' : ''}><p>{u.message}</p><cite>{u.by_role === 'STUDENT' ? 'You' : u.by_name}, {ago(u.at)}</cite></blockquote>
      ))}
    </article>
  );
}

function NewComplaint({ categories, orderId, close, onDone }: { categories: string[]; orderId?: string; close: () => void; onDone: () => void }) {
  const orders = useLoad(() => api<{ rows: Order[] }>('/me/orders?limit=20'), []);
  const [f, setF] = useState({ orderId: orderId ?? '', category: '', description: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const { busy, error, submit } = useFormAction();
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    Object.entries(f).forEach(([k, v]) => form.append(k, v));
    if (photo) { const small = await shrinkPhoto(photo); form.append('photo', small, small === photo ? photo.name : 'photo.jpg'); }
    if (await submit(() => api('/me/complaints', { form }), 'Complaint sent. You will get a reply here.')) onDone();
  };
  return (
    <Sheet title="Report a problem" onClose={close}>
      <form className="stack" onSubmit={send}>
        <Field label="Which order?">
          <select value={f.orderId} onChange={e => setF({ ...f, orderId: e.target.value })}>
            <option value="">Not about one order</option>
            {orders.data?.rows.map(o => <option key={o.id} value={o.id}>{o.order_no}, {when(o.received_at, 'date')}, {o.clothes_count} clothes</option>)}
          </select>
        </Field>
        <Field label="What went wrong?">
          <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })} required>
            <option value="">Choose</option>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Tell us more" hint="Colour, brand or name label help staff find missing items">
          <textarea rows={4} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} required />
        </Field>
        <Field label="Photo (optional)">
          <input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
        </Field>
        {error && <ErrorNote error={error} />}
        <Button tone="primary" block busy={busy} disabled={!f.category || f.description.trim().length < 5}>Send complaint</Button>
      </form>
    </Sheet>
  );
}

/* --------------------------------------------------------------- profile */

function Profile({ home, onSaved, onSignOut, user, onUser }: { home: Home; onSaved: () => void; onSignOut: () => void; user: User; onUser: (u: User) => void }) {
  const [, sub] = useRoute();
  const p = home.profile;
  const status: Record<string, ReactNode> = { ACTIVE: 'Approved', PENDING: 'Waiting for approval', REJECTED: 'Needs a fix', SUSPENDED: 'On hold' };
  return (
    <div className="st-page">
      <h1>Profile</h1>
      <ProfilePhoto p={p} onSaved={onSaved} />
      <dl className="profile-card">
        <div><dt>Name</dt><dd>{p.name}</dd></div>
        <div><dt>ID card no.</dt><dd>{p.id_card_no}</dd></div>
        <div><dt>Mobile</dt><dd>{p.mobile}</dd></div>
        <div><dt>University email</dt><dd>{p.email ?? <AddEmail onSaved={onSaved} />}{p.email && <small>{p.email_verified_at ? 'Sign-in codes are sent here' : 'Confirmed at your next sign-in on a new phone'}</small>}</dd></div>
        <div><dt>Hostel and room</dt><dd>{p.hostel_name}, room {p.room_no}{p.pending_hostel_id ? <small>Change to {p.pending_hostel_name}, room {p.pending_room_no} is waiting for the counter</small> : null}</dd></div>
        {p.status === 'ACTIVE' && <div><dt>Hostel plan</dt><dd>{planOf(home).label}</dd></div>}
        <div><dt>Account</dt><dd><span className={`pill acc-${p.status.toLowerCase()}`}>{status[p.status]}</span></dd></div>
      </dl>
      <div className="menu-list">
        <button onClick={() => go('me/edit')}><Icon name="edit" /><span>Change room, hostel or mobile</span><Icon name="next" size={18} /></button>
        <button onClick={() => go('me/myqr')}><Icon name="qr" /><span>My ID QR for the counter</span><Icon name="next" size={18} /></button>
        <button onClick={() => go('me/password')}><Icon name="lock" /><span>Change password</span><Icon name="next" size={18} /></button>
        <button onClick={onSignOut} className="danger"><Icon name="logout" /><span>Sign out</span></button>
      </div>
      <p className="muted small">Tip: in your browser menu, choose “Add to Home screen” to open Everjoy like an app.</p>
      {sub === 'edit' && <EditProfile p={p} close={() => back('me')} onSaved={() => { onSaved(); back('me'); }} />}
      {sub === 'password' && <Sheet title="Change password" onClose={() => back('me')} size="sm"><ChangePassword user={user} onDone={u => { onUser(u); back('me'); }} /></Sheet>}
    </div>
  );
}

function EditProfile({ p, close, onSaved }: { p: Student; close: () => void; onSaved: () => void }) {
  const info = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  const identity = p.status === 'PENDING' || p.status === 'REJECTED';
  const [f, setF] = useState({ name: p.name, idCardNo: p.id_card_no, mobile: p.mobile, hostelId: String(p.pending_hostel_id ?? p.hostel_id), roomNo: p.pending_room_no ?? p.room_no });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = identity ? f : { mobile: f.mobile, hostelId: f.hostelId, roomNo: f.roomNo };
    const moved = !identity && (f.hostelId !== String(p.hostel_id) || f.roomNo.trim().toUpperCase() !== p.room_no);
    if (await submit(() => api('/me/profile', { method: 'PATCH', body }), p.status === 'REJECTED' ? 'Sent again for approval' : moved ? 'Saved. The counter will check your new room before it changes.' : 'Profile saved')) onSaved();
  };
  return (
    <Sheet title={p.status === 'REJECTED' ? 'Fix and resubmit' : 'Edit details'} onClose={close}>
      <form className="stack" onSubmit={save}>
        {identity ? <>
          <Field label="Full name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="ID card no."><input value={f.idCardNo} onChange={e => setF({ ...f, idCardNo: e.target.value })} autoCapitalize="characters" /></Field>
        </> : <p className="muted small">Name and ID card no. are locked after approval. A new hostel or room changes only after the counter checks it.</p>}
        <Field label="Mobile number"><input value={f.mobile} onChange={e => setF({ ...f, mobile: e.target.value })} inputMode="tel" /></Field>
        <div className="field-row">
          <Field label="Hostel">
            <select value={f.hostelId} onChange={e => setF({ ...f, hostelId: e.target.value })}>
              {(info.data?.hostels ?? [{ id: p.hostel_id, name: p.hostel_name }]).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </Field>
          <Field label="Room no."><input value={f.roomNo} onChange={e => setF({ ...f, roomNo: e.target.value })} autoCapitalize="characters" /></Field>
        </div>
        {error && <ErrorNote error={error} />}
        <Button tone="primary" block busy={busy}>{p.status === 'REJECTED' ? 'Send for approval' : 'Save'}</Button>
      </form>
    </Sheet>
  );
}

function MyQr({ profile, close }: { profile: Student; close: () => void }) {
  useNoScreenshots();
  return (
    <Sheet title="My ID for the counter" onClose={close} size="sm">
      <div className="my-qr">
        <QrImage text={`EJS:${profile.id_card_no}`} size={220} />
        <b>{profile.name}</b>
        <span>{profile.id_card_no}</span>
        <p className="muted small">Staff scan this to open your account. Keep your physical ID card ready too.</p>
      </div>
    </Sheet>
  );
}

function Inbox({ close }: { close: () => void }) {
  const list = useLoad(() => api<{ rows: Notice[]; unread: number }>('/notifications'), []);
  useEffect(() => { if (list.data?.unread) void api('/notifications/read', { method: 'POST' }).catch(() => {}); }, [list.data?.unread]);
  return (
    <Sheet title="Notifications" onClose={close}>
      {!list.data ? <Loading /> : !list.data.rows.length ? <Empty icon="bell" title="No notifications yet">Updates about your laundry will appear here.</Empty> : (
        <ul className="inbox">
          {list.data.rows.map(n => (
            <li key={n.id} className={n.read_at ? '' : 'unread'}>
              <button onClick={() => n.order_id && go(`slip/${n.order_id}`)} disabled={!n.order_id}>
                <b>{n.title}</b><p>{n.body}</p><small>{ago(n.created_at)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

/** Profile photo: the student adds it until approval; afterwards it is locked and only the counter changes it. */
function ProfilePhoto({ p, onSaved }: { p: Student; onSaved: () => void }) {
  const { busy, run } = useAction();
  const locked = p.status === 'ACTIVE' && !!p.photo;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const small = await shrinkPhoto(file, 900);
    const form = new FormData();
    form.append('photo', small, 'photo.jpg');
    if (await run(() => api('/me/photo', { form }), 'Photo saved') !== undefined) onSaved();
  };
  return (
    <div className="photo-row profile-photo">
      <Avatar name={p.name} photo={p.photo} size={88} />
      <div className="stack">
        {locked ? <p className="muted small">Your photo is checked by the counter. To change it, ask at the counter.</p> : <>
          <p className="muted small">{p.photo ? 'Staff compare this with your face at the counter.' : 'Add a clear photo of your face. Staff compare it with you at the counter.'}</p>
          <label className={`btn btn-quiet btn-sm${busy ? ' is-busy' : ''}`}>
            <Icon name="camera" size={18} /><span>{p.photo ? 'Change photo' : 'Add photo'}</span>
            <input type="file" accept="image/*" capture="user" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </>}
      </div>
    </div>
  );
}

/** Students registered before email codes add their university email once. */
function AddEmail({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);
  const [otp, setOtp] = useState<OtpStart | null>(null);
  const { busy, error, submit } = useFormAction();
  if (!open) return <button type="button" className="link-btn" onClick={() => setOpen(true)}>Add your university email</button>;
  // The email is saved only after the code sent to it is typed in.
  if (otp) return <Sheet title="Confirm your email" onClose={() => setOtp(null)} size="sm"><OtpStep start={otp} onDone={() => { toast('Email added'); setOtp(null); onSaved(); }} onBack={() => setOtp(null)} /></Sheet>;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<OtpStart>('/me/email', { method: 'PUT', body: { email } }));
    if (r) setOtp(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@university.edu" inputMode="email" autoCapitalize="none" aria-label="University email" />
      {error && <ErrorNote error={error} />}
      <Button size="sm" tone="primary" busy={busy} disabled={!email.includes('@')}>Save email</Button>
    </form>
  );
}
