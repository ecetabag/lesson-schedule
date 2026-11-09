# Waterpolo Lesson Schedule

Public minimalist landing page and Google Apps Script booking system.

## Data store
Google Sheet: https://docs.google.com/spreadsheets/d/1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8/edit

Tabs: `Slots`, `Bookings`, `Settings`. **Do not rename the Slots or Bookings columns**: Code.gs expects their exact column order.

### Add availability
In `Slots`, enter one row per available teaching window (e.g. an hour):

| Slot ID | Date (YYYY-MM-DD) | Start (HH:MM) | End (HH:MM) | Location | Status | Booking ID |
| --- | --- | --- | --- | --- | --- | --- |
| WP-001 | 2026-11-14 | 10:00 | 11:00 | Your pool | OPEN | |

Use a unique Slot ID per window, uppercase `OPEN`, dates in `YYYY-MM-DD`, 24-hour times. Example is not automatically booked/added. Parents choose 30 or 60 minutes. The first 30-minute booking in an hour may start on any 15-minute increment. Additional sessions must touch the occupied block on either side.

## Google Apps Script: mandatory one-time authorization
1. Open https://script.google.com/ and create a new project called **Waterpolo Lesson Schedule**.
2. Paste `Code.gs` into the code editor. Add one HTML file **Index** and paste `Index.html` into it.
3. Under **Project Settings**, set the timezone to the pool's local timezone.
4. Select `setup` and click **Run**. Grant the Google Sheets, Calendar and Mail access requested by Google. `setup()` connects to the already-created spreadsheet ID and creates the **Waterpolo Lessons** calendar. Check execution logs for its calendar ID.
5. Under **Deploy → New deployment → Web app** select **Execute as: Me** and access level suitable for your clients (e.g. Anyone). Copy the URL ending in `/exec`.
6. Edit `config.js` in GitHub and set `window.WATERPOLO_APP_SCRIPT_URL = 'https://script.google.com/macros/s/.../exec';`.
7. In the chosen GitHub repository, enable **Settings → Pages** for your published branch and folder. GitHub Pages only serves the public landing page; the Apps Script page handles bookings and rescheduling.
8. When editing `Code.gs` or `Index.html`, redeploy a **new version** of the Apps Script web app to publish changes. Editing the GitHub files alone does not update an Apps Script deployment.

## Privacy and limitations
Never commit booking data, private calendar identifiers, Google OAuth tokens, or credentials. The public repository contains source code only. Matching phone + child name does **not** authorize rescheduling: an emailed 6-digit code is required. Parents get an updated Calendar invitation when their lesson is moved. Calendar setup and deployment cannot be authorized by the GitHub connector.

## Working on future updates
Update this folder's source files. GitHub Pages changes deploy according to GitHub's configuration, whereas Apps Script backend changes must be published to Google separately. No autonomous monitoring or updates are configured.