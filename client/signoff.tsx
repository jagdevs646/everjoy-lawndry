/**
 * Two-sided register on screen: the signature pad the student signs with a finger at the counter,
 * the "student confirms" step at drop-off and pickup, and the record of what the student confirmed.
 */
import { PointerEvent as RPointerEvent, useEffect, useRef, useState } from 'react';
import { api, fileObjectUrl, type Order, type Signoff } from './api';
import { kg, useFormAction, when } from './lib';
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

/* ---------------------------------------------------------- signature pad */

const PAD_W = 640, PAD_H = 240;   // stored image size (small PNG, about 5–20 KB)
const INK = '#13223F';

/**
 * A finger (or mouse) signature, black ink on white like paper. Reports a PNG data URL once there is
 * enough ink to be a signature, and null when cleared.
 */
export function SignaturePad({ onChange, label = 'Sign here with your finger' }: { onChange: (png: string | null) => void; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const pointer = useRef<number | null>(null);   // one finger at a time; a palm or second finger is ignored
  const last = useRef<{ x: number; y: number } | null>(null);
  const ink = useRef(0);
  const [empty, setEmpty] = useState(true);
  const [marked, setMarked] = useState(false);

  const paper = () => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#C9D2E0';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(24, c.height - 46); ctx.lineTo(c.width - 24, c.height - 46); ctx.stroke();   // the line to sign on
  };
  useEffect(() => { paper(); }, []);

  const at = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H };
  };
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (pointer.current !== null) return;
    pointer.current = e.pointerId;
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = at(e);
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current || e.pointerId !== pointer.current) return;
    if (!marked) setMarked(true);
    const p = at(e);
    const ctx = canvas.current!.getContext('2d')!;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ink.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
    last.current = p;
  };
  const up = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || e.pointerId !== pointer.current) return;
    pointer.current = null;
    drawing.current = false;
    last.current = null;
    // A dot or a tiny tick is not a signature.
    if (ink.current >= 120) { setEmpty(false); onChange(canvas.current!.toDataURL('image/png')); }
  };
  const clear = () => { ink.current = 0; setEmpty(true); setMarked(false); paper(); onChange(null); };

  return (
    <div className="sig-pad">
      <canvas ref={canvas} width={PAD_W} height={PAD_H} aria-label={label} role="img"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="sig-pad-bar">
        <span>{!empty ? 'Signed' : marked ? 'Keep going: write the full signature' : label}</span>
        <button type="button" className="link-btn" onClick={clear} disabled={!marked}>Clear</button>
      </div>
    </div>
  );
}

/** A stored signature image (the website loads it directly; the app fetches it with the token). */
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

/* ------------------------------------------------- what the student agrees to */

type Who = Pick<Order, 'student_name' | 'id_card_no' | 'order_no' | 'clothes_count' | 'weight_kg' | 'service_name' | 'tag_no'>;
/** Shown above the pad. The server stores its own copy of this sentence with the signature. */
export function dropoffSentence(o: Who) {
  const w = Number(o.weight_kg) > 0 ? ` (${kg(o.weight_kg)})` : '';
  return `I, ${o.student_name} (ID ${o.id_card_no}), gave ${o.clothes_count} clothes${w} for ${o.service_name || 'Wash & fold'}, order ${o.order_no}${o.tag_no ? `, basket card ${o.tag_no}` : ''}.`;
}
export function pickupSentence(o: Who, returned: number, note?: string | null) {
  return `I, ${o.student_name} (ID ${o.id_card_no}), received ${returned} of the ${o.clothes_count} clothes I gave for order ${o.order_no}${o.tag_no ? `, basket card ${o.tag_no}` : ''}.${note?.trim() ? ` Staff note: ${note.trim()}` : ''}`;
}

const HOW: Record<string, string> = { SIGNATURE: 'Signed at the counter', PHONE: 'Confirmed on their phone', OVERRIDE: 'Handed over by admin without confirmation', DISPUTED: 'Disputed by the student' };
export const ackLabel = (ack?: string | null) => (ack ? HOW[ack] ?? ack : 'Not confirmed yet');

/* ------------------------------------------------------ drop-off at counter */

/**
 * After an order is taken: the student signs on this screen, or confirms in their own app (the screen
 * shows it the moment they do). Staff can move on to the next student at any time.
 */
export function DropoffSign({ o, onSigned, compact }: { o: Order; onSigned?: (o: Order) => void; compact?: boolean }) {
  const [sig, setSig] = useState<string | null>(null);
  const [state, setState] = useState<Order>(o);
  const { busy, error, submit } = useFormAction();
  const confirmed = state.dropoff_ack === 'SIGNATURE' || state.dropoff_ack === 'PHONE';
  const walkIn = o.customer_kind === 'WALKIN';
  // Watch for the student answering in their app, until they do (one request at a time, nothing after leaving).
  useEffect(() => {
    if (confirmed || walkIn) return;
    let live = true;
    let busyPoll = false;
    const t = setInterval(() => {
      if (busyPoll) return;
      busyPoll = true;
      api<Order>(`/ops/orders/${o.id}`).then(r => {
        if (!live || r.dropoff_ack === state.dropoff_ack) return;
        setState(r);
        if (r.dropoff_ack === 'SIGNATURE' || r.dropoff_ack === 'PHONE') onSigned?.(r);
      }).catch(() => {}).finally(() => { busyPoll = false; });
    }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [confirmed, walkIn, o.id, state.dropoff_ack]);   // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!sig) return;
    const r = await submit(() => api<Order>(`/ops/orders/${o.id}/sign`, { body: { signature: sig, clothesCount: state.clothes_count, weightKg: state.weight_kg } }), 'Drop-off signed');
    if (r) { setState(r); onSigned?.(r); }
  };

  if (confirmed) return (
    <div className="sign-done"><Icon name="check" size={22} /><span><b>{ackLabel(state.dropoff_ack)}</b><small>{when(state.dropoff_ack_at, 'short')}. The student confirmed this drop-off.</small></span></div>
  );
  return (
    <section className={`sign-box${compact ? ' compact' : ''}`} aria-label="Student confirms the drop-off">
      {state.dropoff_ack === 'DISPUTED' && (
        <div className="sign-dispute"><Icon name="alert" size={22} /><span><b>The student said something is wrong</b><small>“{state.signoffs?.find(s => s.kind === 'DROPOFF')?.reason}”. Recount together. If the count changes, correct the order; if it was right, the student signs below or confirms in the app.</small></span></div>
      )}
      <h2><Icon name="edit" size={18} />Student signs for the drop-off</h2>
      <p className="sign-sentence">“{dropoffSentence(state)}”</p>
      <SignaturePad onChange={setSig} />
      {error && <ErrorNote error={error} />}
      <Button tone="primary" size="lg" block busy={busy} disabled={!sig} icon="check" onClick={save}>Save signature</Button>
      {!walkIn && <p className="sign-or"><span className="live-dot" />Or the student taps <b>Yes, I gave this</b> in their Everjoy app. This screen updates by itself.</p>}
    </section>
  );
}

/* -------------------------------------------------------- the record (staff) */

/** What the student confirmed for an order: drop-off and collection, with signatures and evidence. */
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
          <span>{ackLabel(ack)}{at ? `, ${when(at, 'short')}` : ''}</span>
        </div>
        {s && <p className="signoff-statement">“{s.statement}”</p>}
        {s?.reason && <p className={`signoff-reason${s.status === 'DISPUTED' ? ' bad' : ''}`}>{s.status === 'DISPUTED' ? 'Student says: ' : 'Reason: '}{s.reason}</p>}
        {s?.signature && <SignatureImage name={s.signature} />}
        {s && showEvidence && (
          <small className="signoff-evidence">
            {s.staff_name ? `At the counter: ${s.staff_name}. ` : ''}{s.ip ? `From ${s.ip}. ` : ''}Fingerprint {String(s.proof_hash ?? '').slice(0, 16)}…
          </small>
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
