# osTicket integration contract

This contract lets the ICT Inquiry Desk manage its own assignment queue while
osTicket remains the system of record for ticket creation and client replies.
It does not change the osTicket web interface or its configuration.

The integration requires a small middleware service on the osTicket network and
an osTicket plugin/custom API that implements the upstream contract below. The
existing `open.php` form does not implement these operations. Until the
middleware and upstream API are deployed, the desk is not connected to
osTicket.

## Request flow

1. A client submits the ICT Desk form to the middleware.
2. The middleware validates the request and creates a ticket through the
   osTicket API. osTicket returns its ticket ID and number.
3. Staff use the desk queue, which reads tickets from the middleware.
   Assignments, notes, and queue order remain managed by the desk.
4. When staff send a client reply in the desk, the middleware posts it to the
   osTicket ticket thread. osTicket delivers the client email using its normal
   notification behavior.

## Browser-to-middleware API

All paths are relative to the configured middleware base URL. Requests and
responses use JSON. The middleware must use HTTPS.

### Submit a ticket

`POST /api/v1/tickets`

Public endpoint. It must validate and rate-limit requests, reject honeypot
submissions, and use the idempotency key to avoid duplicate tickets on retries.

Headers:

```http
Content-Type: application/json
Idempotency-Key: <unique client-generated value>
```

Request:

```json
{
  "name": "Amina User",
  "email": "amina@example.org",
  "phone": "+256700000000",
  "subject": "Cannot access email",
  "priority": "Normal",
  "message": "Please help restore access.",
  "website": ""
}
```

Successful response (`201 Created`):

```json
{
  "ok": true,
  "ticket": {
    "id": "ost-1842",
    "number": "004218",
    "createdAt": "2026-10-26T08:00:00Z"
  }
}
```

The middleware must return the same result for a repeated idempotency key.
Validation errors use `400` with `{"ok":false,"error":"invalid"}`; rate limits
use `429` with `{"ok":false,"error":"rate_limited"}`. Upstream failures must
return a non-2xx status and must not claim the ticket was created.

### List tickets for the staff queue

`GET /api/v1/tickets?cursor=<opaque-cursor>`

Requires an authenticated staff session. Returns tickets in stable
oldest-first order and supports pagination. The middleware must never return a
partial successful response if fetching from osTicket fails.

Successful response (`200 OK`):

```json
{
  "ok": true,
  "tickets": [
    {
      "id": "ost-1842",
      "number": "004218",
      "createdAt": "2026-10-26T08:00:00Z",
      "updatedAt": "2026-10-26T08:00:00Z",
      "name": "Amina User",
      "email": "amina@example.org",
      "phone": "+256700000000",
      "subject": "Cannot access email",
      "priority": "Normal",
      "status": "Open",
      "message": "Please help restore access."
    }
  ],
  "nextCursor": null
}
```

`id` is an opaque, stable identifier used in reply requests. `number` is the
human-readable osTicket ticket number. Priority values are `Low`, `Normal`,
`High`, or `Urgent`; status is a display value. The desk owns assignment and
internal notes; the middleware does not change osTicket assignment or status.

### Send a ticket reply

`POST /api/v1/tickets/{id}/replies`

Requires an authenticated staff session and permission to reply. The middleware
must append the message to the matching osTicket thread, use osTicket's normal
client email notification behavior, and make retries safe with an
idempotency key.

Headers:

```http
Content-Type: application/json
Idempotency-Key: <unique reply identifier>
```

Request:

```json
{
  "message": "We have restored your access. Please try again.",
  "by": "ict.agent"
}
```

Successful response (`201 Created`):

```json
{
  "ok": true,
  "reply": {
    "id": "reply-9021",
    "ticketId": "ost-1842",
    "sentAt": "2026-10-26T08:15:00Z"
  }
}
```

The reply is successful only after osTicket accepts it. Return `404` for an
unknown ticket, `403` for an unauthorized staff member, `400` for invalid
content, and a non-2xx response for delivery/upstream failures.

## Middleware-to-osTicket API

The osTicket plugin/custom API on the private network must expose equivalent
ticket operations to the middleware. Its base URL and service credential are
server-side configuration only.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/tickets` | Create an osTicket ticket; accept the intake fields and an idempotency key |
| `GET` | `/api/v1/tickets?cursor=...` | Return tickets using the list response shape above |
| `POST` | `/api/v1/tickets/{id}/replies` | Add a thread entry and trigger osTicket's normal client notification |

Authenticate middleware-to-osTicket requests with a server-side bearer token
over HTTPS. The API must enforce permissions, validate ticket IDs and reply
content, and return errors using the same status semantics. It must not expose
the bearer token in responses or logs.

## Authentication and deployment requirements

- The public static page must never contain osTicket credentials or a shared
  staff API key.
- Ticket listing and reply operations require real server-validated staff
  authentication. The desk's current browser-local accounts are not server
  authentication and cannot protect this API.
- Use HTTPS, secure `HttpOnly`/`SameSite` staff-session cookies, CSRF
  protection, and restrict browser origins to the deployed desk site.
- Keep osTicket's service token in the middleware's environment/secret store.
- Keep the middleware reachable only through its intended public intake and
  authenticated staff routes; restrict osTicket API access to the middleware
  host or private network.
- Do not return success from the intake or reply route when the corresponding
  osTicket operation failed.

## Not implemented by this contract

This document defines the interface only. It does not install an osTicket
plugin, create the middleware service, add server-side staff accounts, or
connect the current GitHub Pages app. Those components must be implemented and
deployed before live synchronization and replies can work. osTicket's native
API key and `open.php` form alone do not provide the required list-and-reply
contract.
