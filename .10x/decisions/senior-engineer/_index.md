# Senior engineer: index

## Active features
| Slug | What | Status |
|---|---|---|
| [single-site-rebuild](single-site-rebuild.md) | v2: one website replacing the paper register and slip; student/staff/admin themes | Done, live on Render |
| [apps-and-hosting](apps-and-hosting.md) | Android/iOS apps (Capacitor), SQLite+Postgres db layer, Render + Neon hosting | Live; waiting for owner's Neon DATABASE_URL |

## Cross-cutting principles for this codebase
- Business rules live only in `server/rules.ts`. UI previews call the same server function; never re-implement limits or prices in the client.
- Every write that touches more than one table runs in `db.transaction`.
- Students are scoped by session user id on the server; return 404 (not 403) for other students' records.
- Anything user-visible from the server is plain sentence-case English with commas, no codes.
- Tests run on SQLite (`:memory:`) AND Postgres (PGlite) via vitest projects; never against `data/` or a live database.
- SQL must run on both engines; every db call is awaited; read-check-write runs in `db.tx` with `db.lockRow` first.
