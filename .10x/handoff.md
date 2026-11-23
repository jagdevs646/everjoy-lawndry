# Handoff

## Current handoff (senior-engineer → SDE / DevOps), 2026-11-23

Read first: `.10x/decisions/senior-engineer/single-site-rebuild.md`.

**Where things are**
- Rules: `server/rules.ts`. `quote(input, excludeOrderId?)`, `createOrder(actorId, input, requestId?)`, `setStatus`, `recordPayment`, `deliverOrder`, `cancelOrder`, `correctOrder`. Settings schema and defaults are at the top of the file.
- Reads: `server/queries.ts`. `listOrders(filters)`, `orderDetail(id, {includeQr})`, `findOrderByCode(code)`, `listStudents`, `complaintDetail`.
- Routes: `server/routes/{public,student,ops,admin}.ts`. `/api/ops/*` is STAFF+ADMIN; `/api/admin/*` is ADMIN; `/api/me/*` is STUDENT.
- App factory: `server/app.ts → createApp({demo})`; entry `server/index.ts` (`--port`, `--demo`).
- Client: `client/main.tsx` picks the app by role and sets `html[data-theme]`; `student.tsx`, `staff.tsx`, `admin.tsx`, shared `ops.tsx`, `ui.tsx`, `lib.ts`.

**Gotchas**
- `PORT` env is honoured in production; local dev pins the API with `--port 3001` because the preview tool exports `PORT=5173`.
- All mutations need header `x-ej: 1` (the client `api()` adds it). Tests use `.set('x-ej','1')`.
- `z.coerce.boolean` is deliberately not used (it turns "false" into true). Booleans in settings must be real JSON booleans.
- better-sqlite3 named params: extra keys are fine; missing keys throw.
- Order numbers come from the `counters` table. Never derive them from COUNT(*).

**Next steps**
1. Deploy: VPS or Render/Railway with a disk; set `JWT_SECRET`, `NODE_ENV=production`, `ADMIN_PASSWORD`; HTTPS in front; `npm ci && npm run build && npm start`.
2. Test the camera on real phones over HTTPS: university ID barcode format (CODE_128/39/EAN/ITF enabled) and slip QR.
3. Optional: SMS/WhatsApp "ready" alerts, a payment gateway webhook, bulk student import.

## Handoff history
- (none before this)
