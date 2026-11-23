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
  4. Enter **weight** (large number pad) and **clothes count** (+/−). Choose Regular or Express (if offered). Add an optional note (e.g. "1 blanket").
  5. A **live rule check** shows instantly: "No charge" / "Collect ₹30 at pickup" / "Limit is 7 kg, remove 0.4 kg" / "Monthly limit reached", plus the ready-by time.
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
  - **Monthly limit per student**: kg per month and/or orders per month (0 = no limit). When a student goes over the kg limit: **do not accept**, or **accept and charge ₹X per extra kg**.
  - **Pricing**: regular wash price per kg (0 if laundry is part of hostel fees), **express service** on/off with fee and ready time.
  - **Payments**: require payment before pickup; UPI ID and name for the student's Pay with UPI button.
  - Counter timings text.
  - **Hostels**: add, rename, hide.
- **Activity log**: every important action (orders, handovers, corrections, cancellations, payments, approvals, password resets, rule changes with old and new values, exports, backups) with who and when. It cannot be edited.
- **Counter mode**: the admin can switch to the staff counter screens in one tap and come back.

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
