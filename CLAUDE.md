# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A **community node package for n8n** that integrates with NetSuite over the REST API.
It is a standalone git repository — **not** part of the `c:\dev\nc_projects` SDF monorepo,
though it targets the same NetSuite accounts.

Scaffolded from the `@n8n/node-cli` starter. The `nodes/Example/` and `nodes/GithubIssues/`
folders are **leftover template code**, not used and not registered in `package.json`.
Only `nodes/NetSuite/` and the two credentials matter.

> **Hard constraint:** this integration must work **without deploying any SuiteScript**
> to NetSuite — no RESTlets, no UserEvent scripts, no SDF project. Everything goes through
> the stock REST API. This rules out saved searches and NetSuite-side webhooks; see
> `docs/netsuite-integration-notes.md` for what that implies.

## Layout

```
credentials/
  NetSuiteApi.credentials.ts          ← TBA / OAuth 1.0a (legacy path, still supported)
  NetSuiteOAuth2Api.credentials.ts    ← OAuth 2.0 Client Credentials (M2M, JWT) — the direction
  GithubIssues*.credentials.ts        ← template leftovers, unregistered
nodes/
  NetSuite/NetSuite.node.ts           ← the only real node
  Example/, GithubIssues/             ← template leftovers, unregistered
icons/netsuite.svg
docs/netsuite-integration-notes.md    ← findings, role setup, module roadmap
```

`package.json` → `n8n.nodes` / `n8n.credentials` is the registry. **Paths there must point at
compiled `.js` files under `dist/`.** A `.ts` path silently breaks loading — the credential just
never appears in n8n, and the node shows up unusable. This bug was already hit once.

## Commands

```bash
npm run build          # n8n-node build → dist/
npm run lint           # n8n-node lint
npm run dev            # n8n-node dev — n8n with the package installed as a real community node
```

### Running n8n for manual testing

The node is loaded into a locally installed n8n via a **junction**:
`~/.n8n/custom/node_modules/n8n-nodes-netsuite` → this project root.

```bash
npx n8n@2.36.8 start   # http://localhost:5678
```

Pin the version. Plain `npx n8n` resolves to latest and will silently upgrade the instance
and run irreversible SQLite migrations on `~/.n8n/database.sqlite` mid-debugging.

**n8n loads nodes and credentials only at startup** — after `npm run build` you must restart
the process, a browser refresh is not enough.

Because it is loaded from the custom directory, the node's id is **`CUSTOM.netSuite`**
(and `CUSTOM.netSuiteTool`, auto-generated from `usableAsTool: true`). If the package is ever
installed properly as a community node the id becomes `n8n-nodes-netsuite.netSuite`, and
workflows built against `CUSTOM.*` will not migrate.

### Verifying that a build actually loaded

`/types/nodes.json` and `/types/credentials.json` on the n8n server require an authenticated
session, so they return 401 to a plain HTTP client. Fetch them from an already-logged-in
browser tab instead (Chrome with `--remote-debugging-port=9222`, then `Runtime.evaluate`
over CDP). Confirming the credential name appears in `/types/credentials.json` is the reliable
check that registration worked.

### Inspecting what actually ran — read the SQLite database

The most dependable way to check a manual test, and the one to reach for first. n8n's `/rest`
API rejects requests made from a CDP-driven tab (401 even with the `browser-id` header from
`localStorage`), but the database is right there and needs no auth. Node 24 has `node:sqlite`
built in, so no dependency is needed — open `~/.n8n/database.sqlite` **read-only**, the running
server holds it open:

```js
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(dbPath, { readOnly: true });
db.prepare('SELECT id, name, nodes FROM workflow_entity').all();      // node params + credential ids
db.prepare('SELECT id, type FROM credentials_entity').all();          // which credentials exist
db.prepare(`SELECT e.id, e.status, d.data FROM execution_entity e
  JOIN execution_data d ON d.executionId = e.id ORDER BY e.id DESC`).all();
```

`execution_data.data` is a flattened structure with string back-references rather than plain
nested JSON, so substring-search it for markers (`"custentity`, a field name, `"message":"`)
instead of trying to walk it. Credential *values* are encrypted; types, names and node
parameters are not, which is enough to tell which auth path a run actually used.

## Environment

- **Node.js 24** (24.16.0 in use). `@n8n/node-cli` requires 22+.
- Windows, PowerShell. No Docker, no Python 3 (n8n's Python task runner is unavailable; the
  JS runner works, which is all this node needs).

## Conventions

- TypeScript, tabs for indentation, single quotes — match `.prettierrc.js`.
- Existing comments are a mix of English and Russian; keep whichever language the surrounding
  block uses rather than rewriting.
- Do not add dependencies casually. JWT signing is done with Node's built-in `crypto`
  specifically to avoid pulling in `jsonwebtoken`.

## Gotchas that have already cost time

- **TBA signature and query parameters — fixed, keep it that way.**
  `generateNetSuiteOAuthHeader` used to sign only the `oauth_*` params and to leave the query
  string inside the base-string URI, so any `?limit=`, `?offset=`, `?q=` produced
  `INVALID_LOGIN_ATTEMPT` — with a perfectly normal-looking `Authorization` header, which is
  why the error is so opaque. It now follows RFC 5849 §3.4.1: the base-string URI is stripped
  to scheme+host+path, and query parameters are merged with the `oauth_*` ones and sorted by
  encoded key then value. The header itself still carries only `oauth_*`. Request bodies are
  deliberately not signed — §3.4.1.3.1 covers only `application/x-www-form-urlencoded`, and
  ours are JSON.
- **Account ID has two forms.** `1234567_SB1` (uppercase, underscore) goes into the OAuth 1.0a
  `realm=` header and NetSuite compares it case-sensitively. `1234567-sb1` (lowercase, dash)
  goes into the hostname. Do not conflate them.
- **NetSuite rejects GET requests carrying a body.**
- **EC JWT signatures.** Node's `crypto.sign` emits DER by default; JWS requires raw R‖S, so
  `dsaEncoding: 'ieee-p1363'` is mandatory for the ES* algorithms.

## Current state

**Both authentication paths are proven live** against account `TSTDRV1204919`, each returning
a full customer record through the node:

- TBA / OAuth 1.0a (`netSuiteApi`) — executions 14, 15.
- OAuth 2.0 M2M (`netSuiteOAuth2Api`) — executions 16, 17, using a P-521 certificate and an
  Integration record with the Client Credentials grant only.

OAuth 2.0 is the default and the direction; TBA remains the legacy option. Its query-parameter
signature bug (see Gotchas) is now the one thing standing between the TBA path and Phase 2.

All account setup and verification happens in `TSTDRV1204919`. The older `8129406_SB1` values
in `ns_integration\.env` are dead — M2M setup does not transfer between accounts.

The node covers full CRUD — get, create, update, upsert by external ID, delete — over a
curated list of 23 record types plus an `Other` escape hatch for anything else, custom records
included. Bodies are raw JSON by default, or a name/value field list where a dotted name nests
(`subsidiary.id`). Failed requests are unwrapped from NetSuite's RFC 7807 body so
`o:errorDetails[].detail` reaches the user instead of `400 - Bad Request`.

Writes are proven live (executions 19–24, contact `3161`, external ID `n8n-test-001`, ending
with the record deleted): `create`, `upsert` re-run against an existing external ID returning
the **same** internal ID, `delete`, the `Location`-header ID extraction, the field-list body
builder, and the `o:errorDetails` unwrapping. `update` is the one operation not run separately
— it shares its URL and body path with `upsert`. The whole surface is additionally exercised
offline against `dist` with a stubbed `IExecuteFunctions`, which proves the node's logic and
nothing about the account — see the "What is and is not tested live" table in the notes doc.

A `Get Field Metadata` operation reads `/record/v1/metadata-catalog/{type}` in either
representation (JSON Schema or OpenAPI, selected by `Accept`) and flattens the schema to one
item per field. **It cannot tell you which fields are mandatory** — verified against `contact`,
executions 28 and 29: neither representation carries a `required` array anywhere, and
`nullable` is `true` wherever it appears. Do not try to derive mandatoriness from this endpoint
again; the notes doc has the full finding and the two paths that do work.

Next module is SuiteQL — the main read path, what `getAll` will be built on, and the only way
to reach the `ismandatory` flag of custom fields.

Next up is the transport layer and SuiteQL — see the roadmap in the notes doc.
