# NetSuite ↔ n8n — findings and roadmap

Working notes from the 2026-08-30 session. Covers the authentication decision, the
account-side setup that is still blocking, and what remains to build.

---

## 1. Constraint that shapes everything

The integration must run **without deploying any SuiteScript** to NetSuite. No RESTlets,
no UserEvent scripts, no SDF project. Only the stock REST API.

Consequences:

| Capability | Available without scripts? |
|---|---|
| CRUD on records (`/record/v1`) | yes |
| Upsert by externalId (`PUT /{type}/eid:{id}`) | yes |
| Transform (SO→Invoice etc., `!transform`) | yes |
| Ad-hoc queries (SuiteQL, `/query/v1/suiteql`) | yes |
| Record/field metadata (`metadata-catalog`) | yes |
| File Cabinet (`/record/v1/file`) | yes |
| **Saved searches** | **no** — no REST endpoint exists; SuiteQL must replace them |
| **Push notifications from NetSuite** | **no** — requires a UserEvent script; polling only |

So **SuiteQL is the primary read path**, and triggers can only be polling-based
(SuiteQL over `lastmodifieddate` with a cursor in `getWorkflowStaticData()`).

## 2. Authentication: OAuth 2.0 M2M, not TBA

Two flows exist and both are now implemented in this package.

**TBA / OAuth 1.0a** (`netSuiteApi`) — no token endpoint; every request is signed locally.
Works today, but see the query-parameter caveat in `CLAUDE.md`.

**OAuth 2.0 Client Credentials / M2M** (`netSuiteOAuth2Api`) — the chosen direction:

1. Build a JWT: header `{alg, typ: "JWT", kid: <Certificate ID>}`, payload
   `{iss: <Client ID>, scope: "rest_webservices", aud: <token URL>, iat, exp}` (`exp` ≤ 1 h).
2. Sign it with the private key matching the certificate uploaded to NetSuite.
3. `POST https://{account}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`
   form-urlencoded, with `grant_type=client_credentials`,
   `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
   `client_assertion=<jwt>`.
4. Use the returned `access_token` as `Authorization: Bearer …` (valid 3600 s, no refresh
   token — just mint a new assertion).

This flow is **already proven** outside n8n, in `c:\dev\nc_projects\ns_integration`
(`src/auth.js`, `src/netsuite.js`, `src/cache.js`) — a plain Node/axios prototype using
ES512 with an EC `secp521r1` key. `NetSuiteOAuth2Api.credentials.ts` is a port of it;
n8n's `preAuthentication` + `expirable` replaces the prototype's file cache.

## 3. Role permissions — resolved

**No longer blocking.** A fresh M2M setup in `TSTDRV1204919` works end to end (see section 6),
so this section is kept only as the account-setup checklist.

The original symptom, for reference: with the prototype in account **`8129406_SB1`** — *not*
the account used now — the token request succeeded (`access_token`, `expires_in: 3600`) while
the very next `GET /record/v1/customer?limit=5` returned 401 `INVALID_LOGIN`. The token carried
`"sub": "1643;1536"` (`entityId;roleId` from the M2M mapping), so the mapping existed and the
failure was at the data-access stage — that role lacked the permissions listed below. Nothing
about that carries over to the current account; only the checklist does.

### Required account setup

Features — Setup → Company → Enable Features → SuiteCloud:

- **OAuth 2.0** (Manage Authentication block)
- **REST Web Services** (SuiteTalk block)
- **SuiteAnalytics Workbook** — required for SuiteQL

Role permissions — Setup → Users/Roles → Manage Roles → *the integration role*:

| Tab | Permission | Level | Why |
|---|---|---|---|
| Setup | **REST Web Services** | Full | mandatory; prime suspect for the 401 |
| Setup | **Log in using OAuth 2.0 Access Tokens** | Full | second suspect |
| Setup | SuiteAnalytics Workbook | Full | SuiteQL |
| Lists | Perform Search | Full | list reads and SuiteQL |
| Lists | Customers | as needed | the `customer` resource |
| Transactions | Invoice | as needed | the `invoice` resource |

Note `Log in using Access Tokens` is **TBA-only** and is *not* what OAuth 2.0 needs.

Also check: the role is actually assigned to employee `1643` and that employee is active;
no IP restrictions (Setup → Company → Company Information → Allowed IP Addresses, and the
same at role level).

**Definitive diagnostic:** Setup → Users/Roles → User Management → **View Login Audit Trail**.
NetSuite's own error text points there, and its `Detail` column names the exact reason —
faster than guessing at permissions.

## 4. Where the credential values come from

| Field | Source |
|---|---|
| **Account ID** | e.g. `8129406_SB1` — uppercase with underscore |
| **Client ID** | *Consumer Key* of the Integration record: Setup → Integration → **Manage Integrations**. Requires **Client Credentials (Machine to Machine) Grant** enabled and the **REST Web Services** scope selected. Shown **once** on save — not retrievable later, only resettable. The Consumer Secret is not used by the JWT flow. |
| **Certificate ID** | Setup → Integration → **OAuth 2.0 Client Credentials (M2M) Setup** → Create New: pick Entity, Role, Application (the Integration record) and upload the public certificate. Visible in the list **at any time**, unlike the Consumer Secret. |
| **Private Key** | The PEM matching the uploaded certificate. |

The M2M Setup page is also **where the failing role is selected** — see section 3.

### Which account

**All verification happens in `TSTDRV1204919`** (Nelson Holdings — MULTI BOOK and RR, LOG DEMO).
That is where the TBA path was proven live, so OAuth 2.0 can be compared against TBA on the
same records.

This means the values in `c:\dev\nc_projects\ns_integration\.env`
(`NS_ACCOUNT_ID=8129406_SB1`, `NS_CLIENT_ID`, `NS_CERTIFICATE_ID`, `private2.pem`) are **not
reusable** — M2M setup is per-account: the Integration record, the Certificate ID and the
entity/role mapping all live inside one account. A fresh Integration record, certificate and
M2M mapping must be created in `TSTDRV1204919`.

Keep in mind the account ID here has no underscore suffix, so both forms coincide:
`TSTDRV1204919` for the OAuth 1.0a `realm`, `tstdrv1204919` for the hostname.

The key pair in the prototype was generated with a 365-day validity; a new one is needed
anyway, generated the same way:

```
openssl req -new -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp521r1 \
  -pkeyopt ec_param_enc:named_curve -nodes -days 365 -out public.pem -keyout private.pem
```

## 5. Module roadmap

### Done

- `NetSuiteOAuth2Api` credential — JWT signing via built-in `crypto`, token caching via
  `preAuthentication` + `expirable`, `Test connection` against `metadata-catalog`.
- `NetSuite` node — `Authentication` selector (OAuth 2.0 default / TBA), OAuth 2.0 requests
  routed through `httpRequestWithAuthentication`, baseUrl hoisted out of the item loop,
  no body on GET or DELETE.
- TBA signature brought in line with RFC 5849 §3.4.1 (section 6).
- **Record CRUD** — `get`, `create`, `update` (PATCH), `upsert` (PUT `/{type}/eid:{externalId}`)
  and `delete`, over a curated dropdown of 23 record types plus `Other` for a hand-typed
  resource name. Bodies are raw JSON.

  POST/PATCH/PUT/DELETE answer with an empty `204` and put the internal ID of the affected
  record in the `Location` header, so requests go out with `returnFullResponse` and the ID is
  parsed out of it — otherwise an upsert tells the next node nothing about what it just wrote.
  Output is the response body when there is one, `{ success: true, id }` when there is not.
- **Error normalisation** — a failed write comes back as RFC 7807 (`title`, `status`,
  `o:errorDetails[]`), and the array is where the actual cause lives. Without unwrapping it the
  node shows `400 - Bad Request` and building a body becomes guesswork, so `extractNetSuiteError`
  digs the payload out (its position in the thrown object varies by n8n version and by which
  helper threw) and `describeNetSuiteError` turns it into `errorPath: detail` plus the
  `o:errorCode` in the description, raised as a `NodeApiError`. Own validation errors are
  `NodeOperationError` and pass through unwrapped.
- **`Fields` builder** — `JSON Parameters` used to be a toggle with nothing behind its `false`
  branch: turning it off hid the body field and silently sent `{}`. It now shows a name/value
  collection. A dotted name nests (`subsidiary.id` → `{subsidiary:{id}}`), which is how
  references are written; `true`/`false`/`null` are sent as literals, a value starting with `{`
  or `[` is parsed as JSON so sublists remain reachable, and everything else stays a string —
  numbers included, because NetSuite internal IDs are strings and coercing `00123` breaks them.

### Design decisions behind the node's shape

Worth recording, because each of these was a fork with a plausible alternative:

- **The record-type list is curated and hardcoded, not pulled from `metadata-catalog`.**
  A dropdown is what makes the node feel like an n8n building block, but a metadata-driven one
  needs valid credentials at design time, adds latency to opening the node, and produces a list
  of hundreds of entries. The `Other` option keeps custom records (`customrecord_*`) and
  anything omitted reachable. The cost is that the list needs manual upkeep.
- **`getAll` was deliberately left out for now.** The obvious implementation — `GET
  /record/v1/{type}` — returns only ids and links, no field values, so a "Get Many Customers"
  built on it hands back a thousand ids and looks broken. Getting the fields means one request
  per id, which walks straight into the account-wide concurrency limit. It should be backed by
  SuiteQL instead, which is why it waits for Phase 2 item 2.
- **Raw JSON is the default body, the field list is the alternative.** JSON covers sublists —
  invoice lines, addresses — and needs no metadata, so it stays the default. The name/value
  list added on top is deliberately dumb: no metadata lookup, no type coercion beyond the three
  unambiguous literals. Guessing types is what would make it worse than JSON, not better —
  a field builder that turns `00123` into a number is a trap. Real per-field typing has to wait
  for metadata (Phase 2 item 3).

### Phase 1 — shared transport

Currently URL building, auth and the request are inline in `execute()`. Extract `shared/transport.ts`:

- one wrapper over `httpRequest` / `httpRequestWithAuthentication`;
- retry with backoff on 429/5xx — NetSuite returns `SSS_REQUEST_LIMIT_EXCEEDED` when the
  account-wide SuiteTalk concurrency limit is hit;
- a concurrency queue (account-wide limit, not per-workflow);
- ~~error normalisation into `NodeApiError`~~ — done in the node; move it into the transport
  as-is when the transport is extracted, rather than rewriting it;
- generic pagination helper (`limit`/`offset`, `hasMore`, `links.next`; max `limit` is 1000).

The TBA signature already covers query parameters (done — see section 6), so pagination is
free to land on either auth path.

### Phase 2 — a genuinely useful node

1. ~~**Record (generic CRUD)**~~ — done, see above. What remains of this item is `getAll`,
   which is folded into the SuiteQL work below rather than built on the record endpoint.
2. **SuiteQL** — `POST /query/v1/suiteql` with the `Prefer: transient` header, paginated.
   The main read path; the record list endpoint returns only ids and links, no field values.
3. **Metadata / loadOptions** — `/record/v1/metadata-catalog` with `Accept:
   application/schema+json`, feeding dropdowns of record types and fields. This is what turns
   the node from "paste JSON" into a normal UI.

### Phase 3 — triggers and the rest

4. **Polling trigger** — `pollTimes` + SuiteQL over `lastmodifieddate`, cursor in
   `getWorkflowStaticData()`. The only trigger option under the no-scripts constraint.
5. **Transform** — `POST /record/v1/{type}/{id}/!transform/{target}`.
6. **File Cabinet** — upload/download bound to n8n binary data.
7. **Async REST** — `/services/rest/async/v1/` for volumes that would time out synchronously.
8. **Tool mode** — `usableAsTool: true` is already set, but the operation descriptions are
   written for humans. An AI agent needs a narrow, safe surface (read-only SuiteQL + get)
   with descriptions written for a model.

### Housekeeping

- Delete the `nodes/Example/` and `nodes/GithubIssues/` template leftovers and their credentials.
- `NetSuiteApi.credentials.ts`: `signatureMethod` is declared `type: 'string'` while carrying
  an `options` array — should be `type: 'options'`.
- `NetSuiteApi` has no `ICredentialTestRequest` (it is commented out), so TBA credentials
  cannot be tested from the UI.
- `package.json` `repository.url` still contains the placeholder `<...>`.

## 6. Verified vs. unverified

**Verified in this session:** the package builds; n8n 2.36.8 starts clean and registers
`CUSTOM.netSuite`, `CUSTOM.netSuiteTool`, `netSuiteApi` and `netSuiteOAuth2Api`; the earlier
`.ts`→`.js` registry typo was the reason the credential had not been loading.

**The TBA path is proven live.** Workflow `i6oBbs3fY2YvRGy3` / node `Get customer`
(`authentication: "tba"`, credential `netSuiteApi`) ran `GET /record/v1/customer/987`
against TSTDRV1204919 and returned a full record — executions 14 and 15, both `success`.
So OAuth 1.0a signing, the account-ID→hostname transform and the no-body-on-GET rule are all
correct in practice.

**The OAuth 2.0 path is proven live too.** A new Integration record (Client Credentials grant
only, scope `rest_webservices`), a new EC P-521 certificate (`public3.pem` / `private3.pem`,
valid to 2027-08-30) and an M2M mapping were created in `TSTDRV1204919`. Credential
`netSuiteOAuth2Api` (`IaPpQeUe6AM11XYW`) drove the same `Get customer` node to `success` —
executions 16 and 17, full record payloads. That confirms JWT assembly and ES512 signing, the
`kid`/`iss`/`aud`/`scope` claims, and that n8n's `httpRequest` serialises the form-urlencoded
token body correctly inside `preAuthentication`.

Both auth paths therefore work. **OAuth 2.0 is the default and the direction; TBA stays as the
legacy option.**

**The TBA query-parameter signature bug is fixed** (RFC 5849 §3.4.1 — see `CLAUDE.md` for what
it was). Verified statically: the signature now matches an independent reference implementation
on the RFC's own normalization example, including the `b5=%3D%253D` / `c%40=` / `a2=r%20b`
encoding cases; on a realistic `?limit=1000&offset=0` NetSuite URL; and unchanged on
query-less URLs, so executions 14/15 stay reproducible. The header still exposes only `oauth_*`.

Not yet verified **against NetSuite itself** — no operation sends a query string today, so
there is nothing to run. The first live proof will come with `getAll`. If that fails with
`INVALID_LOGIN_ATTEMPT`, the base string is the place to look.

### What is and is not tested live

| Area | Status |
| --- | --- |
| TBA auth, `get` by ID | live (executions 14, 15) |
| OAuth 2.0 auth, `get` by ID | live (executions 16, 17) |
| Curated record-type list — `get` on a second type | live, contact 2231 (execution 18) |
| TBA signature over query parameters | RFC-verified only; nothing sends a query string yet |
| `get` after the `returnFullResponse` change | live, contact 2231 (execution 19) |
| `create` | live, contact 3161 (execution 21) |
| `Location`-header ID extraction | live — `3161` came back from the header, not the body |
| `o:errorDetails` unwrapping | live (execution 20) — see below |
| `upsert` by external ID | live (execution 22) — returned the **same** 3161, no duplicate |
| `Fields` name/value body builder, dotted name | live (execution 23) — same 3161 |
| `delete` | live (execution 24), confirmed by a 404 on re-read (execution 25) |
| `update` (PATCH) | not run — shares the URL and body path with `upsert` |
| `expirable` token refresh on 401 | not run; only observable after a token ages out (1 h) |

Executions 19–24 are the write session, all against contact `3161` with external ID
`n8n-test-001`, ending with the record deleted. Execution 22 is the one that matters:
re-running an upsert against an existing external ID returned the same internal ID rather than
creating a second record, which is the property the whole operation exists for.

`delete` is the one operation whose output proves nothing on its own — there is no `Location`
header, so the returned `{ success: true, id }` echoes the ID that was typed in. What proves it
is the read afterwards: execution 25 re-read `3161` and got `The record instance does not
exist. Provide a valid record instance ID.` with `NONEXISTENT_ID`. That is also the only 404
seen so far — every other observed error was a 400 — so the error unwrapping is now known to
work on both.

`extractNetSuiteError` probes eight positions for the response payload because the wrapper
differs between n8n versions and between `httpRequest` and `httpRequestWithAuthentication`.
Execution 20 proves one of them matches on `httpRequestWithAuthentication` under n8n 2.36.8 —
the node reported `Please enter value(s) for: Subsidiary` with `USER_ERROR` in the description,
where before it would have shown a bare `400 - Bad Request`. The TBA path has not been
re-checked; if a live 400 there shows up bare, no probe matched and the fix is to add the
actual path, not to rewrite the parsing.

Beyond that, the whole surface is also exercised offline against the compiled `dist` with a
stubbed `IExecuteFunctions` — method, URL, body presence, 204 + `Location`, and each error
path. That catches wiring mistakes without touching the account, but proves nothing about
NetSuite itself.

### NetSuite behaviours confirmed while testing writes

- **A reference can be written as a bare scalar.** `"subsidiary": "36"` is accepted just as
  `{"subsidiary": {"id": "36"}}` is. So the dotted-name nesting in the `Fields` builder is a
  convenience, not a requirement, and the flat list is more useful than it looked.
- **`externalId` works as an ordinary body field on `create`.** Setting it there is equivalent
  to creating the record and is what makes a later `upsert` on that external ID find it. The
  `upsert` operation is still the right one for idempotent workflows — it is the URL that makes
  the re-run safe, not the field.
- **Required fields surface only as a 400.** The first write attempt failed on
  `Please enter value(s) for: Subsidiary` because the account is OneWorld. Nothing in the node
  can predict that today; it is the concrete argument for the metadata work in Phase 2 item 3.
