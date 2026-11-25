/* Building blocks shared by the staff counter and the admin office. */
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, Complaint, Hostel, Order, Plan, Service, Student, Usage } from './api';
import { eventLabel } from './student';
import { DropoffSign, pickupSentence, SignaturePad, SignoffRecord, useSignRules } from './signoff';
import { ago, kg, planPeriod, plural, rupees, semesterOptions, shrinkPhoto, toast, useAction, useFormAction, useLoad, when } from './lib';
import { Avatar, Button, Empty, ErrorNote, Field, Icon, Loading, PayPill, Photo, Segmented, Sheet, StatusPill, Stepper, UpiQr } from './ui';

export type OpsSettings = { max_kg_per_order: number; express_enabled: boolean; express_fee: number; pay_before_pickup: boolean; monthly_kg_limit: number; monthly_order_limit: number; max_active_orders: number;
  allow_paid_extra: boolean; extra_rate_per_kg: number; upi_id: string; upi_name: string; has_upi_qr: boolean;
  card_required?: boolean; card_series?: { prefix: string; suffix?: string; from: number; to: number; pad?: number }[]; semester_start?: string; semester_end?: string };
export type CounterStudent = Student & { usage: Usage; open: Order[]; orders?: Order[]; plan: Plan };
export type { Service };

/** “Wash & fold”, “Ironing only (6 pcs)”: what was done, in a few words. */
export const serviceLine = (o: Pick<Order, 'service_name' | 'service'>) => `${o.service_name || 'Wash & fold'}${o.service === 'EXPRESS' ? ', express' : ''}`;

const isOpen = (o: Order) => ['RECEIVED', 'WASHING', 'READY'].includes(o.status);

/* ------------------------------------------------------------ order sheet */

export function OrderSheet({ id, close, onChanged, isAdmin, payFirst }: { id: number; close: () => void; onChanged?: () => void; isAdmin: boolean; payFirst: boolean }) {
  const d = useLoad(() => api<Order>(`/ops/orders/${id}`), [id]);
  const [mode, setMode] = useState<'view' | 'handover' | 'fix' | 'cancel' | 'pay' | 'waive' | 'card' | 'sign'>('view');
  const { busy, run } = useAction();
  const changed = (o: Order) => { d.set(o); setMode('view'); onChanged?.(); };
  const setStatus = async (status: string) => {
    if (await run(() => api('/ops/orders/status', { body: { ids: [id], status } }), `Marked ${status === 'READY' ? 'ready' : status.toLowerCase()}`)) { await d.reload(); onChanged?.(); }
  };
  const o = d.data;
  return (
    <Sheet title={o ? o.order_no : 'Order'} onClose={close} size="md" className="order-sheet">
      {!o ? (d.error ? <ErrorNote error={d.error} retry={d.reload} /> : <Loading />) : mode === 'handover' ? (
        <HandOver o={o} payFirst={payFirst} isAdmin={isAdmin} onDone={changed} onCancel={() => setMode('view')} />
      ) : mode === 'sign' ? (
        <div className="stack">
          <DropoffSign o={o} onSigned={r => { d.set(r); onChanged?.(); }} />
          <Button tone="plain" block onClick={() => { setMode('view'); void d.reload(); }}>Back</Button>
        </div>
      ) : mode === 'card' ? (
        <ChangeCard o={o} onDone={changed} onCancel={() => setMode('view')} />
      ) : mode === 'fix' ? (
        <FixOrder o={o} onDone={changed} onCancel={() => setMode('view')} />
      ) : mode === 'cancel' || mode === 'waive' ? (
        <ReasonForm o={o} kind={mode} onDone={changed} onCancel={() => setMode('view')} />
      ) : mode === 'pay' ? (
        <PayForm o={o} onDone={changed} onCancel={() => setMode('view')} />
      ) : (
        <div className="stack">
          <div className="os-head">
            <StatusPill status={o.status} late={o.late} />
            <PayPill o={o} />
            {o.service === 'EXPRESS' && <span className="pill express">Express</span>}
          </div>
          <StudentLine o={o} />
          <dl className="facts">
            <div><dt>Basket card</dt><dd className="big">{o.tag_no ? <span className="card-no">{o.tag_no}</span> : <span className="muted">None</span>}</dd></div>
            <div><dt>Clothes</dt><dd className="big">{o.clothes_count}{o.returned_count != null ? <small> / {o.returned_count} returned</small> : null}</dd></div>
            <div><dt>Weight</dt><dd className="big">{kg(o.weight_kg)}</dd></div>
            <div><dt>Received</dt><dd>{when(o.received_at, 'short')}<small>{o.received_by_name}</small></dd></div>
            <div><dt>{o.ready_at ? 'Ready' : 'Expected'}</dt><dd>{when(o.ready_at || o.expected_at, 'short')}</dd></div>
            {o.delivered_at && <div><dt>Handed over</dt><dd>{when(o.delivered_at, 'short')}<small>{o.delivered_by_name}</small></dd></div>}
            <div><dt>Service</dt><dd>{serviceLine(o)}{o.customer_kind === 'WALKIN' ? <small>Walk-in customer</small> : null}</dd></div>
            {o.amount > 0 && <div><dt>Amount</dt><dd>{rupees(o.amount)}<small>{o.charge_note || (o.extra_kg ? `${kg(o.extra_kg)} over limit` : '')}{o.paid_ref ? ` Ref ${o.paid_ref}` : ''}</small></dd></div>}
          </dl>
          {o.handover_request?.status === 'WAITING' && isOpen(o) && (
            <button type="button" className="sf-callout" onClick={() => setMode('handover')}><Icon name="phone" />Waiting for the student to confirm on their phone<Icon name="next" size={18} /></button>
          )}
          {o.note && <p className="note-line"><Icon name="tag" size={16} />{o.note}</p>}
          {o.cancel_reason && <p className="note-line bad"><Icon name="x" size={16} />{o.cancel_reason}</p>}
          {isOpen(o) && (
            <>
              <div className="status-row" role="group" aria-label="Change status">
                {(['RECEIVED', 'WASHING', 'READY'] as const).map(s => (
                  <button key={s} className={o.status === s ? 'on' : ''} disabled={busy || o.status === s} onClick={() => setStatus(s)}>{s === 'READY' ? 'Ready' : s[0] + s.slice(1).toLowerCase()}</button>
                ))}
              </div>
              <Button tone="primary" size="lg" block icon="check" onClick={() => setMode('handover')}>Hand over to student</Button>
              <div className="minor-actions">
                {o.payment_status === 'DUE' && <Button size="sm" icon="rupee" onClick={() => setMode('pay')}>Record payment</Button>}
                <Button size="sm" icon="tag" onClick={() => setMode('card')}>{o.tag_no ? 'Change card' : 'Add card'}</Button>
                {(isAdmin || o.status === 'RECEIVED') && <Button size="sm" icon="edit" onClick={() => setMode('fix')}>Correct weight or count</Button>}
                {(isAdmin || o.status === 'RECEIVED') && <Button size="sm" tone="danger" icon="x" onClick={() => setMode('cancel')}>Cancel order</Button>}
                {isAdmin && o.payment_status === 'DUE' && <Button size="sm" onClick={() => setMode('waive')}>Waive payment</Button>}
              </div>
            </>
          )}
          <h3 className="sub">Student confirmation</h3>
          <SignoffRecord o={o} showEvidence />
          {isOpen(o) && o.dropoff_ack !== 'SIGNATURE' && o.dropoff_ack !== 'PHONE' && (
            <Button size="sm" icon="edit" onClick={() => setMode('sign')}>Student signs the drop-off now</Button>
          )}
          <h3 className="sub">Timeline</h3>
          <ol className="timeline">
            {o.events?.map((e, i) => <li key={i}><b>{eventLabel(e.type)}</b>{e.note && <span>{e.note}</span>}<small>{when(e.at, 'short')}{e.by_name ? `, ${e.by_name}` : ''}</small></li>)}
          </ol>
        </div>
      )}
    </Sheet>
  );
}

export function StudentLine({ o, photoSize = 44 }: { o: Pick<Order, 'student_name' | 'id_card_no' | 'hostel_name' | 'room_no' | 'mobile' | 'student_photo'>; photoSize?: number }) {
  return (
    <div className="student-line">
      <Avatar name={o.student_name || '?'} photo={o.student_photo} size={photoSize} />
      <span><b>{o.student_name}</b><small>ID {o.id_card_no}, {o.hostel_name}, room {o.room_no}</small></span>
      {o.mobile && <a className="icon-btn" href={`tel:${o.mobile}`} aria-label={`Call ${o.student_name}`}><Icon name="phone" /></a>}
    </div>
  );
}

/**
 * The handover step: count clothes back, settle any payment, then the student confirms they received
 * them, by signing on this screen or tapping "Yes" in their own app (the admin alone may skip it, with a reason).
 */
export function HandOver({ o, payFirst, onDone, onCancel, isAdmin }: { o: Order; payFirst: boolean; onDone: (o: Order) => void; onCancel?: () => void; isAdmin?: boolean }) {
  const rules = useSignRules();
  const [count, setCount] = useState(String(o.clothes_count));
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [ref, setRef] = useState('');
  const walkIn = o.customer_kind === 'WALKIN';
  const [how, setHow] = useState<'sign' | 'phone' | 'override'>('sign');
  const [sig, setSig] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [waiting, setWaiting] = useState<Order | null>(o.handover_request?.status === 'WAITING' ? o : null);
  const { busy, error, submit } = useFormAction();
  const mismatch = Number(count) !== o.clothes_count;
  const needsPay = o.payment_status === 'DUE';
  const signNeeded = rules.sign_pickup;
  // A signature is for one sentence: if the count, the note or the method changes, the student signs again.
  useEffect(() => { setSig(null); }, [count, note, how]);
  const proofOk = !signNeeded || how === 'phone' || (how === 'sign' && !!sig) || (how === 'override' && why.trim().length >= 5);
  // The note is part of what the student signs only when the count differs (the server records it the same way).
  const body = () => ({ returnedCount: Number(count), note: mismatch ? note : '', ...(needsPay ? { payMethod: method, payRef: ref } : {}) });

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (signNeeded && how === 'phone') {
      const r = await submit(() => api<Order>(`/ops/orders/${o.id}/handover-request`, { body: body() }));
      if (r) setWaiting(r);
      return;
    }
    const proof = how === 'override' && signNeeded ? { override: why.trim() } : sig ? { signature: sig, clothesCount: o.clothes_count } : {};
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}/deliver`, { body: { ...body(), ...proof } }), `${o.order_no} handed over`);
    if (r) onDone(r);
  };

  if (waiting) return <PhoneWait o={waiting} onDone={onDone} onBack={() => setWaiting(null)} />;

  const ways: { value: 'sign' | 'phone' | 'override'; label: string }[] = [
    { value: 'sign', label: 'Sign here' },
    ...(!walkIn ? [{ value: 'phone' as const, label: 'On their phone' }] : []),
    ...(isAdmin ? [{ value: 'override' as const, label: 'Without (admin)' }] : []),
  ];
  return (
    <form className="handover stack" onSubmit={go}>
      {o.status !== 'READY' && <p className="warn-line"><Icon name="alert" size={18} />This order is still marked “{o.status.toLowerCase()}”. Only hand over if the clothes are really done.</p>}
      <div className="count-check">
        <span>Given at drop-off</span>
        <b>{o.clothes_count}</b>
        <span>Count now</span>
        <Stepper value={count} onChange={setCount} min={0} max={300} label="clothes returned" />
      </div>
      {mismatch && (
        <Field label="Why is the count different?" error={!note.trim() ? 'Required when the count does not match' : null}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. 1 shirt still drying, student informed" />
        </Field>
      )}
      {needsPay && (
        <div className="pay-box">
          <b>Collect {rupees(o.amount)}{payFirst ? ' before handing over' : ''}</b>
          <Segmented label="Payment method" value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Cash' }, { value: 'UPI', label: 'UPI' }]} />
          {method === 'UPI' && <>
            <UpiQr amount={o.amount} note={o.order_no} size={180} hint="Mark paid only after you see the payment on the student’s phone or in your UPI app." />
            <input value={ref} onChange={e => setRef(e.target.value)} placeholder="UPI ref / last 4 digits (optional)" aria-label="UPI reference" />
          </>}
        </div>
      )}

      <section className="sign-box" aria-label="Student confirms they received the clothes">
        <h2><Icon name="edit" size={18} />Student confirms they received it{signNeeded ? '' : ' (optional)'}</h2>
        {signNeeded && ways.length > 1 && <Segmented label="How the student confirms" value={how} onChange={setHow} options={ways} />}
        {(how === 'sign' || !signNeeded) && <>
          <p className="sign-sentence">“{pickupSentence(o, Number(count) || 0, mismatch ? note : '')}”</p>
          <SignaturePad key={`${count}|${note}|${how}`} onChange={setSig} />
        </>}
        {signNeeded && how === 'phone' && (
          <p className="sign-or">We ask {o.student_name} to confirm in their Everjoy app: “{pickupSentence(o, Number(count) || 0, mismatch ? note : '')}” The hand-over completes when they tap <b>Yes</b>{needsPay ? `, and the ${rupees(o.amount)} payment is saved then` : ''}.</p>
        )}
        {signNeeded && how === 'override' && (
          <Field label="Why can’t the student confirm?" hint="Saved in the register and the activity log.">
            <input value={why} onChange={e => setWhy(e.target.value)} placeholder="e.g. hand injured; ID card and face checked" maxLength={200} />
          </Field>
        )}
      </section>

      {error && <ErrorNote error={error} />}
      <Button tone="primary" size="lg" block busy={busy} icon={signNeeded && how === 'phone' ? 'phone' : 'check'} disabled={(mismatch && !note.trim()) || !proofOk}>
        {signNeeded && how === 'phone' ? 'Send to the student’s phone' : <>Hand over {plural(Number(count) || 0, 'piece')}{needsPay ? `, ${rupees(o.amount)} received` : ''}</>}
      </Button>
      {onCancel && <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>}
    </form>
  );
}

/** Waiting for the student to tap "Yes, I received it" in their app. Completes by itself. */
function PhoneWait({ o, onDone, onBack }: { o: Order; onDone: (o: Order) => void; onBack: () => void }) {
  const [cur, setCur] = useState<Order>(o);
  const [seen, setSeen] = useState(Date.now());   // when seconds_left was read (the server's clock decides the expiry)
  const [, tick] = useState(0);
  const done = useRef(false);
  const { busy, run } = useAction();
  useEffect(() => {
    let live = true;
    let busyPoll = false;
    const t = setInterval(() => {
      tick(n => n + 1);
      if (busyPoll) return;
      busyPoll = true;
      api<Order>(`/ops/orders/${o.id}`).then(r => {
        if (!live || done.current) return;
        if (r.status === 'DELIVERED') { done.current = true; toast(`${r.order_no} handed over: the student confirmed`); onDone(r); return; }
        setCur(r);
        setSeen(Date.now());
      }).catch(() => {}).finally(() => { busyPoll = false; });
    }, 2500);
    // Leaving this screen (another student, closing the order) withdraws the request, so the student
    // can't confirm later from the hostel while the clothes are still at the counter.
    return () => {
      live = false;
      clearInterval(t);
      if (!done.current) void api(`/ops/orders/${o.id}/handover-request`, { method: 'DELETE' }).catch(() => {});
    };
  }, [o.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const req = cur.handover_request as (Order['handover_request'] & { seconds_left?: number }) | null | undefined;
  const left = req ? Math.max(0, (req.seconds_left ?? 600) - Math.round((Date.now() - seen) / 1000)) : 0;
  const withdraw = async () => { if (await run(() => api(`/ops/orders/${o.id}/handover-request`, { method: 'DELETE' })) !== undefined) { done.current = true; onBack(); } };

  if (req?.status === 'DISPUTED') return (
    <div className="stack">
      <div className="sign-dispute"><Icon name="alert" size={22} /><span><b>{cur.student_name} says something is wrong</b><small>“{req.reason}”. Do not hand over yet. Recount with them; a complaint was opened for the office.</small></span></div>
      <Button block busy={busy} onClick={withdraw}>Back to the hand-over</Button>
    </div>
  );
  if (!req || left === 0) return (
    <div className="stack">
      <p className="warn-line"><Icon name="clock" size={18} />The request to the student’s phone expired or was withdrawn.</p>
      <Button block onClick={onBack}>Back to the hand-over</Button>
    </div>
  );
  return (
    <div className="phone-wait" role="status" aria-live="polite">
      <span className="phone-wait-icon"><Icon name="phone" size={34} /></span>
      <b>Waiting for {cur.student_name} to confirm on their phone</b>
      <p>They see: “{pickupSentence(cur, req.returned_count, req.note)}” and tap <b>Yes, I received it</b>. Keep the clothes until this screen says handed over.</p>
      <small>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</small>
      <Button block tone="plain" busy={busy} onClick={withdraw}>Withdraw and let them sign here instead</Button>
    </div>
  );
}

function ChangeCard({ o, onDone, onCancel }: { o: Order; onDone: (o: Order) => void; onCancel: () => void }) {
  const [tag, setTag] = useState(o.tag_no ?? '');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}/card`, { method: 'PATCH', body: { tagNo: tag } }), 'Card updated');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <div className="card-box">
        <span>Basket card no.</span>
        <CardInput value={tag} onChange={setTag} exceptOrderId={o.id} autoFocus />
      </div>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" block busy={busy}>Save card</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

function FixOrder({ o, onDone, onCancel }: { o: Order; onDone: (o: Order) => void; onCancel: () => void }) {
  const [w, setW] = useState(String(o.weight_kg));
  const [c, setC] = useState(String(o.clothes_count));
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}`, { method: 'PATCH', body: { weightKg: Number(w), clothesCount: Number(c), reason } }), 'Order corrected. The student was told.');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <div className="field-row">
        <Field label="Weight (kg)"><Stepper value={w} onChange={setW} step={0.1} decimals={1} min={o.unit === 'PIECE' ? 0 : 0.1} max={50} label="weight" /></Field>
        <Field label="Clothes"><Stepper value={c} onChange={setC} min={1} max={300} label="clothes" /></Field>
      </div>
      <Field label="Reason"><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Re-weighed, scale was not zeroed" /></Field>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" block busy={busy} disabled={reason.trim().length < 3}>Save correction</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

function ReasonForm({ o, kind, onDone, onCancel }: { o: Order; kind: 'cancel' | 'waive'; onDone: (o: Order) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}/${kind}`, { body: { reason } }), kind === 'cancel' ? `${o.order_no} cancelled` : 'Payment waived');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <p>{kind === 'cancel' ? `Cancel ${o.order_no}? The student is notified and the order no longer counts toward their monthly limit.` : `Waive ${rupees(o.amount)} for ${o.order_no}? This is recorded in the activity log.`}</p>
      <Field label="Reason"><input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
      {error && <ErrorNote error={error} />}
      <Button tone={kind === 'cancel' ? 'danger' : 'primary'} block busy={busy} disabled={reason.trim().length < 3}>{kind === 'cancel' ? 'Cancel order' : 'Waive payment'}</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

function PayForm({ o, onDone, onCancel }: { o: Order; onDone: (o: Order) => void; onCancel: () => void }) {
  const [method, setMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [ref, setRef] = useState('');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}/pay`, { body: { method, ref } }), `${rupees(o.amount)} recorded`);
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <p className="big-amount">{rupees(o.amount)}</p>
      <Segmented label="Payment method" value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Cash' }, { value: 'UPI', label: 'UPI' }]} />
      {method === 'UPI' && <>
        <UpiQr amount={o.amount} note={o.order_no} size={200} hint="Ask the student to scan this. Mark paid only after you see the payment." />
        <Field label="UPI reference (optional)"><input value={ref} onChange={e => setRef(e.target.value)} /></Field>
      </>}
      {error && <ErrorNote error={error} />}
      <Button tone="primary" block busy={busy}>Mark as paid</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

/* ---------------------------------------------------------- student sheet */

export function StudentSheet({ id, close, onChanged, isAdmin, onOpenOrder }: { id: number; close: () => void; onChanged?: () => void; isAdmin: boolean; onOpenOrder: (id: number) => void }) {
  const d = useLoad(() => api<CounterStudent>(`/ops/students/${id}`), [id]);
  const [mode, setMode] = useState<'view' | 'edit' | 'reject' | 'suspend' | 'room-reject'>('view');
  const [temp, setTemp] = useState('');
  const { busy, run } = useAction();
  const done = (s?: CounterStudent) => { if (s) d.set({ ...d.data!, ...s }); setMode('view'); onChanged?.(); };
  const approve = async () => done(await run(() => api<CounterStudent>(`/ops/students/${id}/review`, { body: { decision: 'APPROVE' } }), 'Student approved'));
  const approveRoom = async () => done(await run(() => api<CounterStudent>(`/ops/students/${id}/room-change`, { body: { decision: 'APPROVE' } }), 'Room change approved'));
  const reactivate = async () => done(await run(() => api<CounterStudent>(`/ops/students/${id}/status`, { body: { status: 'ACTIVE' } }), 'Account active again'));
  const reset = async () => {
    if (!window.confirm('Give this student a new temporary password? Their old password stops working.')) return;
    const r = await run(() => api<{ tempPassword: string }>(`/ops/students/${id}/reset-password`, { method: 'POST' }));
    if (r) setTemp(r.tempPassword);
  };
  const s = d.data;
  return (
    <Sheet title={s ? s.name : 'Student'} onClose={close} size="md">
      {!s ? (d.error ? <ErrorNote error={d.error} retry={d.reload} /> : <Loading />) : mode === 'edit' ? (
        <EditStudent s={s} isAdmin={isAdmin} onDone={done} onCancel={() => setMode('view')} />
      ) : mode === 'room-reject' ? (
        <RoomReject s={s} onDone={done} onCancel={() => setMode('view')} />
      ) : mode === 'reject' || mode === 'suspend' ? (
        <StudentReason s={s} kind={mode} onDone={done} onCancel={() => setMode('view')} />
      ) : (
        <div className="stack">
          <StudentPhoto s={s} onChanged={n => done({ ...s, ...n })} />
          <StudentFacts s={s} />
          {s.status === 'PENDING' && (
            <div className="approve-box">
              <p>Check this ID card no. and name on the university portal, and look at the student’s physical ID card.</p>
              <div className="btn-pair">
                <Button tone="good" size="lg" icon="check" busy={busy} onClick={approve}>Approve</Button>
                <Button tone="danger" size="lg" icon="x" onClick={() => setMode('reject')}>Reject</Button>
              </div>
            </div>
          )}
          {s.pending_hostel_id && (
            <div className="approve-box">
              <p><b>Wants to move</b> from {s.hostel_name}, room {s.room_no} to <b>{s.pending_hostel_name}, room {s.pending_room_no}</b>{s.change_requested_at ? ` (asked ${ago(s.change_requested_at)})` : ''}. Check the hostel allotment list before approving.</p>
              <div className="btn-pair">
                <Button tone="good" icon="check" busy={busy} onClick={approveRoom}>Approve move</Button>
                <Button tone="danger" icon="x" onClick={() => setMode('room-reject')}>Not approved</Button>
              </div>
            </div>
          )}
          {s.review_note && s.status !== 'ACTIVE' && <p className="note-line bad"><Icon name="alert" size={16} />{s.review_note}</p>}
          {temp && (
            <div className="temp-pass" role="status">
              <span>Temporary password</span>
              <b>{temp}</b>
              <small>Tell the student. They will choose a new one after signing in. It is shown only once.</small>
            </div>
          )}
          <div className="minor-actions">
            <Button size="sm" icon="edit" onClick={() => setMode('edit')}>Edit details</Button>
            <Button size="sm" icon="lock" busy={busy} onClick={reset}>Reset password</Button>
            {isAdmin && s.status === 'ACTIVE' && <Button size="sm" tone="danger" onClick={() => setMode('suspend')}>Put on hold</Button>}
            {isAdmin && (s.status === 'SUSPENDED' || s.status === 'REJECTED') && <Button size="sm" onClick={reactivate}>Make active</Button>}
          </div>
          <h3 className="sub">Orders</h3>
          {s.orders?.length ? (
            <ul className="mini-orders">
              {s.orders.map(o => (
                <li key={o.id}><button onClick={() => onOpenOrder(o.id)}>
                  <b>{o.order_no}</b><span>{when(o.received_at, 'date')}, {o.clothes_count} clothes, {kg(o.weight_kg)}</span><StatusPill status={o.status} late={o.late} />
                </button></li>
              ))}
            </ul>
          ) : <p className="muted">No orders yet.</p>}
        </div>
      )}
    </Sheet>
  );
}

export function StudentFacts({ s }: { s: CounterStudent }) {
  const label: Record<string, string> = { ACTIVE: 'Approved', PENDING: 'Waiting for approval', REJECTED: 'Rejected', SUSPENDED: 'On hold' };
  return (
    <dl className="facts">
      <div><dt>ID card no.</dt><dd className="big">{s.id_card_no}</dd></div>
      <div><dt>Account</dt><dd>{s.left_at ? <span className="pill acc-suspended">Left hostel</span> : <span className={`pill acc-${s.status.toLowerCase()}`}>{label[s.status]}</span>}</dd></div>
      <div><dt>Hostel</dt><dd>{s.kind === 'WALKIN' ? 'Walk-in customer' : <>{s.hostel_name}, room {s.room_no}</>}</dd></div>
      <div><dt>Hostel plan</dt><dd>{s.plan.hosteler ? (planPeriod(s.valid_from, s.valid_until) || 'Valid') : <span className="pill pay-due">Normal prices</span>}<small>{s.plan.label}</small></dd></div>
      <div><dt>Mobile</dt><dd><a href={`tel:${s.mobile}`}>{s.mobile}</a></dd></div>
      {s.kind !== 'WALKIN' && <div><dt>University email</dt><dd>{s.email ? <>{s.email}<small>{s.email_verified_at ? 'Confirmed with a code' : 'Not confirmed yet'}</small></> : <span className="muted">Not given</span>}</dd></div>}
      <div><dt>This month</dt><dd>{plural(s.usage.orders, 'order')}, {kg(s.usage.kg)}{s.usage.kg_limit ? <small>{kg(s.usage.kg_left)} left of {kg(s.usage.kg_limit)}</small> : null}</dd></div>
      <div><dt>Registered</dt><dd>{when(s.created_at, 'date')}{s.reviewed_by_name ? <small>Checked by {s.reviewed_by_name}</small> : null}</dd></div>
    </dl>
  );
}

function EditStudent({ s, isAdmin, onDone, onCancel }: { s: CounterStudent; isAdmin: boolean; onDone: (s: CounterStudent) => void; onCancel: () => void }) {
  const hostels = useLoad(() => api<{ hostels: Hostel[] }>('/public/info'), []);
  void isAdmin;
  const [f, setF] = useState<Record<string, string>>({ name: s.name, idCardNo: s.id_card_no, mobile: s.mobile, hostelId: String(s.hostel_id), roomNo: s.room_no,
    validFrom: s.valid_from ?? '', validUntil: s.valid_until ?? '', email: s.email ?? '' });
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<CounterStudent>(`/ops/students/${s.id}`, { method: 'PATCH', body: f }), 'Details saved');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <Field label="Full name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="ID card no."><input value={f.idCardNo} onChange={e => setF({ ...f, idCardNo: e.target.value })} autoCapitalize="characters" /></Field>
      <Field label="Mobile"><input value={f.mobile} onChange={e => setF({ ...f, mobile: e.target.value })} inputMode="tel" /></Field>
      <div className="field-row">
        <Field label="Hostel">
          <select value={f.hostelId} onChange={e => setF({ ...f, hostelId: e.target.value })}>
            {(hostels.data?.hostels ?? [{ id: s.hostel_id, name: s.hostel_name }]).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
        <Field label="Room no."><input value={f.roomNo} onChange={e => setF({ ...f, roomNo: e.target.value })} /></Field>
      </div>
      {s.kind !== 'WALKIN' && <>
        <Field label="University email" hint="Sign-in codes go here. Changing it signs the student out on all phones."><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} inputMode="email" autoCapitalize="none" /></Field>
        <fieldset className="plan-fields">
          <legend>Hostel plan (semester)</legend>
          <SemesterChips from={f.validFrom} until={f.validUntil} onPick={(from, until) => setF({ ...f, validFrom: from, validUntil: until })} />
          <div className="field-row">
            <Field label="From"><input type="date" value={f.validFrom} onChange={e => setF({ ...f, validFrom: e.target.value })} /></Field>
            <Field label="Till"><input type="date" value={f.validUntil} onChange={e => setF({ ...f, validUntil: e.target.value })} /></Field>
          </div>
          <p className="muted small">Outside these dates the student pays normal prices. Leave both empty for no dates.</p>
        </fieldset>
      </>}
      {error && <ErrorNote error={error} />}
      <Button tone="primary" block busy={busy}>Save details</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

function RoomReject({ s, onDone, onCancel }: { s: CounterStudent; onDone: (s: CounterStudent) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<CounterStudent>(`/ops/students/${s.id}/room-change`, { body: { decision: 'REJECT', note } }), 'The student was told');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <p>{s.name} stays in {s.hostel_name}, room {s.room_no}.</p>
      <Field label="Why not?" hint="The student sees this message"><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Room 512 is not on the allotment list" autoFocus /></Field>
      {error && <ErrorNote error={error} />}
      <Button tone="danger" block busy={busy} disabled={note.trim().length < 3}>Keep the old room</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

function StudentReason({ s, kind, onDone, onCancel }: { s: CounterStudent; kind: 'reject' | 'suspend'; onDone: (s: CounterStudent) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const { busy, error, submit } = useFormAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => kind === 'reject'
      ? api<CounterStudent>(`/ops/students/${s.id}/review`, { body: { decision: 'REJECT', note } })
      : api<CounterStudent>(`/ops/students/${s.id}/status`, { body: { status: 'SUSPENDED', note } }), kind === 'reject' ? 'Registration rejected. The student can fix and resubmit.' : 'Account put on hold');
    if (r) onDone(r);
  };
  return (
    <form className="stack" onSubmit={save}>
      <Field label={kind === 'reject' ? 'What is wrong?' : 'Reason for hold'} hint="The student sees this message">
        <input value={note} onChange={e => setNote(e.target.value)} placeholder={kind === 'reject' ? 'e.g. ID no. not found on the portal' : 'e.g. Unpaid dues'} autoFocus />
      </Field>
      {error && <ErrorNote error={error} />}
      <Button tone="danger" block busy={busy} disabled={!note.trim()}>{kind === 'reject' ? 'Reject registration' : 'Put on hold'}</Button>
      <Button tone="plain" block type="button" onClick={onCancel}>Back</Button>
    </form>
  );
}

/* ------------------------------------------------------------- complaints */

export function ComplaintsBoard({ onOpenOrder }: { onOpenOrder: (id: number) => void }) {
  const [filter, setFilter] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useLoad(() => api<{ rows: Complaint[] }>(`/ops/complaints?status=${filter}`), [filter], { every: 60_000 });
  return (
    <div className="stack">
      <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: 'OPEN', label: 'Open' }, { value: 'RESOLVED', label: 'Resolved' }]} />
      {!list.data ? (list.error ? <ErrorNote error={list.error} retry={list.reload} /> : <Loading />) : !list.data.rows.length
        ? <Empty icon="check" title={filter === 'OPEN' ? 'No open complaints' : 'Nothing resolved yet'}>{filter === 'OPEN' ? 'When a student reports a problem it shows up here.' : ''}</Empty>
        : (
          <ul className="complaint-list">
            {list.data.rows.map(c => (
              <li key={c.id}><button onClick={() => setOpenId(c.id)}>
                <span className="cl-top"><b>{c.category}</b><span className={`pill cs-${c.status.toLowerCase()}`}>{c.status === 'IN_PROGRESS' ? 'Checking' : c.status === 'OPEN' ? 'New' : 'Resolved'}</span></span>
                <span className="cl-desc">{c.description}</span>
                <small>{c.student_name}, room {c.room_no}{c.order_no ? `, ${c.order_no}` : ''}, {ago(c.updated_at)}</small>
              </button></li>
            ))}
          </ul>
        )}
      {openId && <ComplaintSheet id={openId} close={() => setOpenId(null)} onChanged={list.reload} onOpenOrder={onOpenOrder} />}
    </div>
  );
}

function ComplaintSheet({ id, close, onChanged, onOpenOrder }: { id: number; close: () => void; onChanged: () => void; onOpenOrder: (id: number) => void }) {
  const d = useLoad(() => api<Complaint>(`/ops/complaints/${id}`), [id]);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Complaint['status'] | ''>('');
  const { busy, error, submit } = useFormAction();
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const r = await submit(() => api<Complaint>(`/ops/complaints/${id}/update`, { body: { message, ...(status ? { status } : {}) } }), 'Reply sent to the student');
    if (r) { d.set(r); setMessage(''); setStatus(''); onChanged(); }
  };
  const c = d.data;
  return (
    <Sheet title={c ? c.category : 'Complaint'} onClose={close}>
      {!c ? <Loading /> : (
        <div className="stack">
          <div className="student-line"><span className="avatar" aria-hidden="true">{c.student_name.split(' ').map(x => x[0]).slice(0, 2).join('')}</span>
            <span><b>{c.student_name}</b><small>ID {c.id_card_no}, {c.hostel_name}, room {c.room_no}</small></span>
            {c.mobile && <a className="icon-btn" href={`tel:${c.mobile}`} aria-label="Call student"><Icon name="phone" /></a>}
          </div>
          <p className="complaint-text">{c.description}</p>
          {c.order_id && <Button size="sm" icon="tag" onClick={() => onOpenOrder(c.order_id!)}>Open {c.order_no}</Button>}
          {c.photo && <Photo name={c.photo} alt="Photo from the student" />}
          <ol className="timeline">
            {c.updates?.map((u, i) => <li key={i}><b>{u.by_role === 'STUDENT' ? (u.status === 'OPEN' ? 'Raised by student' : 'Student') : u.by_name}</b>{u.message && <span>{u.message}</span>}{u.status && u.by_role !== 'STUDENT' && <span>Status: {u.status.replace('_', ' ').toLowerCase()}</span>}<small>{when(u.at, 'short')}</small></li>)}
          </ol>
          <form className="stack reply" onSubmit={send}>
            <Field label="Reply to student"><textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="e.g. We found the shirt. Collect it from the counter." /></Field>
            <Segmented label="Status" value={(status || c.status) as Complaint['status']} onChange={setStatus} options={[{ value: 'OPEN', label: 'New' }, { value: 'IN_PROGRESS', label: 'Checking' }, { value: 'RESOLVED', label: 'Resolved' }]} />
            {error && <ErrorNote error={error} />}
            <Button tone="primary" block busy={busy} disabled={!message.trim() && (!status || status === c.status)}>Send</Button>
          </form>
        </div>
      )}
    </Sheet>
  );
}

export const copyText = async (t: string) => { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { /* clipboard blocked */ } };

/** Quick buttons for the January–June and July–December semesters. */
export function SemesterChips({ from, until, onPick }: { from: string; until: string; onPick: (from: string, until: string) => void }) {
  return (
    <div className="semester-chips" role="group" aria-label="Semester">
      {semesterOptions().map(o => (
        <button type="button" key={o.label} className={o.from === from && o.until === until ? 'on' : ''} onClick={() => onPick(o.from, o.until)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * The student's photo at the counter. Staff compare it with the person at drop-off and pickup,
 * and can take a new one (front camera on a phone) or upload one at any time.
 */
function StudentPhoto({ s, onChanged }: { s: CounterStudent; onChanged: (s: CounterStudent) => void }) {
  const { busy, run } = useAction();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const small = await shrinkPhoto(file, 900);
    const form = new FormData();
    form.append('photo', small, 'photo.jpg');
    const r = await run(() => api<CounterStudent>(`/ops/students/${s.id}/photo`, { form }), 'Photo saved');
    if (r) onChanged(r);
  };
  const remove = async () => {
    if (!window.confirm('Remove this photo?')) return;
    const r = await run(() => api<CounterStudent>(`/ops/students/${s.id}/photo`, { method: 'DELETE' }), 'Photo removed');
    if (r) onChanged(r);
  };
  return (
    <div className="photo-row">
      <Avatar name={s.name} photo={s.photo} size={88} />
      <div className="stack">
        {!s.photo && <p className="muted small">No photo yet. Take one so the counter can recognise {s.name.split(' ')[0]} at pickup.</p>}
        <label className={`btn btn-quiet btn-sm${busy ? ' is-busy' : ''}`}>
          <Icon name="camera" size={18} /><span>{s.photo ? 'New photo' : 'Take photo'}</span>
          <input type="file" accept="image/*" capture="user" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {s.photo && <Button size="sm" tone="plain" type="button" onClick={remove}>Remove</Button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ basket card box */

type CardSeriesLite = { prefix: string; suffix: string; from: number; to: number; pad: number };
type CardCheck = { card: string | null; ok: boolean; problem?: string; next_free: string | null };
const cardText = (x: CardSeriesLite, n: number) => `${x.prefix}${String(n).padStart(x.pad, '0')}${x.suffix}`;
const looseText = (v: string) => v.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A full card no. typed or scanned ("a-256", "BLUE 7"): which series and number it is. */
function splitCard(series: CardSeriesLite[], raw: string) {
  const loose = looseText(raw);
  for (let i = 0; i < series.length; i++) {
    const lp = looseText(series[i].prefix), ls = looseText(series[i].suffix);
    const mid = loose.slice(lp.length, loose.length - ls.length);
    if (loose.length > lp.length + ls.length && loose.startsWith(lp) && loose.endsWith(ls) && /^\d{1,9}$/.test(mid)) return { i, n: String(Number(mid)) };
  }
  return null;
}

/**
 * Basket card no. With card series set, staff pick the series and type only the number: the letters and
 * signs are added for them (256 → A256). The server checks live that the card is in the series, not
 * marked lost or damaged, and not on another basket that hasn't been collected; and offers the next free card.
 */
export function CardInput({ value, onChange, exceptOrderId = 0, autoFocus, onState }: {
  value: string; onChange: (card: string) => void; exceptOrderId?: number; autoFocus?: boolean; onState?: (ok: boolean) => void;
}) {
  const conf = useLoad(() => api<{ required: boolean; series: CardSeriesLite[] }>('/ops/cards/series'), []);
  const series = conf.data?.series ?? [];
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState(() => value);
  const [check, setCheck] = useState<CardCheck | null>(null);
  const x = series[Math.min(idx, series.length - 1)];
  // A card already on the order (change card): show it as series + number.
  useEffect(() => {
    if (!series.length || !value) return;
    const hit = splitCard(series, value);
    if (hit) { setIdx(hit.i); setText(hit.n); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conf.data]);
  const card = x && /^\d+$/.test(text) ? cardText(x, Number(text)) : text.trim().toUpperCase();
  useEffect(() => { if (card !== value) onChange(card); }, [card]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!conf.data) return;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ card, except: String(exceptOrderId), ...(x ? { series: String(series.indexOf(x)) } : {}) });
      api<CardCheck>(`/ops/cards/check?${qs}`).then(r => { setCheck(r); onState?.(r.ok); }).catch(() => setCheck(null));
    }, 250);
    return () => clearTimeout(t);
  }, [card, idx, conf.data]);   // eslint-disable-line react-hooks/exhaustive-deps

  const type = (v: string) => {
    if (!x) { setText(v.toUpperCase().replace(/\s/g, '')); return; }
    if (/[^\d\s]/.test(v)) {
      const hit = splitCard(series, v);   // a full card no. typed or scanned
      if (hit) { setIdx(hit.i); setText(hit.n); return; }
    }
    setText(v.replace(/\D/g, '').slice(0, 9));
  };
  const useNext = () => { if (!check?.next_free || !x) return; const hit = splitCard([x], check.next_free); if (hit) setText(hit.n); };
  const tone = !card ? '' : check?.ok ? ' good' : check?.problem ? ' bad' : '';

  return (
    <div className={`card-entry-wrap${tone}`}>
      {series.length > 1 && (
        <div className="card-series-pick" role="radiogroup" aria-label="Card series">
          {series.map((s, i) => (
            <button key={i} type="button" role="radio" aria-checked={i === idx} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
              {cardText(s, s.from)} – {cardText(s, s.to)}
            </button>
          ))}
        </div>
      )}
      {x ? (
        <div className="card-entry">
          {x.prefix && <span className="card-affix">{x.prefix}</span>}
          <input value={text} onChange={e => type(e.target.value)} inputMode="numeric" placeholder={String(x.from).padStart(x.pad, '0')} autoComplete="off" spellCheck={false}
            aria-label={`Basket card no., ${cardText(x, x.from)} to ${cardText(x, x.to)}`} autoFocus={autoFocus} />
          {x.suffix && <span className="card-affix">{x.suffix}</span>}
        </div>
      ) : (
        <div className="card-entry">
          <input value={text} onChange={e => type(e.target.value)} placeholder="A1002" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={40} aria-label="Basket card no." autoFocus={autoFocus} />
        </div>
      )}
      <div className="card-status" aria-live="polite">
        {!card ? <span className="muted">{x ? `Type the number on the card (${cardText(x, x.from)} – ${cardText(x, x.to)}).` : 'Type the no. on the card hung on this basket.'}</span>
          : check?.ok ? <span className="ok"><Icon name="check" size={16} />Card <b>{check.card}</b> is free.</span>
          : check?.problem ? <span className="bad"><Icon name="alert" size={16} />{check.problem}</span>
          : <span className="muted">Checking {card}…</span>}
        {x && check?.next_free && check.next_free !== check.card && (
          <button type="button" className="next-free" onClick={useNext}>Next free card: <b>{check.next_free}</b></button>
        )}
        {x && check && !check.next_free && <span className="bad">Every card in this series is in use or marked not usable.</span>}
      </div>
    </div>
  );
}
