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
  no body on GET.

### Phase 1 — shared transport

Currently URL building, auth and the request are inline in `execute()`. Extract `shared/transport.ts`:

- one wrapper over `httpRequest` / `httpRequestWithAuthentication`;
- retry with backoff on 429/5xx — NetSuite returns `SSS_REQUEST_LIMIT_EXCEEDED` when the
  account-wide SuiteTalk concurrency limit is hit;
- a concurrency queue (account-wide limit, not per-workflow);
- error normalisation into `NodeApiError` — the current `catch` keeps only `error.message`
  and discards `o:errorDetails[].detail`, which is the useful part;
- generic pagination helper (`limit`/`offset`, `hasMore`, `links.next`; max `limit` is 1000).

The TBA signature already covers query parameters (done — see section 6), so pagination is
free to land on either auth path.

### Phase 2 — a genuinely useful node

1. **Record (generic CRUD)** — any record type, not the hardcoded Customer/Invoice.
   Operations: `get`, `getAll` (paginated), `create`, `update` (PATCH),
   **`upsert` (PUT `/{type}/eid:{externalId}`)**, `delete`. Upsert by externalId is the
   defence against duplicates on retry and should not be treated as optional.
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

Still unconfirmed, and only observable after a token actually ages out:

- whether n8n's `httpRequest` serialises the form-urlencoded token body as expected inside
  `preAuthentication`;
- whether the `expirable` flag actually triggers a token refresh on 401.

Expected first-run outcome while the role is still broken: the token is issued, then the API
call fails with `INVALID_LOGIN` — the same 401 as the prototype. That result would confirm the
port is correct and the problem remains account-side. A failure *at the token step* instead
would point at the JWT signing code in this repo.
