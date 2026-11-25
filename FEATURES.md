# Everjoy Lawndry: what each feature does

One website for everyone. After signing in, each role gets its own look:

| Role | Look | Built for |
|---|---|---|
| **Student** | Light "rinse" blue with clothes-peg yellow. The slip is drawn as a real laundry tag. | Phone, one hand, quick glance |
| **Staff** | Dark graphite "control panel" with amber buttons and very large numbers | Fast work at the counter during a rush |
| **Admin** | White "register book" pages with a maroon sidebar and a red margin line on tables | Checking records, setting rules, reports |

---

## How the paper process maps to the website

| Before (paper) | Now (website) |
|---|---|
| New student gives ID no., name, hostel, room; worker checks the university portal | Student **registers on their phone**. Staff checks the portal and taps **Approve**. |
| Student shows ID card at drop-off | Staff **scans the ID card barcode** or the student's **ID QR** on their phone, or types the ID no. |
| Clothes weighed, 7 kg limit | Staff enters weight. Anything over **7 kg is blocked** automatically (admin can change the limit). |
| Worker counts clothes | Staff enters **clothes count** with big +/− buttons. |
| Register: name, mobile, hostel, room, clothes count, date & time in, order no. | All saved automatically. Name, mobile, hostel and room are copied from the profile, and date and time are stamped. **Order no. (EJ-1001, EJ-1002 …) is unique and never repeats.** |
| Paper slip the student must keep | **Digital slip with QR** appears instantly on the student's phone and works even with weak network. |
| Student brings slip back to collect | Staff **scans the slip QR**, counts the clothes back, and taps **Hand over**. A slip can never be used twice. |

---

## Student features

- **Register** with ID card no., full name, mobile, hostel and room. Until staff approve, the home screen says "show your ID card at the counter".
- **Sign in** with ID card no. + password. Students stay signed in on their own phone for 30 days.
- **Home**
  - Each order **in progress** shows as a tag card: order no., clothes count, kg, a progress bar (Received → Washing → Ready → Collected) and the expected ready time.
  - A **yellow banner** appears when an order is ready for pickup.
  - **This month**: orders and kg used. If the admin set a monthly limit, a meter shows how much is left.
  - **Amount to pay** (only if something is due), with a **Pay with UPI** button that opens GPay/PhonePe/Paytm with the amount filled in. Shows only if the admin entered a UPI ID.
  - **Notices** from the laundry (holidays, closures, timing changes).
- **Digital slip**: big order no., QR code, clothes count, weight, time given, ready time, room, and the full history of who did what and when. After collection the QR is replaced by a "Collected" stamp.
- **Works offline**: the last copy of the slips is saved on the phone, so the QR still opens if the network is weak at the counter.
- **My ID QR**: a QR of the student's ID no. Staff scan it to open the account instantly at drop-off.
- **My orders**: full history.
- **Help**
  - **Report a problem** (missing clothes, damaged, wrong count, not washed properly, delay, behaviour, other) linked to a specific order, with an optional photo from the camera. Staff replies appear under the complaint.
  - Short FAQ: weight limit, "my phone is dead at pickup", forgot password, counter timings.
- **Notifications** (bell icon): order received, ready for pickup, handed over, payment received, registration approved/rejected, complaint replies, notices.
- **Profile**: change mobile, hostel or room (e.g. room change next semester), change password, sign out. Name and ID no. are locked after approval. If registration was rejected, the student fixes the details and resubmits.
- **Add to Home screen**: the site can be pinned to the phone like an app (icon and name included).

## Staff features (the counter)

- **New order**: the main screen.
  1. **Find the student**: type the ID no., name or room, use a USB/Bluetooth barcode scanner, or tap the camera to scan the ID card barcode or the student's ID QR.
  2. See the student's card: name, ID, hostel/room, mobile, this month's usage, orders already in progress.
  3. **Not yet approved?** Approve right there after checking the portal.
  4. Pick the **service** (Wash & fold, Wash + iron, Ironing only, Dry cleaning, or whatever the admin set up), enter **weight** and **clothes count** (+/−). Choose Regular or Express (if offered). One slip per service: a student with washing and dry cleaning gets two order numbers. Add an optional note (e.g. "1 blanket").
  5. A **live rule check** shows instantly: "No charge" / "Collect ₹30 at pickup", plus the ready-by time. Over a free limit it shows **two buttons**: *Take back 1.5 kg* (order stays free) or *Charge ₹37.5* (extra kg at the admin's rate, paid at pickup).
  6. **Take order**. A big order no. appears to write on the bag tag, and the slip is already on the student's phone.
  - **Double-tap safe**: tapping Take order twice never creates two orders.
- **Pickup**
  - Camera opens to **scan the slip QR**, or type the order no. (for a dead phone, staff are told to check the physical ID card).
  - Shows student name, ID and room to match against the person, plus the **clothes count given**. Staff count again. If the number differs, a reason is required.
  - If money is due, choose **Cash or UPI** and hand over in one step.
  - Scanning an already-collected slip shows a red **"Already handed over, do not give clothes again"** with who and when.
  - List of everything **Ready for pickup** with a filter.
- **Orders board**: tabs for Received / Washing / Ready / **Late**, with counts. Tick many orders and tap **Move to washing** or **Mark ready** together. Marking ready **notifies each student**.
- **Order details**: timeline, change status, record payment, **correct weight or count** (with reason), **cancel** (with reason). Staff can correct or cancel only before washing starts; admin can always.
- **Students**: **Waiting approval** list with Approve / Reject (reason shown to the student). Search everyone, edit details, and **reset password**, which shows a temporary password like `wash-4821` once; the student must change it at next sign-in.
- **Issues**: complaints from students. Reply, mark Checking or Resolved, open the linked order, call the student.
- **Top bar**: today's orders in, kg and orders out. Notices from the admin appear on the counter screen too.

## Admin features (the office)

- **Overview**
  - One plain sentence: today's orders, kg, handed back, in washing, waiting on the shelf.
  - **Orders per day** chart for the last 14 days (hover a bar for the day's numbers).
  - **Needs attention**: students waiting for approval, late orders, orders ready for over 3 days and not collected, open complaints, money still due. Each item links to the right page.
  - **This month**: orders, kg, students served, money collected, and a by-hostel breakdown.
  - **Setup checklist** for a fresh install: add hostels, create staff, review rules, change the default password.
- **Register**: the digital version of the paper register. Search and filter by dates, status, hostel and payment. Click any row for its full timeline and actions. **Excel** downloads exactly what is filtered.
- **Students**: every student with status, hostel, room, mobile, this month's usage and orders in progress. Approve, reject, edit, **put on hold** (suspend) or make active, reset password.
- **Complaints**: same board as staff.
- **Notices**: post an announcement to **all students or one hostel**, optionally with an end date. It can also go to every student's notification bell.
- **Reports**: pick Today / Last 7 days / This month / Last month or any dates.
  - Laundry: orders, clothes, kg, handed over, cancelled, students, **count mismatches at pickup**.
  - Money: collected (cash vs UPI), still due, waived, weight over the monthly limit, express orders.
  - Staff activity (orders taken, handed over), by hostel, heaviest users.
  - **Download register (Excel)**: one row per order, with the same columns as the old paper register plus pickup details.
  - **Download backup**: a full copy of the database file. Keep one weekly.
- **Staff**: create counter staff or other admins (username + first password, which must be changed at first sign-in), reset passwords, **switch off** people who leave. Their history is kept.
- **Rules & pricing** (apply to new orders immediately; old orders keep what they were charged):
  - Weight limit per order (default **7 kg**), orders a student may have in progress (default 2), ready time in hours.
  - **Free washing per student**: free kg per order (default 7), free kg and/or orders per month (0 = no limit). **Let students pay for extra kg** on/off, and the price per extra kg.
  - **Hostel plan**: the current semester end date, given to students approved from now on.
  - **Express service** on/off with fee and ready time.
  - **Payments**: require payment before pickup; UPI ID and name; **upload the UPI QR** image.
  - **Services and prices**: add or edit services, each priced per kg or per piece, with a hosteler price and a normal price. "Uses the free kg" makes a service count toward the free limits.
  - Counter timings text.
  - **Hostels**: add, rename, hide.
- **Activity log**: every important action (orders, handovers, corrections, cancellations, payments, approvals, password resets, rule changes with old and new values, exports, backups) with who and when. It cannot be edited.
- **Counter mode**: the admin can switch to the staff counter screens in one tap and come back.

## Added in November 2026

| Feature | Who | What it does |
|---|---|---|
| **Room change needs approval** | Student, staff | A student who is already approved can change hostel/room in Profile, but it stays "waiting for the counter" until staff approve it (Students → Room changes). Staff can turn it down with a reason the student sees. |
| **Over the free limit: remove or pay** | Staff, student | Over 7 kg (or the monthly free kg) the counter chooses: take clothes back, or charge the extra kg at the admin's rate. The admin can switch the paid option off. |
| **UPI QR** | Admin, staff, student | Admin uploads the business UPI QR once. Students tap *Pay by UPI* on Home to see it (or a QR with the amount filled in, made from the UPI ID). At the counter, choosing UPI shows the same QR. Staff mark the order paid after checking the payment. |
| **Staff work report** | Admin | Staff page shows each person's orders this month, money collected and last active time. *Work* opens a report for any period: orders taken (kg, clothes), handed over, count mismatches, cash and UPI collected, complaints handled, approvals, room changes, walk-ins, orders per day. |
| **Add students or staff from Excel** | Admin | Download the template, fill it, upload. Every row is checked first; if any row is wrong nothing is added and each problem is listed with its row number. Imported students are already approved: they *Register* with the same ID card no. and mobile and choose their own password. Imported staff get temporary passwords shown once. |
| **Hostel plan validity** | Admin, staff, student | Each student has a "plan valid till" date (set in bulk from Students → Plan dates, per student in Edit, or from the Excel sheet). After that date they pay normal prices for every service. The student sees their plan on Home and in Help. |
| **Walk-in customers** | Staff | Not shown anywhere as a feature: when a counter search finds nobody, a small *Serve without registration* link appears. Name + mobile is enough; they pay normal prices, and the same mobile finds them next time. They cannot sign in. |
| **Multiple services** | Everyone | Washing, washing + ironing, ironing only, dry cleaning (editable). Each has its own price and its own slip. Reports and the Excel register show the service of each order. |

### Added on 25 November 2026

| Feature | Who | What it does |
|---|---|---|
| **Profile photo** | Student, staff | Students add a photo of their face before approval. Staff compare it with the person at approval, drop-off and pickup (big photo on the pickup screen). After approval the photo is locked and only staff can change it; staff can take one with the phone camera at the counter. |
| **Semester hostel plan** | Staff, admin, student | Each student's plan has a start and end date, normally a semester: **Jan–Jun** or **Jul–Dec**. Staff set it per student (one-tap semester buttons), the admin sets it for everyone or one hostel (Students → Plan dates), and the Excel import has **Valid From / Valid Until** columns. Outside the dates the student pays normal prices. The student sees "Hostel plan Jan 2027 – Jun 2027" on Home and Profile. |
| **Email code on new devices** | Student | The first time a student signs in on a phone or browser, a 6-digit code is emailed to their **university email**. Once typed, the device is trusted for 30 days or until sign-out. New registrations confirm their email the same way. Imported students set up their account with an emailed code, with no staff approval. The import also lists a claim code for each student, a fallback for when email codes are off. A student without an email on file adds one by typing the code sent to it. Ten wrong codes lock that email out of new codes for an hour. The admin can restrict addresses to the university domain. Needs Brevo set up on Render (see SECURITY-TODO.md). |
| **No screenshots of QR codes** | Student | The slip QR **changes every 30 seconds**, so a screenshot or a photo of it stops working within about two minutes. The QR is signed with a key derived on the server, so even the old fixed QR can't be used to make one. Phones with a wrong clock use the server's time. On the Android app, screenshots and screen recording are blocked while a slip or ID QR is open. |
| **Basket card no.** | Staff, admin, student | The physical cards on the baskets (A1002, A628…) are typed at drop-off, next to the order no., which stays as it is. A card can be on only one basket until it is collected, then it's free for the next one. At pickup, staff type the card no. to find the basket. The admin builds the card series in use under Rules & pricing → Basket cards: anything before and after the number (letters, words or signs, e.g. A1–A3000, BLUE-001–BLUE-500, H1/1–H1/200, 1-B–999-B), with or without leading zeros, and a live preview. Staff can type a card without its signs or spaces (blue7 finds BLUE-007). Two series that could give the same card no. can't be saved, nor a series that looks like the order numbers. A card on a basket that hasn't been collected can't be given to anyone else, however it is typed (K77, K-077 and k 77 are one card); the database itself refuses a second one. The admin also sets whether a card is required. The student sees the card no. on their slip, and the register export has a **Card No** column. Staff can change the card on an open order. At the counter, staff pick the series (if there is more than one) and type only the number: the letters and signs are added for them (256 → A256), and a full card no. typed or scanned is split for them. While they type, the box says whether the card is free, outside the series, marked not usable, or on which basket it still is, and offers the **next free card**. The admin can mark cards of a series **not usable** (lost, damaged, taken out of use, with a note), one by one or as ranges like 40-45; the counter refuses them. At pickup the number alone finds the basket. |
| **Order no. style** | Admin | Rules & pricing → Order numbers. The admin sets their own style of order no., like an invoice no.: anything before and after the number, the number of digits, the first number, and date parts (year, short year, month, financial year), e.g. EJ-1001, INV/26-27/0001, LDY2611-001. Numbering can start again every year, financial year or month (the date part must then be in the no.). An order no. is never given twice: a no. that was used before, even written a little differently, is skipped, and the database refuses duplicates. Changing the style affects new orders only. The tab shows the last no. given and the next one, with a live preview. Staff find an order by typing it with or without signs and spaces, or just its number. |
| **Desktop layout** | Students, staff | On a computer browser (window 1024px or wider) students and staff get a desktop layout instead of a stretched phone screen: a menu down the left side, and pages in columns. Staff see today's numbers and their account under the menu; the new order screen puts the student search beside the notices, and (from 1280px) the price check and **Take order** stay in view on the right while staff fill in the left. Students see their laundry on the left and timings, payment, monthly use and notices on the right. The Android/iOS app and phone browsers keep the phone layout exactly as before. |
| **Admin office on a phone** | Admin | On a phone the admin office has a bottom tab bar like the student and staff apps (Overview, Register, Students, Issues, More); **More** opens the full menu. Tables (register, students, staff, activity, stats) show one card per row with each value labelled, instead of a wide table to scroll sideways. The Rules & pricing tabs swipe sideways, filters and forms fit the width, and the save bar appears only when there is something to save. The computer layout is unchanged. |
| **Two-sided register (student code)** | Student, staff, admin | Replaces signing the paper register. When staff take an order, and when they count the clothes back and press Hand over, a pop-up opens on the student's app with what they confirm ("I gave 8 clothes (3 kg)…", "I received 17 of 17…") and a 6-digit code that changes every 30 seconds. The student reads it out and staff type it in; the hand-over (and any payment) completes only then. The code is made on the phone from a key the server gives for that request, and the server accepts the current and the previous code; five wrong codes cancel the request. "Something is wrong" on the pop-up stops the counter, records a dispute and opens a complaint. A correction of count or weight cancels the earlier confirmation and asks again. Until the student gives the drop-off code, the order is marked **Not confirmed** (orange tag) for staff, admin and the student: it is not counted in today's "in", cannot be moved on by hand, in bulk or by the automatic status step, and the admin register can filter it. Staff open it and ask for the code; if the student has lost their phone, only the admin can **Count as received without the code**, with a written reason. Walk-in customers (no app) are confirmed at the counter; only the admin can hand over without the code, with a written reason. Each confirmation stores the exact sentence, the staff member, the time, the device and a SHA-256 fingerprint. Admin: two switches in Rules & pricing → Orders & limits, a "Student confirmed" column and filters in the register, alerts on the overview, and both in the Excel export and backups. |
| **User guides** | Everyone | Two illustrated guides with real screenshots, numbered steps and a diagram of an order's journey: `/guide/students.html` (linked from the sign-in page and Help) and `/guide/staff.html` (linked from the staff account menu and the admin menu). They are plain pages, so they also open inside the Android app. |
| **Spreadsheet-style tables** | Admin | Register, Students, Staff, Complaints and Activity log show 100 rows per page by default; type any number from 10 to 1,000 in **Rows per page** and it applies at once, with Prev/Next page buttons. Drag a column header's right edge to resize it (double-click the edge to reset it, or **Reset column widths**), choose **Row height** (compact, normal, tall) and turn **Wrap text** on to read long text in full. The header row is dark and stays visible while scrolling. Each table remembers its settings on that computer. On phones the rows show as cards with the page controls. |

### Added on 25 November 2026 (second update)

| Feature | Who | What it does |
|---|---|---|
| **Counter timings + automatic status** | Admin, student | Admin sets the drop-off hours (e.g. 6–8 PM), the collection hours (e.g. from 7 PM) and how many days after drop-off laundry is ready (e.g. 2). An order given on 24 Nov is promised for 26 Nov at 7 PM. Orders move by themselves: **Washing** after 24 hours (adjustable) and **Ready for pickup** at the ready time, and the student is notified. Staff can still change a status by hand; the admin can switch the automatic step off. Students see the timings on Home and in Help. |
| **Tidier Rules & pricing** | Admin | Settings are split into tabs (Orders & limits, Timings, Prices & services, Payments, Students & sign-in, Basket cards), laid out across the full width. |
| **Orders chart: daily / weekly / monthly** | Admin | The overview chart switches between the last 14 days, 12 weeks and 12 months. |
| **Stats** | Admin | For any period: average time from drop-off → ready, ready → collected and total, with the on-time share, per service. Per staff member: orders taken, orders marked ready (and how fast), orders handed over. Complaints over time (daily/weekly/monthly), per 100 orders, by type, time to resolve, and students who complain often. |
| **Remove students who left** | Admin | Tick students and choose **Remove (left hostel)**. They disappear from the student list and can't sign in or give laundry; their orders and payments stay in the register. Students with laundry at the counter or money due are not removed. **Left hostel** in the filter shows them, with **Restore**. |
| **Activity log** | Admin | A numbered table, newest first, 100 entries per page with Newer/Older. The first page updates by itself every 15 seconds. |
| **Reset password for everyone** | Admin, student | The admin can reset any student (Reset on each row) or staff/admin account (Staff page). Students can also use **Forgot your password?** on the sign-in page: a code goes to their university email, then they choose a new password. |

---

## Android and iPhone apps

The apps have exactly the same screens and features as the website, for all three roles. Things that work differently in the app:

- **Installed like any app**, with the Everjoy laundry-tag icon and a short splash screen. It opens straight to the student's slips or the staff counter.
- **Stays signed in** on the phone (30 days). Changing or resetting the password signs out every other phone.
- **Slips work offline**: the screens are inside the app, so a student can open their slip QR at the counter even with no network.
- **Camera scanning** for staff (slip QR and ID-card barcodes) asks for camera permission the first time.
- **Pay with UPI** opens GPay/PhonePe/Paytm directly. Phone numbers open the dialer.
- **Excel and backup files** (admin) open the phone's share sheet: save to Files or Drive, or send on WhatsApp.
- **Complaint photos** can be taken with the camera or picked from the gallery.
- **The status bar colour** follows the role's theme (light for students, dark for staff).
- **Locked to the official server**: the live app only talks to the Everjoy server it was built for (https). Test builds that point at a laptop show a **Laundry server** setting instead.
- **Survives weak Wi-Fi**: if the server can't be reached when the app opens, staff see "Can't reach the laundry server" and it reconnects by itself. Students still see their saved slips.

## Safety built in

- Students can only ever see **their own** orders and slips. Changing a number in the link shows "not found".
- Staff cannot open admin settings. Every rule is checked on the **server**, not just on screen.
- Passwords are stored hashed (bcrypt). Changing or resetting a password signs out the old sessions.
- Sign-in attempts are rate-limited. Sign-up is limited per network but generous, because a whole campus shares one Wi-Fi.
- Slip QR codes are random and secret. The QR contains no name or phone number.
- Complaint photos are private: only staff, admin and the student who uploaded them can open them.

## Ideas for later (not built)

- SMS/WhatsApp messages when laundry is ready (needs a paid SMS provider).
- Online payment gateway with automatic confirmation (Razorpay, etc.). Today, staff confirm UPI/cash.
- Bulk import of students from the university's Excel list at the start of a semester.
- Multiple laundry counters, with each order tagged to a counter.
