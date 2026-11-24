import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, Hostel, OtpStart, SignedIn, User } from './api';
import { go, toast, useFormAction, useLoad, useRoute } from './lib';
import { builtInServer, canChangeServer, isApp, probeServer, serverAddress, setServer } from './platform';
import { Brand, Button, ErrorNote, Field, Icon, Sheet } from './ui';

type Info = { hostels: Hostel[]; max_kg_per_order: number; counter_hours: string; email_codes?: boolean; email_domain?: string };

/**
 * "Check your email": the 6-digit code the server sent to the student's university email.
 * Used after the password on a new phone/browser, when setting up an imported account, and to finish registration.
 */
export function OtpStep({ start, onDone, onBack }: { start: OtpStart; onDone: (r: SignedIn) => void; onBack: () => void }) {
  const [challenge, setChallenge] = useState(start);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(30);
  const { busy, error, setError, submit } = useFormAction();
  const resend = useFormAction();
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait(w => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);
  const verify = async (e?: FormEvent) => {
    e?.preventDefault();
    const r = await submit(() => api<SignedIn>('/auth/otp', { body: { challenge: challenge.challenge, code } }));
    if (r) onDone(r);
  };
  const again = async () => {
    setError('');
    const r = await resend.submit(() => api<OtpStart>('/auth/otp/resend', { body: { challenge: challenge.challenge } }), 'New code sent');
    if (r) { setChallenge(r); setCode(''); setWait(30); }
  };
  const what = start.purpose === 'LOGIN' ? 'This is a new phone or browser for your account.' : start.purpose === 'CLAIM' ? 'Your account was added by the laundry office.' : 'One last step to register.';
  return (
    <form className="auth-card" onSubmit={verify} noValidate>
      <button type="button" className="auth-back" onClick={onBack}><Icon name="back" size={18} />Back</button>
      <h1>Check your email</h1>
      <p className="lede">{what} We sent a 6-digit code to <b>{challenge.email_hint}</b>.</p>
      <Field label="Code from the email" hint="It works for 10 minutes. Check the spam folder too.">
        <input className="otp-input" value={code} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); }}
          inputMode="numeric" autoComplete="one-time-code" autoFocus aria-label="6-digit code" />
      </Field>
      {(error || resend.error) && <ErrorNote error={error || resend.error} />}
      <Button tone="primary" size="lg" block busy={busy} disabled={code.length !== 6}>Continue</Button>
      <Button type="button" tone="plain" block busy={resend.busy} disabled={wait > 0} onClick={again}>{wait > 0 ? `Send a new code in ${wait} s` : 'Send a new code'}</Button>
      <p className="auth-foot">Wrong email or no access to it? Ask at the laundry counter; staff can update your email.</p>
    </form>
  );
}

export function PublicApp({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [page] = useRoute();
  const [serverRev, setServerRev] = useState(0);   // bump to reload after the app's server address changes
  const info = useLoad(() => api<Info>('/public/info'), [serverRev]);
  return (
    <div className="public">
      <aside className="public-art" aria-hidden="true">
        <Brand />
        <div className="demo-tag">
          <span className="demo-tag-hole" />
          <span className="demo-tag-no">EJ-1042</span>
          <span className="demo-tag-line">14 clothes, 4.2 kg</span>
          <span className="demo-tag-line">In: Mon, 10:15 AM</span>
          <span className="demo-tag-qr"><Icon name="qr" size={54} /></span>
        </div>
        <p className="public-pitch">Your laundry slip lives on your phone now. No paper to carry, nothing to lose.</p>
      </aside>
      <main className="public-main">
        <div className="public-brand-mobile"><Brand /></div>
        {isApp && info.error && !info.data && <div className="server-problem"><ErrorNote error={info.error} retry={info.reload} /></div>}
        {page === 'register'
          ? <Register info={info.data} onSignedIn={onSignedIn} />
          : <SignIn onSignedIn={onSignedIn} counterHours={info.data?.counter_hours} />}
        {isApp && canChangeServer && <ServerLine onChanged={() => setServerRev(r => r + 1)} highlight={!!info.error && !info.data} />}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn, counterHours }: { onSignedIn: (u: User) => void; counterHours?: string }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState<OtpStart | null>(null);
  const { busy, error, submit: send } = useFormAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await send(() => api<SignedIn | OtpStart>('/auth/login', { body: { loginId, password } }));
    if (!r) return;
    if ('otp_required' in r) { setOtp(r); return; }
    onSignedIn(r.user);
  };
  if (otp) return <OtpStep start={otp} onDone={r => onSignedIn(r.user)} onBack={() => { setOtp(null); setPassword(''); }} />;
  return (
    <form className="auth-card" onSubmit={submit} noValidate>
      <h1>Sign in</h1>
      <p className="lede">Students use their ID card number. Staff use their username.</p>
      <Field label="ID card no. or username">
        <input value={loginId} onChange={e => setLoginId(e.target.value)} autoComplete="username" autoCapitalize="characters" spellCheck={false} required autoFocus />
      </Field>
      <Field label="Password">
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" size="lg" block busy={busy} disabled={!loginId || !password}>Sign in</Button>
      <p className="auth-alt">New to Everjoy? <a href="#/register">Register with your ID card</a></p>
      <p className="auth-foot">Forgot your password? Ask at the laundry counter{counterHours ? ` (${counterHours})` : ''}. Staff can reset it for you.</p>
    </form>
  );
}

function Register({ info, onSignedIn }: { info?: Info; onSignedIn: (u: User) => void }) {
  const [f, setF] = useState({ idCardNo: '', name: '', mobile: '', email: '', hostelId: '', roomNo: '', password: '', confirm: '', claimCode: '' });
  const [needsCode, setNeedsCode] = useState(false);
  const [otp, setOtp] = useState<OtpStart | null>(null);
  const finish = (r: SignedIn) => { if (r.claimed) toast('Your account is ready. The laundry office already checked your details.'); go(''); onSignedIn(r.user); };
  const { busy, error, setError, submit: send } = useFormAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('The two passwords do not match.');
    const r = await send(() => api<SignedIn | OtpStart>('/auth/signup', { body: f }).catch((err: ApiError) => {
      if (err.details?.code === 'CLAIM_CODE') setNeedsCode(true);
      throw err;
    }));
    if (!r) return;
    if ('otp_required' in r) { setOtp(r); return; }
    finish(r);
  };
  if (otp) return <OtpStep start={otp} onDone={finish} onBack={() => setOtp(null)} />;
  const noHostels = info && info.hostels.length === 0;
  return (
    <form className="auth-card" onSubmit={submit} noValidate>
      <a className="auth-back" href="#/"><Icon name="back" size={18} />Sign in</a>
      <h1>Register</h1>
      <p className="lede">Fill this once. Then show your ID card at the counter and staff will approve you.</p>
      <p className="muted small">Already added by the laundry office? Use the same ID card no. and mobile number they have and choose your password. We email a code to your university email (or enter the claim code the office gave you).</p>
      {noHostels && <ErrorNote error="Registration opens once the laundry office adds the hostel list. Please check back soon." />}
      <Field label="ID card no." hint="Exactly as printed on your university ID card">
        <input value={f.idCardNo} onChange={set('idCardNo')} autoCapitalize="characters" spellCheck={false} autoComplete="username" required />
      </Field>
      <Field label="Full name">
        <input value={f.name} onChange={set('name')} autoComplete="name" autoCapitalize="words" required />
      </Field>
      <Field label="Mobile number">
        <input value={f.mobile} onChange={set('mobile')} inputMode="tel" autoComplete="tel-national" placeholder="10 digits" required />
      </Field>
      <Field label={info?.email_codes ? 'University email' : 'University email (optional)'} hint={`A code is sent here to confirm it's you${info?.email_domain ? `. Must end with @${info.email_domain.replace(/^@/, '')}` : ''}. Added by the office? Leave it empty.`}>
        <input type="email" value={f.email} onChange={set('email')} inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          placeholder={info?.email_domain ? `name@${info.email_domain.replace(/^@/, '')}` : 'name@university.edu'} />
      </Field>
      <div className="field-row">
        <Field label="Hostel">
          <select value={f.hostelId} onChange={set('hostelId')} required>
            <option value="">Choose</option>
            {info?.hostels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
        <Field label="Room no.">
          <input value={f.roomNo} onChange={set('roomNo')} autoCapitalize="characters" required />
        </Field>
      </div>
      {needsCode || f.claimCode ? (
        <Field label="Claim code" hint="From the laundry office, e.g. K7QM-4821. No code? Ask at the counter.">
          <input value={f.claimCode} onChange={set('claimCode')} autoCapitalize="characters" spellCheck={false} autoComplete="one-time-code" />
        </Field>
      ) : <button type="button" className="link-btn" onClick={() => setNeedsCode(true)}>I have a claim code from the office</button>}
      <div className="field-row">
        <Field label="Password" hint="At least 6 characters">
          <input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required />
        </Field>
        <Field label="Repeat password">
          <input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </Field>
      </div>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" size="lg" block busy={busy} disabled={!!noHostels}>Register</Button>
    </form>
  );
}

/** App only: which Everjoy server this phone talks to, with a way to change it (e.g. laptop for testing → real domain). */
function ServerLine({ onChanged, highlight }: { onChanged: () => void; highlight: boolean }) {
  const [open, setOpen] = useState(false);
  const host = serverAddress().replace(/^https?:\/\//, '') || 'not set';
  return (
    <>
      <p className={`server-line${highlight ? ' bad' : ''}`}>
        <Icon name="database" size={16} />
        <span>Laundry server: <b>{host}</b></span>
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>Change</button>
      </p>
      {open && <Sheet title="Laundry server" onClose={() => setOpen(false)} size="sm"><ServerForm onSaved={() => { setOpen(false); onChanged(); }} /></Sheet>}
    </>
  );
}

function ServerForm({ onSaved }: { onSaved: () => void }) {
  const [url, setUrl] = useState(serverAddress());
  const { busy, error, submit } = useFormAction();
  const save = async (value = url) => {
    const ok = await submit(async () => { const base = await probeServer(value); await setServer(base); return base; });
    if (ok) { toast(`Connected to ${ok.replace(/^https?:\/\//, '')}`); onSaved(); }
  };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void save(); }}>
      <p className="muted">Ask the laundry office for this address. Changing it signs you out on this phone.</p>
      <Field label="Server address" hint="For example laundry.youruniversity.edu">
        <input value={url} onChange={e => setUrl(e.target.value)} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </Field>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" block busy={busy}>Test and save</Button>
      {builtInServer() && builtInServer() !== serverAddress() && <Button type="button" tone="plain" block onClick={() => { setUrl(builtInServer()); void save(builtInServer()); }}>Use the original address</Button>}
    </form>
  );
}

export function ChangePassword({ user, onDone, forced, onSignOut }: { user: User; onDone: (u: User) => void; forced?: boolean; onSignOut?: () => void }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const { busy, error, setError, submit: send } = useFormAction();
  const min = user.role === 'STUDENT' ? 6 : 8;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return setError('The new passwords do not match.');
    const r = await send(() => api<{ user: User }>('/auth/password', { body: { current: f.current, next: f.next } }), 'Password changed');
    if (r) onDone(r.user);
  };
  return (
    <form className={forced ? 'auth-card forced' : 'stack'} onSubmit={submit} noValidate>
      {forced && <>
        <Brand />
        <h1>Set your own password</h1>
        <p className="lede">You signed in with a temporary password. Choose a new one to continue.</p>
      </>}
      <Field label={forced ? 'Temporary password' : 'Current password'}>
        <input type="password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })} autoComplete="current-password" required />
      </Field>
      <Field label="New password" hint={`At least ${min} characters`}>
        <input type="password" value={f.next} onChange={e => setF({ ...f, next: e.target.value })} autoComplete="new-password" required />
      </Field>
      <Field label="Repeat new password">
        <input type="password" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
      </Field>
      {error && <ErrorNote error={error} />}
      <Button tone="primary" size={forced ? 'lg' : 'md'} block={forced} busy={busy}>Save new password</Button>
      {forced && onSignOut && <button type="button" className="link-btn" onClick={onSignOut}>Sign out</button>}
    </form>
  );
}
