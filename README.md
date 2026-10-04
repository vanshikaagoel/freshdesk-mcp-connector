# Freshdesk MCP Connector

A private, **read-only** connector that lets an AI agent (Agent Studio, Claude Desktop, Cursor, or any MCP client) read Freshdesk support tickets through the [Model Context Protocol](https://modelcontextprotocol.io).

It exposes three tools over **stdio**:

| Tool | Purpose |
| --- | --- |
| `list_tickets` | Browse recent tickets, or tickets for one requester / company |
| `get_ticket` | Full details of one ticket (optionally with requester contact details) |
| `search_tickets` | Filter by status, priority, assignee, group, tag, type and date ranges |

* What the agent can and cannot do, plus example agent workflows: [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)
* Machine-readable tool specification with input schemas, output schemas, error schema and example calls: [`docs/tool-spec.json`](docs/tool-spec.json)

## Scope: Freshdesk only

This connector targets the **Freshdesk** REST API v2 (`https://<subdomain>.freshdesk.com/api/v2`). It does **not** support **Freshservice** (`*.freshservice.com`) or other Freshworks products: they have different APIs. Freshservice domains are rejected at startup.

---

## Quick start (mock mode, no Freshdesk account needed)

Requirements: Node.js 20+ (developed on Node 22).

```bash
npm install
npm run build
npm run start:mock          # MCP server on stdio, serving synthetic tickets
```

> **The server prints a "running on stdio" log line and then waits silently.** That is expected: it is waiting for an MCP client to talk to it over stdin/stdout. Use the MCP Inspector below or [connect an MCP client](#connect-it-to-an-mcp-client). Press Ctrl+C to stop it.

Explore it interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@1 node dist/index.js --mock
```

Or from the command line:

```bash
npx @modelcontextprotocol/inspector@1 --cli node dist/index.js --mock --method tools/list
npx @modelcontextprotocol/inspector@1 --cli node dist/index.js --mock --method tools/call --tool-name get_ticket --tool-arg ticket_id=5
```

The Inspector is pinned to v1 because that is the version these commands were verified with. It reports itself as deprecated in favour of v2, which has not been tested here.

Mock mode runs the real HTTP client, query builder and mappers against an in-process fake of the Freshdesk API that returns the documented response shapes (JSON array + `link` header for lists, `{ total, results }` for search, rate-limit headers, 400/404 errors). All data is synthetic.

## Live setup (real Freshdesk account)

1. **Create a dedicated agent** in Freshdesk for the connector and give it the least-privileged role that can view the tickets you want the AI to see. A free trial account works for testing.
2. **Get that agent's API key**: log in as the agent → profile picture → *Profile settings* → API key.
3. **Configure** the connector (macOS / Linux / Git Bash):

   ```bash
   cp .env.example .env
   # edit .env: FRESHDESK_DOMAIN=yourcompany   FRESHDESK_API_KEY=...
   ```

4. **Run**:

   ```bash
   npm run build
   npm start
   ```

   On startup the connector verifies the credentials (see [Authentication](#authentication)), logs `verified Freshdesk credentials`, and then waits for an MCP client on stdio.

### Windows setup

The same steps work in PowerShell or Command Prompt; only the copy command differs:

```powershell
# PowerShell
Copy-Item .env.example .env
notepad .env
npm run build
npm start
```

```bat
:: Command Prompt
copy .env.example .env
```

* Use `npm run start:mock` rather than `set FRESHDESK_MOCK=true`; the `--mock` flag behaves the same on every shell.
* In MCP client configs, use the absolute path with escaped backslashes or forward slashes, e.g. `"D:\\path\\to\\freshdesk-mcp-connector\\dist\\index.js"` or `"D:/path/to/freshdesk-mcp-connector/dist/index.js"`.
* If you redirect stderr (e.g. `2>&1`), PowerShell may display the connector's log lines in red as `NativeCommandError`. They are normal logs, not failures.

### Connect it to an MCP client

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/absolute/path/to/freshdesk-mcp-connector/dist/index.js"],
      "env": {
        "FRESHDESK_DOMAIN": "yourcompany",
        "FRESHDESK_API_KEY": "your-api-key"
      }
    }
  }
}
```

Use `"args": [".../dist/index.js", "--mock"]` and omit `env` to try it with synthetic data.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FRESHDESK_DOMAIN` | live mode | – | Subdomain (`acme`) or host (`acme.freshdesk.com`). Custom domains/CNAMEs and Freshservice domains are rejected; the Freshdesk API only works on `*.freshdesk.com`. |
| `FRESHDESK_API_KEY` | live mode | – | API key of the dedicated agent. |
| `FRESHDESK_MOCK` | no | `false` | `true` serves synthetic data (same as the `--mock` flag). |
| `FRESHDESK_TIMEOUT_MS` | no | `15000` | Per-request timeout. |
| `FRESHDESK_MAX_RETRIES` | no | `2` | Retries for 429 / 5xx / network errors. |
| `FRESHDESK_MAX_RETRY_WAIT_MS` | no | `30000` | Max total time spent waiting between retries for one tool call. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error`, `silent`. Logs go to **stderr** only. |

## Authentication

* **Method: API key over HTTP Basic auth**, as documented by Freshdesk. The API key is the username and `X` is a dummy password. Each request sends `Authorization: Basic base64("<api_key>:X")` over HTTPS.
* **Why not OAuth:** the Freshdesk v2 API reference documents only API-key authentication for the REST API; it describes no OAuth flow for third-party access.
* **Where the key comes from:** the profile settings of the Freshdesk agent the connector runs as (see [Live setup](#live-setup-real-freshdesk-account)).
* **Permissions:** Freshdesk API keys are not scoped. **A key inherits every permission of its agent**, including writes and deletes. The connector enforces read-only access itself: its HTTP client can only send `GET` requests (see [Security](#security)).
* **Startup check:** before accepting MCP traffic, the connector calls `GET /api/v2/agents/me`. If this fails, it exits with a clear message and never starts serving tools:

  | Freshdesk response | Meaning | Message |
  | --- | --- | --- |
  | `401` | Wrong or revoked API key | "Freshdesk authentication failed. Check that FRESHDESK_API_KEY is correct…" |
  | `403` | Agent not allowed / account suspended / feature disabled | Specific message based on Freshdesk's error code |
  | `404` | Wrong `FRESHDESK_DOMAIN` (no such Freshdesk account) | "Freshdesk returned 404 Not Found … (or FRESHDESK_DOMAIN is wrong)" |
  | invalid domain format | Not a `*.freshdesk.com` subdomain | Rejected before any request is made |

  The same mapping applies if a key is revoked while the server is running: tools return an `auth` / `forbidden` error instead of data.

## Architecture

```
MCP client (agent)
   │  JSON-RPC over stdio
   ▼
src/server.ts + src/tools/*      tool registration, zod input validation, agent-facing errors
   ▼
src/freshdesk/ticket-service.ts  maps tool inputs → Freshdesk params, pagination, local validation
   ├─ query-builder.ts           structured filters → Freshdesk search query (hidden from the agent)
   └─ mappers.ts                 raw tickets → normalized summaries / details
   ▼
src/freshdesk/client.ts          GET-only HTTP client: auth, timeout, retries, rate limits, error mapping
   ▼
Freshdesk REST API v2  (or src/mock/mock-fetch.ts in mock mode)
```

```
src/
  index.ts            entry point: env, startup credential check, stdio transport
  app.ts              wiring (config → client → service → server)
  config.ts           environment validation
  errors.ts, logger.ts
  freshdesk/          client, query builder, mappers, ticket service, raw types
  tools/              list_tickets, get_ticket, search_tickets
  mock/               synthetic fixtures + fake Freshdesk API
tests/                unit + integration tests (mocked fetch, in-memory MCP client)
scripts/              export-tool-spec.ts (+ tool-spec-extras.ts) → docs/tool-spec.json
docs/                 CAPABILITIES.md, tool-spec.json
```

### Responses

Each tool returns one JSON object as text. Exact shapes are in the `outputSchema` / `errorSchema` of [`docs/tool-spec.json`](docs/tool-spec.json), with generated example calls.

* `list_tickets` / `search_tickets` return **ticket summaries**: id, subject, status / priority / source (numeric code **and** label), type, tags, requester / agent / group / company / product IDs, created / updated / due timestamps, escalation flags and custom fields. Lists do not include descriptions because Freshdesk charges extra API credits for them.
* `get_ticket` returns the summary plus the plain-text description, CC/To emails, spam flag and attachment metadata. Descriptions are only cut off beyond 20,000 characters, and `description_truncated` / `description_length` say when that happened. Attachment download URLs are deliberately omitted.
* Unknown or custom codes are never dropped: e.g. a custom status 6 is returned as `{ "code": 6, "label": "custom_status_6" }`.
* Every successful response carries a `content_notice` reminding the model that ticket content is untrusted.

### Rate limits and errors

* Freshdesk limits are **per account, per minute** (50/min on trial accounts, confirmed live) and shared with every other integration on the account. Invalid requests also count, so inputs are validated locally before any call is made.
* On **429** the client waits for `Retry-After` and retries (up to `FRESHDESK_MAX_RETRIES`). If the required wait would exceed `FRESHDESK_MAX_RETRY_WAIT_MS`, it fails fast and tells the agent how many seconds to wait (`retry_after_seconds`).
* **5xx and network errors** are retried with exponential backoff and jitter. Other 4xx errors are not retried.
* `X-RateLimit-Remaining` is logged, with a warning when under 10% remains.
* Errors are returned to the agent as MCP tool errors with a stable `error` kind: `invalid_input`, `validation`, `auth`, `forbidden`, `not_found`, `rate_limited`, `upstream`, `timeout`, `network`. Freshdesk's machine-readable error code (e.g. `require_feature`, `account_suspended`) is used to make `forbidden` messages specific.

## Security

* **Read-only by construction.** Because Freshdesk API keys inherit all of their agent's permissions, the connector enforces read-only access independently. The HTTP client only exposes a `get` method and sends only `GET` requests, and no tool performs a write. To limit exposure further, use a dedicated agent with the least-privileged role.
* **Secrets.** Credentials come only from environment variables. `.env` is git-ignored, `.env.example` contains placeholders, and the API key is never logged or included in tool output or error messages (covered by tests).
* **Untrusted content / prompt injection.** Ticket subjects, descriptions, tags and custom fields are written by customers. Tool descriptions, server instructions and every response tell the model to treat them as data, never as instructions. Mock ticket #13 contains an injection attempt for demonstrations.
* **Personal data.** Ticket data (and requester email/phone when `include_requester=true`) is passed to the AI model. Only connect this to models and environments approved for customer data.
* **Domain allow-list.** Only `*.freshdesk.com` hosts are accepted, over HTTPS.

## Production credential handling

`.env` is for local development only. For a deployed, per-merchant ("private") connector:

* **One connector instance per merchant**, each with its own Freshdesk agent and API key. Never share a key across merchants.
* **Store the key in a secret manager** (e.g. AWS Secrets Manager, GCP Secret Manager, Vault, or the hosting platform's secret store) and inject it as `FRESHDESK_API_KEY` at process start. Never bake it into images, configs in source control, or MCP client configs that are synced or shared.
* **Least privilege:** a dedicated agent with a view-only style role, restricted to the groups the AI should see.
* **Rotation:** reset the dedicated agent's API key in its Freshdesk profile settings, update the secret, and restart the connector. The startup check confirms the new key works; also confirm the old key is rejected. Rotate immediately if a key may have leaked, and when the people with access change.
* **Revocation:** to cut off access, reset the key or deactivate the dedicated agent in Freshdesk. Calls made with an invalid key return `401`, which tools report as `auth` errors.
* **Logs:** the connector never logs the key. Keep log level at `info` or higher in production and treat logs as containing ticket IDs and metadata.

## Testing

```bash
npm run typecheck   # TypeScript
npm test            # vitest: unit + integration tests, no network access
npm run check       # typecheck + tests + build
npm run export-spec # regenerate docs/tool-spec.json
```

The automated tests (109) cover:

* **Config validation.**
* **The HTTP client:** auth header, query encoding, 429 with `Retry-After`, retry caps, 5xx backoff, timeouts, error mapping, no credential leakage, and that only GET is possible.
* **The query builder:** syntax, escaping rules, date validation, and the 512-character limit.
* **The mappers:** documented sample payloads, custom codes, HTML fallback, and truncation.
* **The ticket service and the mock API.**
* **End-to-end MCP calls** through an in-memory MCP client.

### Live verification (real Freshdesk account)

All three tools were exercised against a real Freshdesk **trial account** (10 sample tickets) on 2026-10-04, through the MCP tool layer with the production code path. Only response shapes, counts and status codes were inspected; no ticket content or personal data was recorded.

| Tool / check | Call | Result |
| --- | --- | --- |
| Startup | `GET /agents/me` | Credentials verified, server started |
| `list_tickets` | default, `per_page: 5` | 5 normalized summaries, `has_more: true` (from `link` header), 30-day note present |
| `list_tickets` | `updated_since: "2000-01-01"` | All 10 tickets, `has_more: false`, no 30-day note |
| `list_tickets` | `filter: "new_and_my_open"` | 9 tickets |
| `list_tickets` | `requester_id` | Only that requester's tickets |
| `list_tickets` | `requester_id` + `company_id` | Rejected locally: `invalid_input` |
| `get_ticket` | existing ID | Full detail with `description_text`; no `requester` |
| `get_ticket` | `include_requester: true` | `requester` with `id, name, email, phone, mobile` |
| `get_ticket` | non-existent ID | `not_found` |
| `search_tickets` | `status: ["open"]` | 9 results, all open |
| `search_tickets` | `status: ["open","pending"], priority: ["urgent","high"]` | 8 results, all matching |
| `search_tickets` | `created_from` date | Matches returned |
| `search_tickets` | `unassigned: true` | 7 results, all with `responder_id: null` |
| `search_tickets` | no filters | Rejected locally: `invalid_input` |

Direct read-only API checks confirmed the following documented behaviour:

* **Rate-limit headers:** `X-Ratelimit-Total: 50.0` on a trial account. A plain ticket view costs 1 call and `include=requester` costs 2, which matches `X-Ratelimit-Used-CurrentRequest`.
* **Lists:** list responses omit the description, and the `link` header is present when more pages exist.
* **Rejected inputs:** search `page=11` and list `per_page=101` both return `400 invalid_value`.
* **Bad key:** an invalid API key returns `401`.
* **Unknown domain:** an unknown subdomain returns `404`.

**Not exercised live:**

* A real 429. Triggering one would deliberately exhaust the account's shared quota, so 429 handling is covered by automated tests instead.
* Archived tickets. The trial account has none.

## Assumptions and limitations

Everything the connector relies on comes from the official [Freshdesk API v2 reference](https://developers.freshdesk.com/api/), plus the live checks above. Where behaviour is not fully established, the connector takes the conservative option:

* **One filter per `list_tickets` call.** The docs do not say whether `filter`, `email`, `requester_id`, `company_id` and `updated_since` can be combined. Live, Freshdesk accepted `requester_id` + `updated_since` and returned correct results, but on too little data to rely on, and other combinations are untested. The connector therefore still allows one per call. So "a customer's tickets older than 30 days" needs `updated_since` and then filtering by `requester_id` in the results.
* **Search value quoting.** The escaping rules for quotes inside search values are undocumented, so `tag` / `type` values containing quotes or backslashes are rejected.
* **30-day window.** Without `updated_since`, Freshdesk lists only tickets created in the last 30 days. The tool description and response `notes` say so.
* **Search limits (documented).** No free-text search over subject or description, no requester/company filter, day-level dates only, 30 results per page, max 10 pages (300 results), archived tickets excluded, and a few minutes' indexing delay.
* **Search result fields.** Live search results include `description_text` even though the documented sample does not show it. The connector does not depend on this: search returns summaries, and full text comes from `get_ticket`.
* **Archived tickets** (closed and inactive for about 120 days) are documented as excluded from search and served by a separate archive endpoint. `get_ticket` is expected to return `not_found` for them (not verified live).
* **Custom status labels** are not resolved to names (that would need an extra `ticket_fields` call or caching); the numeric code is always returned.
* **Custom-field search** is not exposed because field names vary per account.
* **No conversation thread** (replies/notes) in the MVP.
* Tweet content is replaced by Freshdesk with "View the message on Twitter".
* Agent Studio is assumed to consume a standard MCP server over stdio.

## Possible extensions

Not part of the MVP; add only when there is a concrete need:

* `get_ticket_conversations` (paginated `GET /api/v2/tickets/{id}/conversations`)
* Allow combining `list_tickets` filters once verified on a larger account
* Resolve custom status names and agent/group names via `ticket_fields` / agents / groups (needs a small cache)
* Custom-field search driven by `ticket_fields`
* Streamable HTTP transport for hosted deployments
* Optional personal-data redaction of emails and phone numbers in tool output
