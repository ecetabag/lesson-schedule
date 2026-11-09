# Waterpolo Lesson Schedule

A minimal booking site with a **real serverless API**. The old Google Apps Script web app is no longer used by the public booking interface. Source is maintained at **ecetabag/lesson-schedule**.

**Deployment status:** Source is committed to GitHub. The backend is **not live** until you deploy it to Vercel and configure the secret environment variables. The GitHub Pages front end currently shows a helpful configuration message instead of sending customers to the broken Apps Script page.

## Architecture
- Website: GitHub Pages (or deploy entire repo to Vercel).
- API: `api/index.js` on Vercel, `/api/index` route; Node.js 20+.
- Database: [Waterpolo Lesson Schedule](https://docs.google.com/spreadsheets/d/1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8/edit) — `Slots` and `Bookings` tabs.
- Calendar: a separate Waterpolo Lessons calendar with ID provided in `.env.example`.
- Google OAuth: server-side access to Sheets, Calendar Events and Gmail (for one-time verification codes).
- Upstash Redis: distributed booking locks and expiring rescheduling verification codes. Required; without a lock, duplicate bookings are possible.

No payments, and do **not** put secrets, refresh tokens, or contact details in public GitHub files.

## 1. Deploy the API to Vercel
1. Sign in at https://vercel.com and **Add New → Project**.
2. Import the GitHub repository `ecetabag/lesson-schedule`. Choose the **Other** framework preset (no frontend build command required).
3. Before deploying, set the environment variables below in Vercel Project Settings → Environment Variables; save them for Production, Preview if desired, and Development if desired.
4. Deploy. Vercel will deploy the site at `https://YOUR-PROJECT.vercel.app/` and the API at `https://YOUR-PROJECT.vercel.app/api/index?action=health`.
5. Open the health URL. `{"ok":true,"configured":true}` means all required variables are present (but does NOT prove the Google APIs are authorized). Then open `/api/index?action=availability&duration=30` to test Google access.
6. For GitHub Pages, edit `config.js` and set `window.WATERPOLO_API_URL='https://YOUR-PROJECT.vercel.app/api/index';`. Do not add a trailing slash.

Vercel can serve the full website itself, without GitHub Pages. If you use the Vercel site, API requests work on the same origin.

## 2. Google OAuth credentials (required, one time)
This is **not** your old Apps Script deployment URL. Google permissions granted to Apps Script do not automatically grant access to Vercel.

1. Open https://console.cloud.google.com and create/select a project.
2. Enable **Google Sheets API**, **Google Calendar API**, and **Gmail API**.
3. Configure **Google Auth Platform → Branding / Audience**. Use the Google account that owns the Sheet and lesson Calendar. If the app is in Testing mode, refresh tokens may expire after seven days; production settings and Google verification requirements vary by scopes and account.
4. Create an OAuth Client ID of type **Web application**, adding the authorized redirect URI `https://developers.google.com/oauthplayground`.
5. Open https://developers.google.com/oauthplayground/ , use the settings gear → **Use your own OAuth credentials**. Enter that OAuth Client ID and secret (only into Google's UI, never into chat/GitHub).
6. Request these exact OAuth scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.send`
7. Authorize the Google account that owns your Sheet and Calendar, then exchange the authorization code for tokens in OAuth Playground.
8. Copy the **refresh token** into the `GOOGLE_REFRESH_TOKEN` secret in Vercel. Copy your Client ID and Client Secret into their matching environment variables. **Never paste them into ChatGPT or GitHub.**
9. Check the OAuth app publishing status and refresh-token lifetime before taking real bookings. Gmail access may require additional verification depending on account type.

## 3. Upstash Redis (required, one time)
Create a Redis database at https://upstash.com . Copy its REST URL and REST Token **into Vercel environment variables** `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. These store only short-lived locking keys, verification codes (hashed), and time-limited verification sessions — Google Sheets remains the booking database.

## 4. Required environment variables
Use the variable names and non-secret IDs in `.env.example`.

| Variable | What to set |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth Client ID from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Refresh token with Sheets/Calendar/Gmail scopes |
| `GOOGLE_SHEET_ID` | `1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8` |
| `GOOGLE_CALENDAR_ID` | Calendar ID from `.env.example` |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token |
| `LESSON_TIMEZONE` | `America/Los_Angeles` (change if the pool is elsewhere) |
| `SITE_ORIGIN` | `https://ecetabag.github.io` for GitHub Pages |
| `ADDITIONAL_ORIGINS` | Optional comma-separated allowed frontend origins |

## 5. Enter lesson availability in Google Sheets
[Open your Sheet](https://docs.google.com/spreadsheets/d/1ko_r6wSoerKj4XOKOPKHq7f4TFE9xlsqnJ7h00SwTK8/edit).

In the `Slots` tab, enter one **available teaching window** per row:

| Slot ID | Date (YYYY-MM-DD) | Start (HH:MM) | End (HH:MM) | Location | Status | Booking ID |
|---|---|---|---|---|---|---|
| WP-001 | 2026-11-14 | 10:00 | 11:00 | Your pool | OPEN | |

The first customer can book 30 minutes at any 15-minute starting increment inside a window. Subsequent customers can only book **adjacent** appointments, avoiding gaps. A 60-minute lesson requires 60 contiguous minutes. The API checks Calendar conflicts and Google Sheet bookings before confirming.

**The `Bookings` tab is automatically maintained by the API.** It contains student and parent details, duration, Calendar ID and status; don't publish the Sheet publicly.

## 6. Booking and rescheduling API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/index?action=health` | Safe status/configuration check |
| GET | `/api/index?action=availability&duration=30` | Available 30- or 60-minute starts |
| POST | `/api/index` `{"action":"book",...}` | Create calendar event + save Sheet row |
| POST | `/api/index` `{"action":"requestCode","phone":"...","kidName":"..."}` | Email a six-digit verification code (generic response) |
| POST | `/api/index` `{"action":"verifyCode","phone":"...","kidName":"...","code":"..."}` | Get temporary management token |
| POST | `/api/index` `{"action":"manageTimes",...}` | Get eligible times after verification |
| POST | `/api/index` `{"action":"reschedule",...}` | Move existing calendar event + Sheet row |

Do not send or post verification codes or credentials publicly. The API applies a per-date distributed lock before creating or moving bookings, and it rechecks availability while holding the lock. Clients receive Calendar invitations; private student details are not returned by availability requests.

## 7. Troubleshooting
- `health` says `configured:false`: Vercel is missing an environment variable. Add it and redeploy.
- `availability` returns `503`: Google refresh token expired/not configured or Redis is unreachable.
- `availability` returns `502`: Check authorized scopes, Sheet ID, Calendar ID, and access to both.
- `availability` returns no slots: Confirm `Slots` dates/times, `OPEN`, timezone, and at least one future window.
- GitHub site says API not deployed: update `config.js` after Vercel gives you the URL.
- Do not enter real client details until one test booking and one reschedule both succeed in the Sheet and Calendar.

The old `Code.gs` and `Index.html` are retained as **legacy migration references** but are not used by the new API.
