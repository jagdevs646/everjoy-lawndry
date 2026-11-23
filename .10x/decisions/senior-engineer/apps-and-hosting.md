# apps-and-hosting: senior engineer decisions

Date: 2026-11-23/24. The owner asked for (1) an Android APK and an iOS app that do the same as the website, and (2) GitHub plus free hosting (Render) so the apps work over the internet instead of the laptop's Wi-Fi.

## Apps (Capacitor 8.6)
- The same React build is bundled in Android/iOS (`android/`, `ios/`, iOS via SPM). No second UI codebase.
- App auth: the client sends `x-ej-client: app`, gets the JWT in the JSON reply and uses `Authorization: Bearer`. The website keeps the httpOnly cookie. CORS only for the app origins (`https://localhost`, `capacitor://localhost`, `http://localhost`), never with credentials.
- Token storage: `@aparajita/capacitor-secure-storage` (iOS Keychain, this device only, no iCloud sync; Android Keystore-encrypted). Read with `get()`, not `getItem()`: `set()` stores JSON, and `getItem()` returns the quoted string. That was a real bug, caught on the emulator.
- Production builds (https `VITE_API_BASE`) are pinned to their server: the server switcher is hidden and saved overrides are ignored. http test builds can switch servers.
- Stale-401 guard: a session generation counter, so a 401 from an older session never signs out a newer one.
- Offline: students keep their saved slips (verified in airplane mode). Staff see "Can't reach the laundry server" and the app reconnects by itself (verified).
- Android: CAMERA permission, `allowBackup=false` plus data-extraction rules, release signing from env vars, `scripts/build-apk.mjs` (portable JDK on D:, Gradle cache on D:). Release builds refuse non-https servers.
- Status bar: dark icons over a light strip on older WebViews (< Chromium 140, where Capacitor pads the page); theme icons when edge-to-edge.

## Hosting
- Render free web service `srv-dc24nem8bjmc739jsh0g`, Singapore, https://everjoy-lawndry.onrender.com, auto-deploys from `main` of the private repo `jagdevs646/everjoy-lawndry`.
- Render free has no persistent disk, so data goes to Postgres: a free Neon database (the owner chose this over paid Render disk or the 30-day Render free Postgres).
- `server/db.ts`: one async API (`db.get/all/run/tx/lockRow`, `insertId`) with SQLite, pg and PGlite drivers. Portable SQL (`?` placeholders, RETURNING, LOWER() LIKE, CASE sums, CAST(... AS NUMERIC) for ROUND, strict GROUP BY). Transactions use AsyncLocalStorage, with a guard against queries after the transaction ends. Row locks on Postgres for read-check-write paths.
- Photos (`files` table) and the JWT secret (`app_secrets`) live in the database. Admin password is random in production unless `ADMIN_PASSWORD` is set.
- Tests: vitest projects run the same 26 tests on SQLite and on PGlite (52 total).

## Review fixes (adversarial review of the db conversion)
- pg Pool 'error' listener + per-transaction client error listener, release(err) on broken connections: a dropped Neon connection no longer crashes the process.
- Session middleware: only JWT errors mean "signed out"; DB errors become 500/503, and the client keeps its token and retries (5xx counts as temporary in main.tsx).
- lockRow uses FOR NO KEY UPDATE: FOR UPDATE conflicted with the FOR KEY SHARE locks foreign-key checks take (complaint vs handover deadlock).
- Pool connectionTimeoutMillis/query_timeout/keepAlive; SET LOCAL lock_timeout/statement_timeout/idle_in_transaction_session_timeout per transaction.
- errorHandler: 23505/SQLITE_CONSTRAINT_UNIQUE → 409; Postgres class 22 / SQLITE_MISMATCH → 400; connection errors → 503.
- Ids capped at int4 (MAX_ID); integer-only limit/offset/hostelId; LIKE input escaped with ESCAPE '\' (likeContains).
- Known gap: PGlite serialises every query, so the race tests can't prove the Postgres row locks. They are correct by design, but untested against a real multi-connection Postgres.

## Open items
- Neon connected (2026-11-24): startup logs show Postgres, and a redeploy did not re-seed, so the data persists. Neon's sslmode=require is rewritten to verify-full in pgDriver.
- Live sign-in has not been exercised by Claude, by policy: it is a production host. The owner should sign in once with the demo accounts.
- The camera could not be tested on the emulator (Google Play Services crashes on that image), so it needs a real phone.
- iOS needs a Mac with Xcode and a $99/year Apple Developer account.
