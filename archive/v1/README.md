# EVERJOY LAUNDRY

Mobile-first laundry operations application with connected Admin, Staff, and Student experiences. The system uses a real Express API and persistent SQLite relational database; every interface reads or updates the same transaction record.

## What is implemented

- JWT login, persistent session, protected API routes, and server-enforced Admin/Staff/Student access.
- Student allowance, submission-limit, carry-forward, closure, emergency, and price-rule engine.
- Atomic laundry creation with a human-readable ID, QR token, status history, payment record, notification, and audit entry.
- Staff ID lookup, real browser camera QR scanning, operational status updates, secure collection verification, and collection lockout.
- Student QR display, payment confirmation flow, notifications, history, and complaint submission with image evidence upload.
- Admin management of students, staff permissions, operational rules, effective-date pricing, closures, notifications, complaints, reports, and audit records.
- Server-side report filtering, selected workbook columns, and valid `.xlsx` generation with download and audit history.

## Stack

React + TypeScript + Vite for the responsive PWA-style client; Express + TypeScript for the API; SQLite (`better-sqlite3`) for local persistent relational storage; JWT, QRCode, `html5-qrcode`, Multer, and SheetJS (`xlsx`). SQLite is the local relational-database deployment option; the schema and parameterized query boundary are designed for a PostgreSQL adapter in a hosted deployment.

## Local setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:3001`. On first startup, it creates `data/everjoy.db` with development data. Do not use these credentials in production:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@everjoy.local` | `Everjoy@123` |
| Staff | `staff@everjoy.local` | `Everjoy@123` |
| Student | `student@everjoy.local` | `Everjoy@123` |

## Commands

```bash
npm run dev       # web and API together
npm run build     # TypeScript check + production web build
npm test          # API authorization and rule-engine tests
npm start         # API only
```

## Data model

The database includes users, students, staff, permissions, settings, categories, effective-date pricing rules, closures, laundry transactions, status history, payments, notifications and recipients, complaints and attachments, audit logs, and report exports. `laundry_transactions` is the central relation; it connects student, weight allocation, financial snapshot, QR token, workflow status, collection, complaints, and reports.

## Important operational policy

Seed values such as allowance (10 kg), carry-forward (2 kg), limits, turnaround, and prices are development defaults—not permanent policy. Admin can update the operational values under **Rules & Limits**, and new price records receive an effective date. Existing transactions retain their saved weight allocation and calculated price.

Paid excess weight is stored separately from entitled weight, so excess payments never consume or become free allowance. The current local payment adapter immediately confirms a user-initiated payment and generates a reference; replace that adapter with a signed webhook from the institution’s chosen provider in production.

## Reports

Report preview and export use the same server-side query. Date filtering is inclusive: the end date runs through `23:59:59.999`. A report with zero matches returns an explicit error instead of a false download. Workbook exports are generated with SheetJS, saved transiently in `exports/`, and logged in `report_exports` and the audit log. For production, serve exports using signed, expiring object-storage URLs and schedule retention cleanup according to institutional policy.

## Deployment notes

Set a strong `JWT_SECRET`, use HTTPS, move database configuration to PostgreSQL, put uploads and exports in private object storage, integrate a payment provider webhook and mobile push provider, and host the API behind a reverse proxy. Browser camera scanning requires a secure origin (HTTPS or localhost).
