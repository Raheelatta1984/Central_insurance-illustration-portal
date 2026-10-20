# 16 — Multi-country carriers, selling permissions and event-based email

**Status:** built and verified · **Modules:** `src/core/providers.ts`, `src/core/email-config.ts`,
`src/core/erp.ts`, `src/core/routes.ts`, `src/core/demo.ts`, `src/core/guide.ts`,
`src/core/tour.ts`, `src/ui/provider-views.tsx`, `src/ui/email-views.tsx`, `src/ui/erp-views.tsx`,
`src/ui/email-views.tsx`, `src/core/mailer.ts`, `src/core/quotation.ts`, `src/core/journeydesk.ts`

Two operational facts were missing from the platform:

1. A distribution channel is not a country, a carrier is not a licence, and a Takaful permission is
   not a product attribute. Marsh can trade in three countries, appoint three carriers, sell both
   books from its call centre and Conventional only from its agency desk — and each of those is a
   filed record with its own regulator, currency, branch and reinsurance arrangement.
2. One `MAIL_FROM` cannot send a policy schedule, an information pack, a renewal request, an
   alteration, a claim letter and a reinsurance notice. Each has an owning department, its own
   address and its own words.

Both are now master data with an audit trail, an API, a screen and a sticky note.

---

## 1. The provider register

`src/core/providers.ts` holds six records that point at each other.

| Record | Filed facts |
| --- | --- |
| **Insurance provider** | id, name, legal name, home country, home currency, home regulator, home licence number, `productTypePermission` (`conventional`, `takaful`, `both`, `none`), enabled, note |
| **Provider branch** | provider × country, registration number, regulator, licence type, licence status (`licensed`, `applied`, `suspended`, `withdrawn`), currency, effective date, local premium collection, investment residence, the local regulatory requirements |
| **Reinsurance arrangement** | provider × country, reinsurer, kind (`treaty`, `facultative`, `retakaful`), basis (`quota-share`, `surplus`, `excess-of-loss`, `stop-loss`), cession in bps, retention, limit, currency, regulator reference, effective date |
| **Provider product** | provider × country × product master, local name, currency, enabled |
| **Channel-country presence** | channel × country, operating name, local licence number and status, the country's own currency, appointed providers, premium collection, investment residence |
| **Selling permission** | scope (`channel`, `sub-channel`, `partner`) × id, two booleans: Conventional, Takaful |

### The rules the registry enforces

- **A branch must exist and be licensed.** `canSell` refuses a provider with no branch in the sale
  country, and refuses an `applied`, `suspended` or `withdrawn` licence. The home licence is not a
  licence to write abroad.
- **The branch licence and the provider permission must both cover the book.** A conventional-only
  carrier cannot sell a Takaful product even if the channel and partner are enabled for both.
- **Every provider/country pair needs its own reinsurance arrangement.** Takaful business needs
  `retakaful`; a conventional treaty is not retakaful. The arrangement names the country regulatory
  reference (`CBUAE Circular 12/2025`, `PRA Solvency UK treaty filing`, `MAS RBC 2025`, …).
- **Currency is the country's own.** A GB presence is GBP, a Singapore presence is SGD. A product
  master in AED cannot be attached to a GB shelf: the server says to file a GBP local product. The
  worked example copies the product and its tariff into the local currency on the filed rate card,
  with the source row and the rate named on each copied rate row.
- **Premium is local and investment stays at origin.** The sale check refuses a branch that collects
  premium centrally or files investment at the home country, and returns a sale context naming the
  origin country, quote currency, branch that manages the premium, and the country holding the
  investment. The carrier's home country is carried separately as `capitalReportedTo`.
- **The effective permission is the intersection down the route.** Channel, sub-channel and partner
  each carry the two checkboxes; the effective permission is the narrowest. A partner cannot re-widen
  what its sub-channel has narrowed. Each permission answer carries the rows that decided it, so a
  screen can say "narrowed at sub-channel".
- **A partner shelf is checked.** The partner must have the product on its shelf, belong to the named
  channel, and be enabled; a sub-channel must belong to the channel and support the action
  (`quote`, `bind`, `service`, `claim`).
- **The gate is on the price, not only on the master screen.** `ErpManager.priceRisk` calls the same
  `canSell` when a `providerId` is named, so `POST /api/master/rates/price` refuses with
  `Sale refused: …` rather than returning a price for a route that may not sell the book. A price
  probe with no carrier is still allowed: a tariff is a price, not a sale.
- **A channel must be licensed in the country.** The channel-country presence has a licence status,
  a local licence number and an appointed-provider list; an unlicensed presence or an unappointed
  carrier is a refusal.

### The worked example

`POST /api/master/providers/seed-example` files the brief's pattern through the same public methods
the screens use — it cannot produce a state the UI could not have produced:

| | |
| --- | --- |
| Channel | `MARSH-BROKER` (broker, commission ceiling 3,000 bps) |
| Sub-channels | `MARSH-CALL-CENTRE` (both books), `MARSH-AGENCY` (Conventional only) |
| Country partners | `MARSH-AE` (AED), `MARSH-GB` (GBP), `MARSH-SG` (SGD) |
| Carriers | `AL-KHALEEJ` (both, AE), `GULF-UNION` (conventional, BH), `ETIQA` (takaful, MY) |
| Branches | six, one per carrier per country it writes in |
| Reinsurance | eight arrangements, including retakaful for the Takaful books |
| Products | twelve provider products, with GBP and SGD local filings copied from their AED masters |
| Permissions | six rows; the agency desk is `conventional: true, takaful: false` |

The seed is idempotent and skips if any provider is already filed. The demo world still starts with
**no** provider and **no** channel: commercial facts are filed, not invented at boot.

### Probes

- `POST /api/master/providers/check` answers whether this provider may sell this product through this
  channel, sub-channel and partner in this country, and why not. It returns the book, currency,
  branch, reinsurance arrangement, permission sources and the sale context.
- `POST /api/master/providers/sellable` lists every product a provider has filed for a channel and
  whether each is sellable.

### Screens

Master settings gains two gates:

- **Insurance providers, registered branches & country reinsurance** — carrier table, branch
  registration, country reinsurance and provider products by country.
- **Multi-country selling — currency and Conventional/Takaful permissions** — channel-country
  presences, the permission matrix with a Save and an Inherit per row, and the sellability probe.

Both are curated sticky notes (`master:providers`, `master:provider-selling`) rendered by the same
guide provider as every other section.

---

## 2. Email configuration

`src/core/email-config.ts` is a separate master, reachable from its own tab **Email configuration**.

### Accounts

An account has one address, a display name, a reply-to, a department, an entity and country, a daily
limit, a transport kind and the **names** of the environment settings that hold its credentials:

| Kind | Typical credential settings |
| --- | --- |
| `gmail-api` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| `smtp` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` |
| `microsoft-graph` | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` |
| `ses` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |

A settings screen must not become a secret store: the check is `^[A-Z][A-Z0-9_]{1,63}$` on the name,
and the snapshot is tested not to contain a value. One address belongs to one account. Removing an
account that events still use is refused unless the events are reassigned.

### Events

Fourteen events are filed as data, each with a label, description, category, default department,
default subject, default body and default attachments:

| Event | Seeded sender |
| --- | --- |
| `quotation.issued` | quotations |
| `policy.issued` | **issuance** |
| `information.pack` | **info** |
| `renewal.invitation` | **retention** |
| `alteration.confirmed` | **alterations** |
| `payment.receipt` | finance |
| `claim.acknowledged`, `claim.settled` | **claims** |
| `reinsurance.placement` | **reinsurance** |
| `welcome.pack`, `fund.statement`, `surrender.confirmed` | servicing |
| `lapse.notice` | retention |
| `complaint.acknowledged` | complaints |

A route carries the sending account, To/Cc/Bcc, subject, body, attachments, a service level in hours
and an enabled switch. Recipients may be fixed addresses, address-bearing placeholders
(`{{customer.email}}`, `{{agent.email}}`, `{{broker.email}}`, `{{partner.email}}`) or
`queue:<department>`, which resolves to that department's enabled mailbox.

### Templates

The placeholder list is closed (`EMAIL_PLACEHOLDERS`): tenant, customer, policy, quotation, renewal,
alteration, claim, reinsurance, payment, amount, currency, department, agent, broker, partner,
document and due date. An unknown token, an unclosed `{{`, a non-addressable recipient placeholder or
an unknown attachment key is refused **when the route is filed**, not discovered in a customer's
letter. A context that does not carry a body placeholder produces an em dash and a named warning in
the preview; a context that does not carry a recipient is a blocker.

### Preview, test and delivery

- `POST /api/master/email/preview` resolves the event against a supplied context and returns the from
  address, recipients, subject, body, attachments, blockers and warnings. It sends nothing and writes
  a `preview` row to the configuration trail.
- `POST /api/master/email/test` sends the same resolved message through the attached mail transport.
  The transport's real answer is returned: `sent` with the provider message id, or `failed` /
  `not-sent` with the sentence a human has to act on. With no credentials, the dry-run transport
  holds the message and says so; it never claims to have delivered it.
- `Mailer.send` now honours a message-level `from`. `QuotationBook` asks the tenant's email
  configuration for the `quotation.issued` account and attaches it to the outgoing MIME message, so
  the quotation really does leave from the quotations desk rather than one global address.

### The screen

The Email configuration tab is three cards and an audit trail:

1. **Accounts** — table, editor, credential setting names, department and transport.
2. **Event routes** — the fourteen events with their sender and readiness; a route editor with the
   sending account, recipients, subject, body, attachments and service level; per-row Edit, Disable /
   Enable and Reset to the filed default.
3. **Preview and delivery test** — a context editor, the resolved envelope and letter, and the
   transport's answer.

Each card carries a curated sticky note (`email:accounts`, `email:event-routes`, `email:preview`), and
the screen itself has a tab-level note in the guide. The limitation is printed on the screen: the
portal controls who sends what from where; it does not store credentials, and a configured route is
not a delivery.

---

## 3. API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/master/providers` | The whole provider snapshot: carriers, branches, arrangements, products, channel countries, permissions, diagnostics |
| POST | `/api/master/providers` | File or update a carrier |
| POST | `/api/master/providers/remove` | Remove a carrier not named by a country presence |
| POST | `/api/master/providers/branch` | Register or update a country branch |
| POST | `/api/master/providers/branch/remove` | Remove a branch |
| POST | `/api/master/providers/reinsurance` | File a country arrangement |
| POST | `/api/master/providers/reinsurance/remove` | Remove an arrangement |
| POST | `/api/master/providers/product` | Attach a product to a carrier in a country |
| POST | `/api/master/providers/product/remove` | Detach it |
| POST | `/api/master/providers/channel-country` | File the channel's country presence |
| POST | `/api/master/providers/channel-country/remove` | Remove it |
| POST | `/api/master/providers/permission` | File Conventional/Takaful at a scope |
| POST | `/api/master/providers/permission/remove` | Revert to the inherited default |
| POST | `/api/master/providers/check` | The sellability probe |
| POST | `/api/master/providers/sellable` | Every product this carrier/channel may sell |
| POST | `/api/master/rates/price` | Prices a life and, when a carrier is named, returns the sellability answer or refuses the price |
| POST | `/api/master/providers/seed-example` | The Marsh worked example |
| GET | `/api/master/email` | Accounts, event routes, placeholders, diagnostics, audit |
| POST | `/api/master/email/accounts` | File or update an account |
| POST | `/api/master/email/accounts/remove` | Remove it, optionally reassigning its events |
| POST | `/api/master/email/routes` | File or update an event route |
| POST | `/api/master/email/routes/reset` | Restore the filed default subject/body/attachments |
| POST | `/api/master/email/preview` | Resolve an event without sending |
| POST | `/api/master/email/test` | Send it through the attached transport |

The generated reference lists all 208 endpoints: [`API-REFERENCE.md`](API-REFERENCE.md).

---

## 4. Verification

| Check | Evidence |
| --- | --- |
| Branch, licence, reinsurance, currency and permission refusals | `src/core/providers.test.ts` — each missing filing is refused in turn, then the sale is allowed and the context names the origin country, currency, branch, treaty and capital-reporting country |
| Takaful segregation | the same file — a conventional treaty does not cover a Takaful product; retakaful does |
| The permission gates the price | the same file — `priceRisk` prices a Takaful risk through the call centre and refuses the same risk through the agency desk with `Sale refused: …` |
| The Marsh example | providers, branches, arrangements, country presences and permissions; call centre both, agency conventional only; GB in GBP, SG in SGD; conventional-only carrier refused Takaful; intersection cannot be widened by a partner |
| Currency and file validation | wrong-currency product, branch and presence refused; retention above limit refused; unknown country, scope and id refused; provider in use cannot be removed |
| Visibility | `src/ui/provider-email-views.test.ts` — the empty register explains what is missing; the seeded register shows carriers, branches, treaties and local products; the selling matrix shows both checkboxes and "narrowed at sub-channel"; the master rail renders both gates with curated notes |
| Email seed and event mapping | `src/core/email-config.test.ts` — ten accounts, fourteen events, the six named events from the six named departments, no blocked route |
| Template and recipient refusals | the same file — unknown placeholder, unclosed placeholder, non-addressable recipient, unknown event, unknown account, duplicate address, in-use account removal and reassignment |
| Preview and delivery honesty | `src/core/email-config.test.ts` — preview shows the letter and records an audit row; missing context is a warning, missing recipient is a blocker; the test route returns the dry-run `not-sent` with its sentence |
| Message-level sender | the same file — `Mailer.send` uses the account on the message, a Bcc header is written, the event account is the fallback when no `MAIL_FROM` is filed, and a message with no sender anywhere still fails rather than inventing one |
| API and world snapshot | the same file — `GET /master/email`, account and route filing, preview, test, and `GET /world` carrying the configuration |
| Guide coverage | `src/core/guide.test.ts` and `src/ui/guide.test.ts` — every tab and every master gate has a note, section keys resolve, and the notes carry the engine's figures |

`npm run verify` (typecheck, lint, tests with coverage, UI and server build) is the gate.

---

## 5. Limitations, stated

- **Credentials are not stored here.** The account names the environment settings; the deployer
  supplies the values. A route whose account is disabled resolves as blocked rather than falling back
  to a different mailbox.
- **Local product copies are illustrative filings.** The worked example converts the catalogue
  tariff into GBP and SGD on the filed rate card and names the source row on every copied rate row.
  A real tenant replaces them with locally approved rates before quoting.
- **The email routes are wired for the quotation dispatch today.** Policy issuance, renewal,
  alteration, claims and reinsurance routes are configured and renderable through the preview and
  test endpoints; connecting each production event to its route is the next step, and the registry is
  the seam for it (`fromAddressFor(eventKey)` and `resolve(eventKey, context)`). The Mailer also uses
  the event account as its fallback sender when no global `MAIL_FROM` is filed.
- **The country packs are configuration, not legal advice.** A regulator reference, licence number
  and cession figure are filed by the operator; the platform enforces that they exist and that they
  agree, not that they are correct for a particular licence.
- **One portal currency per country presence.** A channel that needs to quote in USD inside the UAE
  must file a separate presence; the registry refuses an AED presence filed in USD rather than
  mixing the two.
