# Security to-do: Render, Neon and the Android app

A security audit on 24 Nov 2026 covered the whole system: server, website, Android/iOS app and hosting. Everything that could be fixed in the code has been fixed, with tests (see "Fixed in the code" below).

The items below cannot be fixed in the code. Each needs someone with access to the **Render** dashboard, the **Neon** database console, or the app signing key. They are listed most urgent first. Tick each one off when it's done.

---

## 1. Remove `DEMO=1` from the live server (Render): urgent

**Risk:** `DEMO=1` makes the server create demo accounts (`STAFF1`, `STAFF2`, `EJ2026001`–`EJ2026007`). They all use the password `Everjoy@123`, which is written in this README. If that seed ever runs on the live database, anyone on the internet can sign in as staff. They could then see every student's name, mobile and room, reset passwords and mark orders as handed over.

The new code ignores `DEMO` when `NODE_ENV=production`, so this can't happen again after the next deploy. Remove the setting anyway, so nobody turns it back on with `ALLOW_DEMO_IN_PRODUCTION`.

- [ ] Render → `everjoy-lawndry` → **Environment** → delete `DEMO` (and never add `ALLOW_DEMO_IN_PRODUCTION`) → **Save, rebuild and deploy**.

## 2. Check the live database for demo accounts (Neon)

**Most likely yes:** the Render log shows `Demo data ready → staff: STAFF1 · students: EJ2026001…EJ2026007` on the first start with Postgres (23 Nov 2026, 18:53). The live hostels `HOR 11` and `HOR 7` are probably the renamed demo hostels. If so, anyone who has read the README can sign in as staff with `STAFF1` / `Everjoy@123`. **Do this first.** The quickest fix without SQL: sign in as `ADMIN`, open **Staff**, and **Switch off** `STAFF1` and `STAFF2`. Then open **Students**, search `EJ2026`, and put those demo students on hold, or reset the database as below.

- [ ] Neon → your project → **SQL Editor** → run:
  ```sql
  SELECT id, login_id, role, active FROM users
  WHERE login_id IN ('STAFF1', 'STAFF2') OR login_id LIKE 'EJ20260%';
  ```
- [ ] If it returns rows, lock them out (or reset the whole database if nothing real is in it yet):
  ```sql
  UPDATE users SET active = 0, token_version = token_version + 1, password_hash = '!'
  WHERE login_id IN ('STAFF1', 'STAFF2') OR login_id LIKE 'EJ20260%';
  ```
  Also look at the Activity log in the admin office for anything done by those accounts.

## 3. Change the admin password if it came from the Render logs (Render)

**Risk:** on the first start the server printed a random admin password into **Render → Logs**. Because `DEMO=1` was set, that admin account was not forced to change it. Anyone who can read the logs, now or later, can sign in as admin.

- [ ] Sign in as `ADMIN` and use **Change password** (bottom of the admin menu). After that, the password in the logs no longer works.
- [ ] Optional: in Render → Environment, add `ADMIN_PASSWORD` as a secret value for any future fresh database, so no password is ever printed to the logs.

## Email codes (Brevo): needed before students can get sign-in codes

The app emails students a 6-digit code from their university email. Their first time on a new phone or browser, imported students setting up their account, and new registrations all get one. Until email is set up on Render, the live server **keeps email codes off**: students sign in with only a password, and imported students use the office claim code. The admin office shows the status under **Rules & pricing → Student sign-in**.

- [ ] Create a free account at [brevo.com](https://www.brevo.com) (300 emails/day free).
- [ ] Brevo → **Senders, Domains & Dedicated IPs → Senders** → add and verify the address codes will come from (for example `laundry@youruniversity.edu`, or a Gmail address you own). Ask the university IT team to also authenticate the domain in Brevo (**Domains**), so the codes don't land in spam.
- [ ] Brevo → **SMTP & API → API keys** → create a key. Copy it once.
- [ ] Render → `everjoy-lawndry` → **Environment** → add these, then **Save, rebuild and deploy**:
  - `BREVO_API_KEY` = the key (mark it as secret)
  - `MAIL_FROM` = the verified sender address
  - `MAIL_FROM_NAME` = `Everjoy Lawndry` (optional)
- [ ] Admin office → **Rules & pricing → Student sign-in**: check it says "Email is set up", and fill in the **university email domain** (e.g. `university.edu.in`), so codes can only be sent to university addresses and nobody can use the form to send emails to random people.
- [ ] Watch the free limit: 300 emails per day. During admission week, imports and new phones can exceed that. Brevo's paid plan removes the limit; codes that can't be sent show "Could not send the email code right now".

## 4. Optional hardening (Render and Neon)

These are not open holes, but they reduce the damage if a dashboard account or the database address leaks.

- [ ] **`JWT_SECRET` (Render):** add a long random value (64+ characters) as a secret environment variable. The session signing key then lives in Render, not in the Neon database, and anyone who gets a copy of the database still can't sign in. Note: setting or changing it signs everyone out once.
- [ ] **Separate database user (Neon):** the app connects as the Neon project owner. In Neon → Roles, create a role for the app with access only to the app's tables, and put that role's connection string in `DATABASE_URL`.
- [ ] **Protect the `DATABASE_URL` (Neon):** if it was ever pasted anywhere outside Render (a chat, a screenshot, a file), reset the database password in Neon → Roles and update `DATABASE_URL` in Render.
- [ ] **Backups (Neon):** the free plan keeps only a short history. Download a backup weekly from **Reports → Download backup** in the admin office, or move to a paid Neon plan with longer restore history.
- [ ] **Two-factor sign-in:** turn on 2FA for the Render, Neon and GitHub accounts. Whoever controls these controls the laundry's data.

## 5. Give out a release build of the Android app, not the debug APK (needs your signing key)

**Risk:** the APK shared so far (`release/everjoy-lawndry-2.0.0-debug.apk`) is a debug build (`android:debuggable=true`). On a phone where someone can plug in a USB cable, a debug app's private data, including the 30-day sign-in token, is easier to pull out.

The code now switches off remote debugging of the app's screens for every build except laptop test builds. A signed release build is the proper fix. It needs a signing key that only you hold:

- [ ] Create the key once and keep it safe; losing it means the app can't be updated. Choose your own passwords when asked:
  ```powershell
  & "D:\dev-tools\jdk21-extract\jdk-21.0.13.1+2\bin\keytool.exe" -genkeypair -v -keystore D:\dev-tools\everjoy-release.jks -alias everjoy -keyalg RSA -keysize 2048 -validity 10000
  ```
- [ ] Build: set `EJ_KEYSTORE=D:\dev-tools\everjoy-release.jks`, `EJ_KEYSTORE_PASSWORD` and `EJ_KEY_ALIAS=everjoy` in the terminal, then run `npm run app:apk:release`. Share `release/everjoy-lawndry-<version>.apk` instead of the debug one.
- [ ] Ask people who installed the debug APK to uninstall it and install the release build. Android treats them as different apps because the signing keys differ.

---

## Fixed in the code (for reference)

| Area | Problem | What changed |
|---|---|---|
| Accounts | Excel-imported students could be taken over by anyone who knew their ID card no. and mobile | Claiming also needs a one-time **claim code** (shown to the admin once at import, valid 30 days, stored only as a hash, 8 tries per hour) |
| Accounts | Temporary passwords were short (`wash-4821`), never expired, and worked for everything | Longer codes (`fold-KQMT-4821`), expire after 7 days, and the server allows nothing but choosing a new password until it is changed |
| Accounts | First admin on a live server didn't have to change the printed password | Always forced to change it (only a local demo skips this) |
| Sign-in | Login limits could lock out the real owner and didn't stop guessing across many accounts; parallel requests could slip past | Limits count failed attempts (counted before the password check), plus a per-network cap; inputs have a maximum length; no timing difference for unknown IDs |
| Sign-in | Sign out only cleared the cookie; a copied token kept working for 30 days | Sign out cancels the token on the server |
| Sign-in | Changing password had no attempt limit | 5 wrong tries per 15 minutes |
| Demo | `DEMO=1` would seed known-password accounts on a live server | Ignored when `NODE_ENV=production` |
| Staff | Staff could move an order back to "received" to re-open cancel/correct, which is admin-only | Only the admin can move an order back |
| Students | Unapproved or suspended students could upload complaint photos | Approved students only, checked before the upload is read |
| Uploads | Unlimited form fields, any bytes accepted as a "photo" | Every part of an upload is size-limited; photos must really be JPG/PNG/WEBP/HEIC |
| Uploads | `xlsx` library with known parsing vulnerabilities; a small .xlsx could unpack into gigabytes | Replaced with `exceljs`; unpacked size is checked before loading; CSV read as plain text |
| Exports | — | Register export writes every cell as text, never as a formula |
| Backups | SQLite backup contained the session signing key | Key removed from the backup copy |
| Browser | No HSTS or Content-Security-Policy | Both added |
| App | An app built without a server address could be pointed at a fake server | Changing the server is allowed only in laptop (http://) test builds |
| App | Saved slips stayed on the phone after a remote sign-out | Cleared whenever the server says the session ended |
| Dependencies | `npm audit`: multer, body-parser, proxy-addr, qs, zod, xlsx | All updated or replaced: `npm audit` reports 0 vulnerabilities |
