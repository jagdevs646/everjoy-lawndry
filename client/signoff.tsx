/**
 * Two-sided register on screen. When staff take an order or hand clothes back, the student's app shows a
 * pop-up with what they confirm and a 6-digit code that changes every 30 seconds; staff type that code
 * here. This file has the counter's code box, the code the student's phone makes, and the record of
 * what the student confirmed.
 */
import { useEffect, useRef, useState } from 'react';
import { api, fileObjectUrl, type ConfirmKind, type Order, type Signoff } from './api';
import { kg, serverNow, useFormAction, when } from './lib';
import { isApp } from './platform';
import { Button, ErrorNote, Icon } from './ui';

/* ------------------------------------------------------------ sign rules */

type SignRules = { sign_dropoff: boolean; sign_pickup: boolean };
/** The admin's choice: does the student have to confirm drop-off and pickup? Read fresh each time a screen opens. */
export function useSignRules() {
  const [r, setR] = useState<SignRules>({ sign_dropoff: true, sign_pickup: true });
  useEffect(() => {
    let live = true;
    api<SignRules>('/ops/sign-rules').then(x => live && setR(x)).catch(() => {});
    return () => { live = false; };
  }, []);
  return r;
}

export const CONFIRMED_ACKS = ['CODE', 'COUNTER', 'SIGNATURE', 'PHONE'];
export const isConfirmed = (ack?: string | null) => !!ack && CONFIRMED_ACKS.includes(ack);

/* ------------------------------------------------- the code on the student's phone */

/**
 * The 6-digit code for this request, made on the phone from the key the server sent (the same HMAC the
 * server checks). Changes every 30 seconds, by the server's clock.
 */
export function useRotatingCode(key: string, orderId: number, kind: ConfirmKind, stepSeconds = 30) {
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(stepSeconds);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) { setFailed(true); return; }
    let live = true;
    let shown = -1;
    let timer = 0;
    const enc = new TextEncoder();
    subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(k => {
      const tick = async () => {
        const now = serverNow() / 1000;
        if (live) setLeft(stepSeconds - Math.floor(now % stepSeconds));
        const step = Math.floor(now / stepSeconds);
        if (step === shown) return;
        shown = step;
        const sig = await subtle.sign('HMAC', k, enc.encode(`code.${orderId}.${kind}.${step}`));
        const n = new DataView(sig).getUint32(0) % 1_000_000;
        if (live) setCode(String(n).padStart(6, '0'));
      };
      void tick();
      timer = window.setInterval(() => void tick(), 1000);
    }).catch(() => live && setFailed(true));
    return () => { live = false; window.clearInterval(timer); };
  }, [key, orderId, kind, stepSeconds]);
  return { code, left, failed };
}

/* ------------------------------------------------- what the student agrees to */

type Who = Pick<Order, 'student_name' | 'id_card_no' | 'order_no' | 'clothes_count' | 'weight_kg' | 'service_name' | 'tag_no'>;
export function dropoffSentence(o: Who) {
  const w = Number(o.weight_kg) > 0 ? ` (${kg(o.weight_kg)})` : '';
  return `I, ${o.student_name} (ID ${o.id_card_no}), gave ${o.clothes_count} clothes${w} for ${o.service_name || 'Wash & fold'}, order ${o.order_no}${o.tag_no ? `, basket card ${o.tag_no}` : ''}.`;
}
export function pickupSentence(o: Who, returned: number, note?: string | null) {
  return `I, ${o.student_name} (ID ${o.id_card_no}), received ${returned} of the ${o.clothes_count} clothes I gave for order ${o.order_no}${o.tag_no ? `, basket card ${o.tag_no}` : ''}.${note?.trim() ? ` Staff note: ${note.trim()}` : ''}`;
}

const HOW: Record<string, string> = {
  CODE: 'Confirmed with the student’s code', COUNTER: 'Walk-in, confirmed at the counter', SIGNATURE: 'Signed at the counter',
  PHONE: 'Confirmed on their phone', OVERRIDE: 'Handed over by the admin without the code', DISPUTED: 'Disputed by the student',
};
export const ackLabel = (ack?: string | null, kind?: 'DROPOFF' | 'PICKUP') =>
  (ack === 'OVERRIDE' && kind === 'DROPOFF' ? 'Counted as received by the admin without the code' : ack ? HOW[ack] ?? ack : 'Not confirmed yet');

/* ---------------------------------------------------- counter: type the code */

/**
 * Staff type the code the student reads from their phone. Sends the student a new code when none is
 * waiting (or `start` asks to). For pickup, `start` holds the counted clothes and payment.
 */
export function CodeEntry({ o, kind, start, onDone, onBack, autoStart }: {
  o: Order; kind: ConfirmKind; start?: { returnedCount: number; note: string; payMethod?: 'CASH' | 'UPI'; payRef?: string };
  onDone: (o: Order) => void; onBack?: () => void; autoStart?: boolean;
}) {
  const [cur, setCur] = useState<Order>(o);
  const [code, setCode] = useState('');
  const [seen, setSeen] = useState(Date.now());
  const [, tick] = useState(0);
  const sending = useFormAction();
  const checking = useFormAction();
  const done = useRef(false);
  const req = cur.confirm_requests?.find(r => r.kind === kind);
  const input = useRef<HTMLInputElement>(null);

  const send = async () => {
    const r = await sending.submit(() => api<Order>(`/ops/orders/${o.id}/confirm-request`, { body: { kind, ...(start ?? {}) } }));
    if (r) { setCur(r); setSeen(Date.now()); setCode(''); input.current?.focus(); }
  };
  useEffect(() => { if (autoStart && !req) void send(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // Watch for "something is wrong" from the student, and the request expiring.
  useEffect(() => {
    let live = true;
    let busy = false;
    const t = setInterval(() => {
      tick(n => n + 1);
      if (busy) return;
      busy = true;
      api<Order>(`/ops/orders/${o.id}`).then(r => { if (live && !done.current) { setCur(r); setSeen(Date.now()); } }).catch(() => {}).finally(() => { busy = false; });
    }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [o.id]);
  const confirm = async (value = code) => {
    if (value.length !== 6) return;
    const r = await checking.submit(() => api<Order>(`/ops/orders/${o.id}/confirm`, { body: { kind, code: value } }), kind === 'DROPOFF' ? 'Drop-off confirmed by the student' : `${o.order_no} handed over`);
    if (r) { done.current = true; onDone(r); } else { setCode(''); input.current?.focus(); void api<Order>(`/ops/orders/${o.id}`).then(setCur).catch(() => {}); }
  };
  const left = req ? Math.max(0, (req.seconds_left ?? 600) - Math.round((Date.now() - seen) / 1000)) : 0;
  const sentence = kind === 'DROPOFF' ? dropoffSentence(cur) : pickupSentence(cur, req?.returned_count ?? start?.returnedCount ?? cur.clothes_count, req?.note ?? start?.note);

  return (
    <section className="code-box" aria-label={kind === 'DROPOFF' ? 'Student confirms the drop-off' : 'Student confirms they received the clothes'}>
      <h2><Icon name="lock" size={18} />{kind === 'DROPOFF' ? 'Student confirms the drop-off' : 'Student confirms they received it'}</h2>
      <p className="code-sentence">“{sentence}”</p>
      {req?.status === 'DISPUTED' ? (
        <div className="code-dispute"><Icon name="alert" size={22} /><span><b>{cur.student_name} says something is wrong</b><small>“{req.reason}”. {kind === 'PICKUP' ? 'Do not hand over yet. ' : ''}Sort it out together (a complaint was opened), then send a new code.</small></span></div>
      ) : req && left > 0 ? (
        <>
          <p className="code-ask"><span className="live-dot" />A code is on <b>{cur.student_name}</b>’s phone. Ask them to read it out.</p>
          <form className="code-form" onSubmit={e => { e.preventDefault(); void confirm(); }}>
            <input ref={input} className="code-input" value={code} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) void confirm(v); }}
              inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" aria-label="Code from the student’s phone" autoFocus maxLength={6} />
            <Button tone="primary" size="lg" busy={checking.busy} disabled={code.length !== 6} icon="check">{kind === 'DROPOFF' ? 'Confirm' : 'Confirm and hand over'}</Button>
          </form>
          {checking.error && <ErrorNote error={checking.error} />}
          <small className="code-left">Request open for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.</small>
        </>
      ) : (
        <p className="code-ask muted">{sending.busy ? 'Sending a code to the student’s phone…' : 'No code is waiting. Send one to the student’s phone.'}</p>
      )}
      {sending.error && <ErrorNote error={sending.error} />}
      <div className="code-actions">
        <Button type="button" tone="plain" busy={sending.busy} icon="phone" onClick={send}>{req ? 'Send a new code' : 'Send the code'}</Button>
        {onBack && <Button type="button" tone="plain" onClick={onBack}>Back</Button>}
      </div>
    </section>
  );
}

/* -------------------------------------------------- the record (staff, student) */

/** A stored signature image from older records. */
export function SignatureImage({ name }: { name: string }) {
  const [src, setSrc] = useState(isApp ? '' : `/api/files/${encodeURIComponent(name)}`);
  useEffect(() => {
    if (!isApp) return;
    let url = '';
    let live = true;
    fileObjectUrl(name).then(u => { url = u; if (live) setSrc(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [name]);
  return src ? <img className="sig-img" src={src} alt="Student's signature" loading="lazy" /> : <span className="sig-img placeholder" />;
}

/** What the student confirmed for an order: drop-off and collection, with the evidence. */
export function SignoffRecord({ o, showEvidence }: { o: Order; showEvidence?: boolean }) {
  const list = (o.signoffs ?? []) as Signoff[];
  const row = (kind: 'DROPOFF' | 'PICKUP', ack: string | null | undefined, at: string | null | undefined) => {
    const s = list.find(x => x.kind === kind && !x.superseded_at);
    const tone = !ack ? 'wait' : ack === 'DISPUTED' ? 'bad' : ack === 'OVERRIDE' ? 'warn' : 'ok';
    return (
      <div className={`signoff-row ${tone}`}>
        <div className="signoff-head">
          <Icon name={tone === 'ok' ? 'check' : tone === 'wait' ? 'clock' : 'alert'} size={18} />
          <b>{kind === 'DROPOFF' ? 'Drop-off' : 'Collection'}</b>
          <span>{ackLabel(ack, kind)}{at ? `, ${when(at, 'short')}` : ''}</span>
        </div>
        {s && <p className="signoff-statement">“{s.statement}”</p>}
        {s?.reason && <p className={`signoff-reason${s.status === 'DISPUTED' ? ' bad' : ''}`}>{s.status === 'DISPUTED' ? 'Student says: ' : 'Reason: '}{s.reason}</p>}
        {s?.signature && <SignatureImage name={s.signature} />}
        {s && showEvidence && (
          <small className="signoff-evidence">{s.staff_name ? `At the counter: ${s.staff_name}. ` : ''}Fingerprint {String(s.proof_hash ?? '').slice(0, 16)}…</small>
        )}
      </div>
    );
  };
  return (
    <div className="signoff-record">
      {row('DROPOFF', o.dropoff_ack, o.dropoff_ack_at)}
      {(o.status === 'DELIVERED' || o.pickup_ack) && row('PICKUP', o.pickup_ack, o.pickup_ack_at)}
    </div>
  );
}
