import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Announcement, api, Complaint, Hostel, Notice, Order, Student, Usage, User } from './api';
import { ChangePassword } from './auth';
import { isApp, serverAddress } from './platform';
import { ago, back, firstName, go, kg, plural, rupees, useFormAction, useLoad, useRoute, useScrollTop, when } from './lib';
import { Brand, Button, Empty, ErrorNote, Field, Icon, IconButton, IconName, Loading, PayPill, Photo, Progress, QrImage, Sheet, StatusPill } from './ui';

type Home = {
  profile: Student; usage: Usage; open: Order[]; due: number; unread: number; open_complaints: number; announcements: Announcement[];
  info: { max_kg_per_order: number; counter_hours: string; upi_id: string; upi_name: string; pay_before_pickup: boolean; express_enabled: boolean; express_fee: number;
    monthly_kg_limit: number; monthly_order_limit: number; over_limit_action: 'BLOCK' | 'CHARGE'; extra_rate_per_kg: number };
};

const cacheKey = (id: number) => `ej-home-${id}`;
function readCache(id: number): Home | undefined { try { return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null') ?? undefined; } catch { return undefined; } }
function writeCache(id: number, h: Home) { try { localStorage.setItem(cacheKey(id), JSON.stringify(h)); } catch { /* storage full or blocked */ } }

export function StudentApp({ user, onSignOut, onUser }: { user: User; onSignOut: () => void; onUser: (u: User) => void }) {
  const parts = useRoute();
  // Home is polled so "Ready for pickup" shows up without a refresh. The last copy is kept
  // on the phone, so the slip QR still opens with weak network at the counter.
  const home = useLoad(async () => { const h = await api<Home>('/me/home'); writeCache(user.id, h); return h; }, [user.id], { every: 30_000 });
  const data = home.data ?? readCache(user.id);
  const offline = !home.data && !!data && !!home.error;

  const signOut = () => { try { localStorage.removeItem(cacheKey(user.id)); } catch { /* ignore */ } onSignOut(); };
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
          <HomePage home={data} />}
      </main>
      <nav className="st-tabs" aria-label="Main">
        <Tab to="" icon="home" label="Home" on={tab === 'home'} />
        <Tab to="orders" icon="list" label="My orders" on={tab === 'orders'} />
        <Tab to="help" icon="help" label="Help" on={tab === 'help'} badge={data?.open_complaints} />
        <Tab to="me" icon="user" label="Profile" on={tab === 'me'} />
      </nav>
      {overlay === 'slip' && arg && <Slip id={Number(arg)} cached={data?.open} close={closeOverlay} />}
      {overlay === 'inbox' && <Inbox close={() => { closeOverlay(); void home.reload(); }} />}
      {overlay === 'myqr' && data && <MyQr profile={data.profile} close={closeOverlay} />}
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

function HomePage({ home }: { home: Home }) {
  const { profile: p, open, usage, info } = home;
  const ready = open.filter(o => o.status === 'READY');
  return (
    <div className="st-home">
      <section className="hello">
        <h1>Hi {firstName(p.name)}</h1>
        <p>{p.hostel_name}, room {p.room_no}</p>
      </section>

      {p.status !== 'ACTIVE' ? <AccountState p={p} /> : (
        <>
          {ready.length > 0 && <p className="ready-banner"><Icon name="check" size={18} />{ready.length === 1 ? `${ready[0].order_no} is ready. Collect it with your slip.` : `${ready.length} orders are ready to collect.`}</p>}
          <section aria-label="Laundry at the counter" className="tag-stack">
            {open.length ? open.map(o => <OrderTag key={o.id} o={o} />) : (
              <Empty icon="shirt" title="Nothing at the counter">
                Drop off up to {info.max_kg_per_order} kg at the laundry counter. Your digital slip appears here straight away.
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

      {home.due > 0 && <PayDue amount={home.due} info={info} orders={open.filter(o => o.payment_status === 'DUE')} />}

      {p.status === 'ACTIVE' && <MonthUsage usage={usage} info={info} />}

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
  );
}

function AccountState({ p }: { p: Student }) {
  if (p.status === 'PENDING') return (
    <section className="state-card pending">
      <Icon name="card" size={26} />
      <h2>One step left: show your ID card</h2>
      <p>Take your university ID card to the laundry counter. Staff will check your details on the university portal and approve you. It takes a minute.</p>
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
        <span className="order-tag-no">{o.order_no}</span>
        <StatusPill status={o.status} />
      </span>
      <span className="order-tag-meta">{plural(o.clothes_count, 'piece')} of clothing, {kg(o.weight_kg)}{o.service === 'EXPRESS' ? ', express' : ''}</span>
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
  const note = orders.map(o => o.order_no).join(' ');
  const upi = info.upi_id ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.upi_name || 'Everjoy Lawndry')}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}` : '';
  return (
    <section className="pay-card">
      <div>
        <b>{rupees(amount)} to pay</b>
        <p>{orders.map(o => `${o.order_no}: ${rupees(o.amount)}${o.service === 'EXPRESS' ? ' (express)' : ''}${o.extra_kg ? ` (${kg(o.extra_kg)} over monthly limit)` : ''}`).join('. ')}.
          {info.pay_before_pickup ? ' Pay before you collect.' : ''}</p>
      </div>
      {upi ? <a className="btn btn-primary btn-md" href={upi}><Icon name="rupee" size={18} /><span>Pay with UPI</span></a> : null}
      <small>{upi ? 'Show the payment screen at the counter. ' : ''}Cash is also fine at the counter.</small>
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
          {info.over_limit_action === 'CHARGE' && info.extra_rate_per_kg ? ` Extra weight costs ${rupees(info.extra_rate_per_kg)} per kg.` : usage.kg_left === 0 ? ' New orders open next month.' : ''}</p>
      </>}
      <p className="usage-note">Each order can be up to {kg(info.max_kg_per_order)}.{info.express_enabled ? ` Express (faster) service costs ${rupees(info.express_fee)}.` : ''}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ slip */

function Slip({ id, cached, close }: { id: number; cached?: Order[]; close: () => void }) {
  const o = useLoad(() => api<Order>(`/me/orders/${id}`), [id], { every: 20_000 });
  const order = o.data ?? cached?.find(x => x.id === id);
  const live = order && ['RECEIVED', 'WASHING', 'READY'].includes(order.status);
  return (
    <Sheet title="Laundry slip" onClose={close} size="sm" className="slip-sheet">
      {!order ? (o.error ? <ErrorNote error={o.error} retry={o.reload} /> : <Loading />) : (
        <>
          <article className={`slip s-${order.status.toLowerCase()}`}>
            <span className="slip-hole" aria-hidden="true" />
            <header>
              <span className="slip-brand">Everjoy Lawndry</span>
              <span className="slip-no">{order.order_no}</span>
              <StatusPill status={order.status} />
            </header>
            {live && order.qr_token ? (
              <div className="slip-qr"><QrImage text={`EJ:${order.qr_token}`} size={220} /></div>
            ) : (
              <div className={`slip-stamp ${order.status === 'CANCELLED' ? 'void' : ''}`}>{order.status === 'CANCELLED' ? 'Cancelled' : `Collected ${when(order.delivered_at, 'short')}`}</div>
            )}
            <dl className="slip-facts">
              <div><dt>Clothes</dt><dd>{order.clothes_count}{order.returned_count != null && order.returned_count !== order.clothes_count ? ` (${order.returned_count} returned)` : ''}</dd></div>
              <div><dt>Weight</dt><dd>{kg(order.weight_kg)}</dd></div>
              <div><dt>Given in</dt><dd>{when(order.received_at, 'short')}</dd></div>
              <div><dt>{order.status === 'READY' || order.ready_at ? 'Ready' : 'Expected'}</dt><dd>{when(order.ready_at || order.expected_at, 'short')}</dd></div>
              <div><dt>Room</dt><dd>{order.room_no}, {order.hostel_name}</dd></div>
              <div><dt>Service</dt><dd>{order.service === 'EXPRESS' ? 'Express' : 'Regular'}</dd></div>
              {order.amount > 0 && <div className="wide"><dt>Amount</dt><dd>{rupees(order.amount)} <PayPill o={order} /></dd></div>}
              {order.note && <div className="wide"><dt>Note</dt><dd>{order.note}</dd></div>}
              {order.cancel_reason && <div className="wide"><dt>Reason</dt><dd>{order.cancel_reason}</dd></div>}
            </dl>
            {order.events && (
              <ol className="slip-timeline">
                {order.events.map((e, i) => <li key={i}><b>{eventLabel(e.type)}</b><span>{when(e.at, 'short')}{e.by_name && e.by_role !== 'STUDENT' ? `, by ${e.by_name}` : ''}</span></li>)}
              </ol>
            )}
          </article>
          {live && <p className="slip-help">Show this QR at the counter when you collect. Turn your screen brightness up if it does not scan.</p>}
          <Button icon="help" block onClick={() => go(`help/new/${order.id}`)}>Report a problem with this order</Button>
        </>
      )}
    </Sheet>
  );
}

export function eventLabel(t: string) {
  return ({ RECEIVED: 'Received at counter', WASHING: 'Washing started', READY: 'Ready for pickup', DELIVERED: 'Handed over', CANCELLED: 'Cancelled', PAID: 'Payment received', PAYMENT_WAIVED: 'Payment waived', CORRECTED: 'Details corrected' } as Record<string, string>)[t] ?? t;
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
                <span className="h-meta">{when(o.received_at, 'date')}, {plural(o.clothes_count, 'piece')}, {kg(o.weight_kg)}</span>
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
      <h2 className="sub">My complaints</h2>
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !list.data.rows.length
        ? <p className="muted">No complaints. If clothes go missing or come back damaged, report it here with the order number.</p>
        : <div className="complaints">{list.data.rows.map(c => <ComplaintCard key={c.id} c={c} />)}</div>}
      <h2 className="sub">Good to know</h2>
      <dl className="faq">
        <dt>How much can I give at once?</dt><dd>Up to {kg(home.info.max_kg_per_order)} per order. Staff weigh and count your clothes, and the slip appears on your phone.</dd>
        <dt>My phone is dead at pickup</dt><dd>Tell staff your order number and show your ID card. They can find the order without the QR.</dd>
        <dt>I forgot my password</dt><dd>Ask at the counter. Staff give you a temporary password, and you choose a new one after signing in.</dd>
        <dt>Counter timings</dt><dd>{home.info.counter_hours}</dd>
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

/**
 * Shrink a camera photo before upload (longest side 1600 px, JPEG): faster on campus data and
 * keeps the database small. Falls back to the original if the browser can't decode it (e.g. HEIC).
 */
async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
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
      <dl className="profile-card">
        <div><dt>Name</dt><dd>{p.name}</dd></div>
        <div><dt>ID card no.</dt><dd>{p.id_card_no}</dd></div>
        <div><dt>Mobile</dt><dd>{p.mobile}</dd></div>
        <div><dt>Hostel and room</dt><dd>{p.hostel_name}, room {p.room_no}</dd></div>
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
  const [f, setF] = useState({ name: p.name, idCardNo: p.id_card_no, mobile: p.mobile, hostelId: String(p.hostel_id), roomNo: p.room_no });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = identity ? f : { mobile: f.mobile, hostelId: f.hostelId, roomNo: f.roomNo };
    if (await submit(() => api('/me/profile', { method: 'PATCH', body }), p.status === 'REJECTED' ? 'Sent again for approval' : 'Profile saved')) onSaved();
  };
  return (
    <Sheet title={p.status === 'REJECTED' ? 'Fix and resubmit' : 'Edit details'} onClose={close}>
      <form className="stack" onSubmit={save}>
        {identity ? <>
          <Field label="Full name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="ID card no."><input value={f.idCardNo} onChange={e => setF({ ...f, idCardNo: e.target.value })} autoCapitalize="characters" /></Field>
        </> : <p className="muted small">Name and ID card no. are locked after approval. Ask the counter if they are wrong.</p>}
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
