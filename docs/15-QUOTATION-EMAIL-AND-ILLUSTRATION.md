# The quotation email, and the benefit illustration inside it

**Status:** built and verified · **Modules:** `src/core/mailer.ts`, `src/core/quotation.ts`, `src/core/illustration.ts`, `src/core/channels.ts`, `src/core/journeydesk.ts`, `src/ui/journey.tsx`, `src/ui/channel-views.tsx`

Two things were wrong with a quotation, and both are now fixed in the core rather than in the
presentation:

1. **The email was never sent.** `QuotationBook.dispatch` wrote an email *record* — a masked
   address, a subject, a body, an attachment fingerprint — and handed it back. Nothing left the
   building. The audit trail proved that the system had decided to email the customer, which is the
   one thing the customer cannot use.
2. **The quotation had no illustration.** A twenty-year unit-linked plan was quoted with a premium
   and a sum assured, and no year-by-year projection at all: no 10-year figure, no 20-year figure,
   no three growth scenarios, and no statement of the payment term the customer had chosen.

---

## 1. The email now leaves the building

### What happens now

```
POST /api/journey/submit  { stageId: 'quotation', answers: { …, sendEmail: true } }
  → the journey issues the quotation (PDF written, compliance gates checked)
  → deliverQuotation() composes an RFC 822 message and hands it to the transport
  → the delivery result is written back onto the same quotation version
  → the response carries `delivery: { status, providerMessageId, … }`
```

Resending is its own route — `POST /api/journey/quotation/email` — so a customer who did not
receive it can be sent another copy without re-issuing (and without a new version number).

### Transport: Gmail API (OAuth2), not SMTP

Google has been turning off "less secure apps" and password-in-SMTP for years. The supported path
is OAuth2 and `users.messages.send`, which is what `GmailApiTransport` speaks:

| Step | Call |
| --- | --- |
| 1 | `POST https://oauth2.googleapis.com/token` — `grant_type=refresh_token` with the client id, client secret and refresh token |
| 2 | `POST https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send` with `Authorization: Bearer <access token>` and `{ "raw": <base64url RFC 822> }` |

The access token is cached until it is 60 seconds from expiry. A `401` on send refreshes once and
retries exactly once — a refresh loop is a way to get an account locked.

### Configuration

| Variable | Meaning |
| --- | --- |
| `MAIL_FROM` | the address quotations are sent from (required; nothing is sent without it) |
| `MAIL_FROM_NAME` | the display name, e.g. `Central Insurance quotations` |
| `GOOGLE_CLIENT_ID` | OAuth client id from the Google Cloud project |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | the refresh token obtained once, offline |
| `GOOGLE_ACCESS_TOKEN` | optional: a short-lived token, for CI. Skips the refresh exchange |
| `GOOGLE_MAIL_USER` | `me` (default), or the mailbox when sending as a delegated user |
| `MAIL_DRY_RUN=1` | force the hold-and-record transport even with credentials present |
| `GOOGLE_TOKEN_URL`, `GMAIL_API_BASE_URL` | overrides for the two endpoints — used by the smoke test |

**Getting a refresh token** (once, on a laptop, not on the server):

1. Google Cloud console → APIs & Services → **enable the Gmail API** → OAuth consent screen
   (Internal is fine for your own domain) → Credentials → **OAuth client ID → Desktop app**.
2. Add the scope `https://www.googleapis.com/auth/gmail.send` — send only, never read.
3. Run the OAuth playground or `curl` the consent URL with `access_type=offline&prompt=consent`,
   exchange the authorisation code at `https://oauth2.googleapis.com/token`, and keep the refresh
   token. It does not expire until it is revoked.
4. Put the four values in the environment (Render/Railway/Fly secret store; locally, `.env`).

### Honesty about failure

With no credentials filed the mailer does not pretend. The transport is `dry-run`: it records the
message it *would* have sent, and every screen that shows delivery says so. The boot log prints one
line:

```
Quotation email: LIVE via gmail-api from quotations@central-insurance.example.
Quotation email: NOT DELIVERED (dry-run) — No Gmail API credentials are filed (…).
```

A delivery is one of three outcomes, all recorded on the quotation:

| Status | Meaning |
| --- | --- |
| `sent` | the provider accepted it; `providerMessageId` is Gmail's message id |
| `failed` | the provider refused it (403/429/5xx) or the network broke; `error` and a sentence a human can act on are stored |
| `not-sent` | no mailer is attached at all — nothing was attempted, and the record says why |

A failed delivery never rolls back an accepted quotation stage.

### What the customer receives

`multipart/mixed`, with the body as a `multipart/alternative` pair and the PDF as an attachment:

```
From:    Central Insurance quotations <quotations@central-insurance.example>
To:      the customer's real address                ← the audit copy keeps it masked
Subject: =?UTF-8?B?…?=                              ← RFC 2047, so an Arabic subject survives
X-Quotation, X-Document-Fingerprint, X-Consent      ← the audit trail travels with the message
  multipart/alternative
    text/plain; charset=utf-8   the figures as fixed-width text
    text/html;  charset=utf-8   the same figures in a table, with a Buy online button
  application/pdf               the quotation document
```

The audit record stores the masked address (`a********i@example.ae`); only the transport ever sees
the real one.

### Verifying it without a real mailbox

```
npm run build:server && npm run mail:smoke
```

`tools/mail-smoke.mjs` stands up a stand-in for the two Google endpoints on localhost, points the
mailer at them, walks a whole journey to the quotation stage with *send the email* ticked, and
inspects what Google would have received: the envelope, the address, the bilingual body, the
illustration table, and a PDF that really starts with `%PDF-`. It then makes the provider refuse
once, to prove a failure is recorded rather than swallowed. The message it received is written to
`tmp/mail-smoke-message.eml` and the attachment to `tmp/mail-smoke-quotation.pdf`. Every check
passes today.

---

## 2. The illustration

### What the customer now sees

A projection over **the benefit term they chose** — one row per policy year, with milestone rows
(the 10-year, 20-year, 30-year, and end-of-term figures) printed in the PDF, in the email body and
on the console — under **three return scenarios**, with **the payment term they selected**:

```
Milestone                        Year  Age   Premiums paid        Fund low          Fund mid         Fund high          On death
After 10 year(s)                   10   51  498,442.50 AED  449,958.65 AED    563,801.40 AED    708,273.35 AED  1,020,000.00 AED
End of the 20-year benefit term    20   61  498,442.50 AED  524,753.16 AED  1,040,160.61 AED  1,977,378.26 AED  1,040,160.61 AED

49,844.25 AED every year for 10 year(s), with cover running for 20 year(s).
```

For a non-investment-linked product (term life, critical illness) the same table shows the cover in
force and the premiums paid instead of a fund value, because there is no fund.

Charges are the ones the unit-linked engine actually applies — allocation charge, monthly cost of
insurance, monthly administration fee — not a flat growth assumption. Every figure is decimal
`BigInt` money; nothing is a float.

### Where the three rates come from

The rates are **filed, not hardcoded**. Five layers, narrowest first:

| Layer | Where it is filed | Example of when you would use it |
| --- | --- | --- |
| sub-channel | product × omni-channel × sub-channel | the bank counter is sold more conservatively than the bank's app |
| omni-channel | product × omni-channel | every broker illustration assumes 6% mid |
| product | the product master | the unit-linked plan's own assumption |
| regulatory pack | `src/core/regulatory.ts` | AE 4/8/12%, MY 3/6.5/9.5% |
| built-in floor | `src/core/illustration.ts` | the last resort, and visibly labelled as such |

A figure left blank **inherits from its parent**, so narrowing one number is one row, not a copy of
the whole table. Every figure on the quotation states which row it came from — "the regulatory
pack", "omni-channel BANCASSURANCE", "sub-channel BANCA-COUNTER" — so a projection can be defended
figure by figure.

### The API

| Route | Purpose |
| --- | --- |
| `GET /api/master/illustration-rates` | every filed row, the audit trail, and what each product resolves to today |
| `POST /api/master/illustration-rates` | file a row (product, or product × channel, or product × channel × sub-channel) |
| `POST /api/master/illustration-rates/remove` | clear a row, so the scope inherits again |
| `POST /api/journey/illustration/preview` | build a projection before a quotation exists — refused if the product is not filed |
| `POST /api/journey/quotation/email` | (re)send the quotation |
| `GET /api/mail/status` | transport, from address, whether it is live, session counts, which settings are present (never their values) |
| `POST /api/mail/test` | send one short message to a real address, to prove the credentials before a customer is promised anything |

Refusals are the useful part: a product not in the factory, a channel not filed on the tenant, and
a malformed address are all refused at the boundary rather than silently defaulted.

### The console

- **Customer journey → quotation card**: the milestone table, the full year-by-year table behind a
  disclosure, the assumptions, the payment terms, and a delivery row saying *sent / failed /
  not-sent* with Gmail's message id and the provider's reason when it failed. A **Resend** button
  calls the email route; it refuses to send to a masked address.
- **Customer journey → aside**: a **Mail** panel showing the transport, the from address, whether
  delivery is live, the session's sent/failed/not-sent counts, which settings are present, and the
  last attempt — with a *Send a test email* button.
- **Master → Omni-channel**: the **Illustration rates** grid — every filed row, what each product
  resolves to, and a filer that narrows by product, channel and sub-channel.
- **Customer journey → coverage**: two new answers, *premium paying term* (blank = the whole benefit
  term) and the *omni-channel / sub-channel* the sale came through, which is what selects the rate
  row.

---

## What is verified

| Check | Where |
| --- | --- |
| The transport is really called, with the customer's full address and a PDF that starts with `%PDF-` | `src/core/quotation-delivery.test.ts` |
| A provider refusal is recorded on the quotation; the quotation itself is untouched | same |
| No mailer attached → `not-sent`, and the console says so rather than pretending | same |
| The message carries the illustration, in both body parts, and the PDF is a disposition not a body part | same |
| The delivery history is kept, newest first, for the operator chasing "it never arrived" | same |
| The rate cascade: sub-channel → channel → product → pack → built-in, with per-figure sources | `src/core/channels.test.ts` |
| A product the factory does not hold, and a channel the tenant has not filed, are refused | same |
| The projection engine: money conserved, term covered, premium term honoured | `src/core/illustration.test.ts` |
| The routes: status, test button, filer, preview, and the 400s | `src/core/routes.test.ts` |
| End to end against a stand-in for Google, including a refusal | `npm run mail:smoke` |

## Deliberately not done

- **No SMTP transport.** You chose the Gmail API; adding SMTP would mean a second credential path to
  secure and a second library. `MailTransport` is an interface, so an SMTP transport can be added
  later without touching the mailer, the quotation or the console.
- **No tracking pixels or read receipts.** A quotation email is a controlled document; the audit
  trail records what was sent and what the provider answered, not whether the customer opened it.
- **No queue or retry daemon.** A failed delivery is recorded with the provider's answer and a
  sentence a human can act on, and the console offers a Resend button. A background retry loop
  belongs to an outbox, which is a separate chunk.
- **The PDF is still text-only** (`src/core/pdf.ts`, Helvetica/WinAnsi). Arabic in the PDF renders
  as `?`; the illustration table is therefore laid out in characters, and the email's HTML part is
  where the bilingual table renders properly.
