/*
 * Outgoing email (sign-in codes). Sent through Brevo's transactional email API.
 *
 * Render environment:
 *   BREVO_API_KEY    the API key from Brevo → SMTP & API → API keys (secret)
 *   MAIL_FROM        a sender address verified in Brevo → Senders (e.g. laundry@youruniversity.edu)
 *   MAIL_FROM_NAME   optional, defaults to "Everjoy Lawndry"
 *
 * Without BREVO_API_KEY nothing is sent: on a local/test server the code is printed to the console
 * (or kept in `outbox` for tests); on a production server email sign-in simply stays off.
 */

type Mail = { to: string; subject: string; text: string; html?: string };

/** Mails "sent" without a real provider (local runs and tests). Newest last. */
export const outbox: Mail[] = [];

const production = () => process.env.NODE_ENV === 'production';

/** Real email can be sent (Brevo configured). */
export const mailConfigured = () => !!process.env.BREVO_API_KEY && !!process.env.MAIL_FROM;

/** Email codes can be used: real email, or a local/test server that prints them. */
export const mailUsable = () => mailConfigured() || !production();

export async function sendMail(m: Mail) {
  if (!mailConfigured()) {
    if (production()) throw new Error('Email is not set up on this server (BREVO_API_KEY / MAIL_FROM).');
    outbox.push(m);
    if (outbox.length > 50) outbox.shift();
    if (process.env.NODE_ENV !== 'test') console.log(`[mail to ${m.to}] ${m.subject}\n${m.text}`);
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'Everjoy Lawndry' },
      to: [{ email: m.to }],
      subject: m.subject,
      textContent: m.text,
      ...(m.html ? { htmlContent: m.html } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Never log the API key; the status and Brevo's short message are enough to diagnose.
    const body = await res.text().catch(() => '');
    console.error(`Brevo send failed: ${res.status} ${body.slice(0, 200)}`);
    throw new Error('Could not send the email right now.');
  }
}

/** "jo•••••@univ.edu": enough for the student to recognise their address, not enough to harvest it. */
export function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(3, user.length - 2))}@${domain}`;
}
