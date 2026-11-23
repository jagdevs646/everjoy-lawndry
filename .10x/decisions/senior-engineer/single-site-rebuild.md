# single-site-rebuild: senior engineer decisions

Date: 2026-11-23. Requested by the owner: replace the paper register + slip with one minimalist website, with a distinct theme per role.

## Requirements confirmed with the owner
- Registration: student self sign-up (ID card no., name, mobile, hostel, room) → staff verify on university portal → approve.
- Login: ID card no. + password (students); username + password (staff/admin). No OTP (no SMS provider).
- Hosting: single Node server + SQLite file.
- Keep: announcements, complaints, monthly limit, payments & pricing. Owner asked for any other useful features to be added and documented → FEATURES.md.

## Approach chosen
Rewrite on the same stack (React + Vite, Express, better-sqlite3) instead of trimming v1. v1's schema had no hostel/room/mobile/clothes-count, an email login, and an allowance/carry-forward model the owner no longer wants. v1 kept in `archive/v1/` (code + DB).

Rejected: incremental strip-down (too much coupled dead code in a 37 KB single-file UI); BaaS (Supabase/Firebase) conflicts with the single-server choice.

## Key implementation decisions
- **One rules engine** (`server/rules.ts → quote()`): the counter's live check and `createOrder` run the same function inside the write transaction. Limits: max kg/order (7), max active orders (2), monthly kg/order limits with BLOCK or CHARGE, express fee, regular rate.
- **Order no.**: `EJ-<n>` from a `counters` row incremented inside the transaction (v1 used COUNT(*)+1, which is racy and breaks after deletes).
- **Idempotency**: `orders.request_id UNIQUE`; the client sends a UUID per form, so a double tap returns the same order.
- **Register snapshot**: hostel/room/mobile are copied onto each order (like the paper register), so later room changes don't rewrite history.
- **Campus time**: `day_key`/`month_key` are computed in `APP_TZ` (Asia/Kolkata). v1 used UTC, so orders between 00:00 and 05:30 IST were counted on the wrong day or month.
- **QR**: `EJ:<16-byte base64url token>`, no PII. Student ID QR is `EJS:<id_card_no>` (identification only; the physical ID card is still checked).
- **Auth**: JWT in an httpOnly SameSite=Lax cookie + required `x-ej: 1` header on mutations (CSRF). `token_version` invalidates sessions on password change/reset/deactivation.
- **Rate limits**: login 8 per 15 min per IP+ID. Sign-up 120 per 10 min per IP, generous because campus NAT puts many students behind one IP (tests caught 10/hour blocking a real orientation-day scenario).
- **Photos**: served only via `/api/files/:name` with an ownership check (v1 exposed `/uploads` publicly).
- **Excel**: streamed from memory with register-matching columns. No files left in `exports/`.
- **Client**: no router library (hash routes, so the phone back button closes sheets). Staff/admin bundles and html5-qrcode are lazy-loaded; the student first load is ~83 KB gzip.
- **Themes**: tokens per `html[data-theme]`. Student "rinse" (pale blue/denim/peg yellow, tag motif), Staff "control panel" (graphite/amber, Archivo condensed numerals), Admin "register book" (white ruled tables, oxblood sidebar, red margin rule).

## Review notes / known gaps
- Payments are recorded by staff (cash/UPI). There is no gateway webhook yet.
- The in-memory rate limiter resets on restart, which is fine for one process. Move it to the DB if the app ever runs as several processes.
- Dev-only warning: Vite HMR re-runs `createRoot` when `main.tsx` is edited. Not present in production builds.
- The camera scanner could not be exercised in the preview browser (camera blocked). The manual-code path was tested end to end.

## Testing
`tests/api.test.ts`: 17 behaviour tests against an in-memory DB (security boundaries, approval, 7 kg, sequence, idempotency, QR pickup, double handover, limits + charges + pay-before-pickup, corrections/cancellations, complaints, notices, export). Manual browser pass: student (mobile), staff (mobile), admin (desktop + mobile drawer).
