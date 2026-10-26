# ICT Inquiry Desk: setup guide

A static web page with no server of your own. Clients fill in a form on the page, which **POSTs to an endpoint** (a free Google Apps Script web app that stores inquiries in a Google Sheet). ICT staff sign in on the same page and take work **first in, first out**.

```
Client form (index.html)  --POST-->  Apps Script endpoint  -->  Google Sheet
Staff view (index.html)   <--GET---  Apps Script endpoint       (Inquiries + Assignments tabs)
```

Try it first: serve the folder on `localhost` and open the page. With no endpoint configured, the app starts with no sample inquiries or preset accounts. Create the first administrator, then use **Manage users** in the staff dashboard to add accounts. Inquiries, assignments, and accounts are stored in that browser only.

## 1. Create the endpoint

1. Create a new Google Sheet (any name).
2. **Extensions > Apps Script**, paste the contents of `apps-script.gs`.
3. Change `SECRET` to a long random string.
4. In Apps Script, select and run `authorizeEmail`, then approve the requested mail permission. This lets the web app send from the Google account that owns the script.
5. **Deploy > New deployment > Web app**. Execute as **Me**, who has access **Anyone**. Authorize when asked.
6. Copy the web-app URL.

In `index.html`, edit the CONFIG block:

```js
submitUrl: "https://script.google.com/macros/s/.../exec",
syncUrl:   "https://script.google.com/macros/s/.../exec",   // same URL
syncKey:   "the same SECRET",
```

After you change `apps-script.gs` later, use **Deploy > Manage deployments > Edit > New version**, or the URL keeps running the old code.

## 2. What the endpoint does

| Request | Needs the secret? | Effect |
|---|---|---|
| `POST {op:"submit", ...}` (client form) | No | Validates, adds a row to the **Inquiries** tab, returns a reference such as `INQ-0007` |
| `GET ?what=inquiries` | Yes | Returns all inquiries to staff |
| `POST {op:"reply", id, message}` | Yes | Emails a staff reply to the address on the ticket and records the sent reply |
| `GET` / `POST claim, update` | Yes | Shared assignments, with a check that stops two agents taking the same ticket |

New client inquiries receive an email receipt from the script owner's Google account. Staff can email clients from a ticket's **Email replies** section; internal **Notes** remain private. A saved inquiry remains saved if its receipt email fails, and the client sees a warning instead of a false email-success message.

After updating an existing Apps Script deployment, go to **Deploy > Manage deployments > Edit > New version**. If the new mail permission was not granted, run `authorizeEmail` in the Apps Script editor and approve it, then deploy the new version. Google Apps Script daily recipient quotas apply.

Protection on the public submit action: required-field and email checks, length limits, a hidden honeypot field, one submission per email per 30 seconds, a desk-wide cap of 120 per hour, and formulas in typed text are neutralised before they reach the Sheet. Edit the constants at the top of the script to change the limits.

Rules for the Sheet: do **not** delete or re-sort rows on the **Inquiries** tab. Ticket numbers and FIFO order come from the row position.

## 3. Staff accounts and roles

On first use, create the administrator account from the setup screen. Administrators can add users, change any other user's role, or delete accounts from **Manage users** in the staff dashboard. The current admin cannot change or delete their own account, and the last admin cannot be demoted or deleted. Changing an active user's role to viewer or deleting their account returns their open tickets to the queue while preserving ticket notes. Usernames must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens. Passwords must be at least 12 characters.

| Role | Can do |
|---|---|
| `admin` | See everything, take next in line, auto-assign, reassign or unassign, update any ticket |
| `agent` | See the queue, take **only the oldest waiting inquiry**, assign or reassign unresolved tickets, update and add notes to their own tickets |
| `viewer` | Read-only |

Accounts are saved in the current browser's local storage and are not shared across browsers or devices, even when an inquiry endpoint is configured. For production, implement authentication and user management in a secured backend; the static page's local sign-in is only a convenience gate, not real access control.

## 4. Add external ticket sources

An administrator can open **Ticket sources** in the staff dashboard and add multiple Apps Script web-app URLs. For each source, enter its deployed URL, the `SECRET` configured in that source's `apps-script.gs`, and optionally a display name. Each source must use this project's Apps Script API and return inquiries from `GET ?key=...&what=inquiries`. The desk reads the sources on refresh and displays their tickets alongside the main queue; source tickets are identified separately and show their source name.

The same admin tab includes a configurable **osTicket queue link**, prefilled with the URSB staff queue. **Open osTicket queue** opens the configured HTTPS URL in a new tab. This is a shortcut only: the `/scp/tickets.php` staff page is not fetched or imported into the desk. URL settings are local to the administrator's browser. For live osTicket ticket data and replies, see [OSTICKET-INTEGRATION.md](./OSTICKET-INTEGRATION.md).

External source settings and keys are saved in the administrator's browser only. Other staff browsers need their own source configuration. External tickets are read-only at their source; assignments and notes are saved to the desk's configured `syncUrl` (or this browser if there is no shared assignment store). Apps Script access keys are sent to their endpoint and are visible to users with access to that browser. This static design is not suitable for secrets or sensitive ticket data; use a secured backend for production.

The main inquiry source and external sources are read in order: the configured main source first, followed by external sources in the order they were added. FIFO is preserved within each source; separate systems do not provide a shared arrival order.

## 5. How FIFO works

- Waiting = not assigned and not resolved, ordered by arrival.
- **Take next in line** always gives the agent the oldest waiting inquiry. Agents cannot pick a newer one.
- **Auto-assign** (admin) hands waiting inquiries out oldest-first to the agent with the fewest open tickets.
- `maxActivePerAgent` (default 5) stops one agent hoarding work.
- Returning a ticket to the queue puts it back at its original place, not the end.
- Admins can assign manually out of order. That is the deliberate override.

## 6. Host it

Any static host works: GitHub Pages, Netlify, Cloudflare Pages, or your own web server. Staff sign-in uses the browser's crypto API, which needs **HTTPS** (or `localhost`). To run locally, from this folder use `python -m http.server 8000`, then open `http://localhost:8000`.

## Using a different submission endpoint

The form sends one POST with `Content-Type: text/plain` and this JSON body, and expects `{"ok":true,"ref":"INQ-0007"}` back (or `{"ok":false,"error":"rate" | "busy" | "invalid"}`):

```json
{"op":"submit","name":"","email":"","phone":"","subject":"","priority":"Normal","message":"","website":""}
```

Point `submitUrl` at your own service if you have one. To enable staff replies, the service must also implement the authenticated `POST {op:"reply", id, message, by}` operation; staff actions use `syncUrl` and `syncKey` as described above. The receipt/reply email behavior described here is provided by `apps-script.gs`.

## osTicket queue and replies

To keep osTicket as the ticket system of record while managing assignments in this desk, see [OSTICKET-INTEGRATION.md](./OSTICKET-INTEGRATION.md) for the middleware/plugin API contract. osTicket's `open.php` form and native API key alone do not provide the ticket-list and thread-reply operations required. The contract is not yet implemented or configured, so the public desk is not connected to osTicket.

## Honest limits of a no-backend design

- **Staff sign-in is a gate, not real security.** Local accounts and password hashes are stored in browser storage, and anyone technical can bypass the check in their browser. Accounts also do not sync between devices.
- **The sync key is in the page source too**, so anyone who finds it can read the inquiries. Treat inquiries as low-sensitivity, and tell clients not to submit passwords or personal secrets. For real access control you need a backend with real logins.
- The public submit action can still be spammed within the limits above. Add a CAPTCHA at your own endpoint if that becomes a problem.
- Two people editing the **same** ticket's notes at the same moment: the later save wins.
