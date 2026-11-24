import { ButtonHTMLAttributes, ReactNode, Ref, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { api, blobUrl, fileObjectUrl, type Order, type OrderStatus, type PaymentInfo } from './api';
import { isApp } from './platform';
import { useToasts } from './lib';

/* ------------------------------------------------------------------ icons */

const paths = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  next: 'm9 18 6-6-6-6',
  back: 'm15 18-6-6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  shirt: 'M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chart: 'M3 3v18h18M7 16v-5M12 16V7M17 16v-3',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  megaphone: 'm3 11 18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  menu: 'M3 6h18M3 12h18M3 18h18',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  tag: 'M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4zM7.5 7.5h.01',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  building: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v8h4M18 9h2a2 2 0 0 1 2 2v11h-4M10 6h4M10 10h4M10 14h4M10 18h4',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  card: 'M16 10h2M16 14h2M6.17 15a3 3 0 0 1 5.66 0M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4',
  washer: 'M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM7 5h.01M10 5h.01',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  rupee: 'M6 3h12M6 8h12M6 13l8.5 8M6 13h3c6.67 0 6.67-10 0-10',
  swap: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/* ---------------------------------------------------------------- buttons */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; tone?: 'primary' | 'quiet' | 'danger' | 'plain' | 'good'; size?: 'sm' | 'md' | 'lg'; busy?: boolean; icon?: IconName; block?: boolean };
export function Button({ tone = 'quiet', size = 'md', busy, icon, block, className = '', children, disabled, ...rest }: BtnProps) {
  return (
    <button {...rest} disabled={disabled || busy} className={`btn btn-${tone} btn-${size}${block ? ' btn-block' : ''} ${className}`} aria-busy={busy || undefined}>
      {busy ? <span className="spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'lg' ? 22 : 18} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, badge, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; badge?: number }) {
  return (
    <button {...rest} className={`icon-btn ${rest.className ?? ''}`} aria-label={label} title={label}>
      <Icon name={icon} />
      {!!badge && <span className="dot-badge">{badge > 9 ? '9+' : badge}</span>}
    </button>
  );
}

/* ----------------------------------------------------------------- fields */

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${error ? 'has-error' : ''} ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Stepper({ value, onChange, min = 0, max = 999, step = 1, label, decimals = 0 }: { value: string; onChange: (v: string) => void; min?: number; max?: number; step?: number; label: string; decimals?: number }) {
  const n = Number(value) || 0;
  const set = (v: number) => onChange(String(Math.min(max, Math.max(min, Number(v.toFixed(decimals))))));
  return (
    <div className="stepper">
      <button type="button" onClick={() => set(n - step)} aria-label={`Less ${label}`} disabled={n <= min}><Icon name="minus" /></button>
      <input inputMode={decimals ? 'decimal' : 'numeric'} value={value} onChange={e => onChange(e.target.value.replace(decimals ? /[^\d.]/g : /\D/g, ''))} aria-label={label} onFocus={e => e.target.select()} />
      <button type="button" onClick={() => set(n + step)} aria-label={`More ${label}`} disabled={n >= max}><Icon name="plus" /></button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value} disabled={o.disabled} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch-row">
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

/* --------------------------------------------------------------- statuses */

export const STATUS_LABEL: Record<OrderStatus, string> = { RECEIVED: 'Received', WASHING: 'Washing', READY: 'Ready for pickup', DELIVERED: 'Handed over', CANCELLED: 'Cancelled' };
export function StatusPill({ status, late }: { status: OrderStatus; late?: boolean | number }) {
  return <span className={`pill st-${status.toLowerCase()}${late ? ' st-late' : ''}`}>{late ? 'Late' : STATUS_LABEL[status]}</span>;
}
export function PayPill({ o }: { o: Pick<Order, 'payment_status' | 'amount' | 'paid_method'> }) {
  if (o.payment_status === 'NONE') return null;
  if (o.payment_status === 'DUE') return <span className="pill pay-due">₹{o.amount} due</span>;
  if (o.payment_status === 'WAIVED') return <span className="pill pay-ok">Waived</span>;
  return <span className="pill pay-ok">Paid {o.paid_method === 'UPI' ? 'UPI' : 'cash'}</span>;
}

const FLOW: OrderStatus[] = ['RECEIVED', 'WASHING', 'READY', 'DELIVERED'];
export function Progress({ status }: { status: OrderStatus }) {
  const at = FLOW.indexOf(status);
  return (
    <ol className="progress" aria-label={`Status: ${STATUS_LABEL[status]}`}>
      {['Received', 'Washing', 'Ready', 'Collected'].map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}><span>{s}</span></li>)}
    </ol>
  );
}

/* ------------------------------------------------------------------ sheet */

/** Bottom sheet on phones, centred dialog on wider screens. Escape and the backdrop close it. */
export function Sheet({ title, onClose, children, size = 'md', footer, className = '' }: { title: ReactNode; onClose: () => void; children: ReactNode; size?: 'sm' | 'md' | 'lg'; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    ref.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet sheet-${size} ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={ref}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>,
    document.querySelector('.app-root') ?? document.body,
  );
}

/* ---------------------------------------------------------- feedback bits */

export function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => <div key={t.id} className={`toast toast-${t.tone}`}><Icon name={t.tone === 'ok' ? 'check' : 'alert'} size={18} />{t.text}</div>)}
    </div>
  );
}

export function Empty({ icon = 'shirt', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={30} />
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spin" aria-hidden="true" />{label}…</div>;
}

export function ErrorNote({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="alert" />
      <span>{error}</span>
      {retry && <Button size="sm" onClick={retry}>Try again</Button>}
    </div>
  );
}

/* ------------------------------------------------------------ photos */

/**
 * A private complaint photo. The website can point <img> at the API because the cookie
 * goes along; the app must fetch it with its bearer token and show a temporary blob URL.
 */
export function Photo({ name, alt }: { name: string; alt: string }) {
  const [src, setSrc] = useState(isApp ? '' : `/api/files/${encodeURIComponent(name)}`);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isApp) return;
    let url = '';
    let live = true;
    fileObjectUrl(name).then(u => { url = u; if (live) setSrc(u); else URL.revokeObjectURL(u); }).catch(() => live && setFailed(true));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [name]);
  if (failed) return <p className="muted small">Photo could not be loaded.</p>;
  if (!src) return <div className="complaint-photo placeholder" aria-label="Loading photo" />;
  const img = <img className="complaint-photo" src={src} alt={alt} loading="lazy" />;
  return isApp ? img : <a href={src} target="_blank" rel="noreferrer">{img}</a>;
}

/* ------------------------------------------------------------- QR + scan */

export function QrImage({ text, size = 240, dark = '#1B2A4A' }: { text: string; size?: number; dark?: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: size * 2, errorCorrectionLevel: 'M', color: { dark, light: '#FFFFFF' } }).then(u => live && setSrc(u)).catch(() => {});
    return () => { live = false; };
  }, [text, size, dark]);
  return src ? <img className="qr-img" src={src} width={size} height={size} alt="QR code for this laundry slip" /> : <div className="qr-img" style={{ width: size, height: size }} />;
}

/**
 * Live camera scanner. Reads slip QRs and the common 1-D barcodes printed on
 * university ID cards. Needs HTTPS (or localhost) for camera access.
 */
export function Scanner({ onResult, hint }: { onResult: (text: string) => void; hint: string }) {
  const id = `scan-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [error, setError] = useState('');
  const done = useRef(false);
  const cb = useRef(onResult);
  cb.current = onResult;
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera needs a secure (https) link. Type the number instead.');
      return;
    }
    let stopped = false;
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;
    let started = false;
    // The scanner library is large; load it only when a camera is actually opened.
    import('html5-qrcode').then(({ Html5Qrcode, Html5QrcodeSupportedFormats: F }) => {
      if (stopped) return;
      const s = new Html5Qrcode(id, { formatsToSupport: [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.ITF], verbose: false });
      scanner = s;
      return s.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w: number, h: number) => { const n = Math.floor(Math.min(w, h) * 0.72); return { width: n, height: n }; } },
        text => { if (done.current) return; done.current = true; navigator.vibrate?.(60); cb.current(text); },
        () => {},
      ).then(() => { started = true; if (stopped) void s.stop().then(() => s.clear()).catch(() => {}); });
    }).catch(() => setError('Could not open the camera. Allow camera access, or type the number instead.'));
    return () => {
      stopped = true;
      const s = scanner;
      if (!s) return;
      (started ? s.stop() : Promise.resolve()).then(() => s.clear()).catch(() => {});
    };
  }, [id]);
  return (
    <div className="scanner">
      <div id={id} className={`scanner-view${error ? ' failed' : ''}`} />
      <p className={error ? 'scanner-error' : 'scanner-hint'}>{error || hint}</p>
    </div>
  );
}

/* ------------------------------------------------------------------- UPI */

let payInfo: { p: Promise<PaymentInfo>; at: number } | null = null;
/** Forget the cached UPI details (after the admin uploads or removes the QR). */
export const invalidatePaymentInfo = () => { payInfo = null; };
/** UPI details change rarely: share one copy between components for up to a minute. */
export function usePaymentInfo() {
  const [info, setInfo] = useState<PaymentInfo | null>(null);
  useEffect(() => {
    let live = true;
    if (!payInfo || Date.now() - payInfo.at > 60_000) {
      const p = api<PaymentInfo>('/payment-info');
      payInfo = { p, at: Date.now() };
      p.catch(() => { if (payInfo?.p === p) payInfo = null; });
    }
    payInfo.p.then(i => live && setInfo(i)).catch(() => {});
    return () => { live = false; };
  }, []);
  return info;
}

/**
 * The QR a student scans with GPay / PhonePe / Paytm. The admin's uploaded QR image is shown if there
 * is one; otherwise a QR is drawn from the UPI ID with the amount filled in.
 */
export function UpiQr({ amount, note, size = 200, showButton, hint }: { amount: number; note?: string; size?: number; showButton?: boolean; hint?: string }) {
  const info = usePaymentInfo();
  const [img, setImg] = useState('');
  useEffect(() => {
    if (!info?.has_upi_qr) return;
    let url = '';
    let live = true;
    blobUrl('/upi-qr').then(u => { url = u; if (live) setImg(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [info?.has_upi_qr]);
  if (!info) return null;
  if (!info.has_upi_qr && !info.upi_id) return <p className="muted small">UPI is not set up yet. Take cash, or ask the admin to add the UPI QR.</p>;
  const link = info.upi_id ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.upi_name || 'Everjoy Lawndry')}&am=${amount}&cu=INR${note ? `&tn=${encodeURIComponent(note)}` : ''}` : '';
  return (
    <div className="upi-qr">
      {info.has_upi_qr
        ? (img ? <img className="qr-img" src={img} width={size} height={size} alt="UPI QR code of the laundry" /> : <div className="qr-img" style={{ width: size, height: size }} />)
        : <QrImage text={link} size={size} dark="#111111" />}
      <p><b>Pay ₹{amount}</b>{info.upi_id ? <> to {info.upi_id}</> : null}{info.has_upi_qr ? <small>Enter the amount in your UPI app</small> : null}</p>
      {showButton && link && <a className="btn btn-primary btn-md" href={link}><Icon name="rupee" size={18} /><span>Open UPI app</span></a>}
      {hint && <small className="upi-hint">{hint}</small>}
    </div>
  );
}

/* ------------------------------------------------------------------ brand */

export function Brand({ sub }: { sub?: string }) {
  return (
    <span className="brand">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M9 3h14l6 6v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" fill="currentColor" opacity=".16" />
        <path d="M9 3h14l6 6v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="16" cy="9.5" r="2.4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 18c2-1.6 4-1.6 6 0s4 1.6 6 0M10 23c2-1.6 4-1.6 6 0s4 1.6 6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="brand-word">Everjoy<b>Lawndry</b></span>
      {sub && <span className="brand-sub">{sub}</span>}
    </span>
  );
}
