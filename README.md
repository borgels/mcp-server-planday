# mcp-server-planday

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Planday Open API](https://openapi.planday.com). It lets an MCP client (Claude or any other MCP-capable assistant) read a Planday portal's departments, employees, schedule and punch clock and, when enabled, create, change and delete draft shifts, assign shifts, approve shift requests and punch clock records, set a forgotten punch-out, and register and approve absence.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Planday.

- Read-only by default; writes are opt-in per instance.
- One Planday app (client id and refresh token) per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Careful with personal data: no CPR number, bank account, birth date, salary identifier, address or gender is ever asked for or passed on, and no wage or pay field (see [Personal data](#personal-data)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose |
|---|---|
| `planday_check_connection` | Check that the app's token works; the number of departments. |
| `planday_list_departments` | Departments (id, name, number). |
| `planday_list_employee_groups` | Employee groups (id, name). |
| `planday_list_employees` | Active employees, 50 at a time: name, job title, work e-mail and phone, departments, groups, hired date. Search by name or e-mail (no digits). |
| `planday_get_employee` | One employee, with the same work fields. |
| `planday_list_shifts` | Shifts between two dates (at most 62 days), filtered by department, employee, group or status. No wages. |
| `planday_get_shift` | One shift. |
| `planday_list_shift_types` | Shift types, without pay fields. |
| `planday_list_positions` | Positions, without revenue fields. |
| `planday_list_shift_requests` | Shifts employees have asked to take, for the departments given. |
| `planday_list_punch_clock_records` | Punch clock records between two dates (at most 62 days). |
| `planday_list_absence_accounts` | One employee's absence accounts (holiday, sickness and so on), without salary codes. |
| `planday_list_absence_requests` | Absence requests by employee, status or period, without the employee's note. |
| `planday_create_shift` *(write)* | Create a shift as a draft (`isDraft` true, `allowConflicts` false, the department's break rules, no wage). The answer must be the shift asked for. |
| `planday_assign_shift` *(write)* | Give a shift to an employee, or make it open; the shift is read back to confirm. |
| `planday_approve_shift_request` *(write)* | Approve an employee's request for a shift, with no SMS or message; the shift is read back to confirm. |
| `planday_update_draft_shift` *(write)* | Change a shift that is still a draft (date, times, employee, group, position, shift type, comment). The shift is read first and refused if published; it is sent whole with the changes, as a draft, `allowConflicts` false, no wage, and the answer must show the change. |
| `planday_delete_draft_shift` *(write)* | Delete a shift that is still a draft; read first, refused if published. |
| `planday_approve_punch_clock` *(write)* | Approve a worked shift's punch clock record for payroll; the shift must be `PunchclockFinished` and reads back approved. |
| `planday_set_punch_out` *(write)* | Set or correct the punch-out time of a shift's punch clock record; refused if the record is approved or the end is not after the punch-in. No comment or salary note. |
| `planday_register_absence` *(write)* | Register an employee's absence on an account or by type: Planday's draft is submitted unchanged on the employee's behalf and approved, with no notification, no change to the employee's shifts and no open shift. No note. |
| `planday_approve_absence_request` *(write)* | Approve an absence request, with no notification, no change to shifts and no open shift. |

No tool publishes a schedule, changes or deletes a published shift, swaps shifts, punches in, changes the punch-in time (Planday's API cannot), changes an employee or an absence account, declines anything, sends a message, or reads or sets a wage. The only deletion is of a draft shift. The client sends only the writes of the tools above (a fixed list in `src/planday/client.ts`).

### Personal data

Planday holds an employee's CPR number (`ssn`), bank account and birth date as "special" fields that the API returns only when the request asks for them with the `special` parameter; this server never sends that parameter. The salary identifier, address and gender are ordinary fields that come with every employee. What protects all of them is the schema: every answer is parsed with a schema per resource that drops every field it does not name, and none of these is named, so they are left out even when a portal returns them. The employee search refuses digits, because Planday also matches the search text against the CPR number and the salary identifier. Shift wages (`defaultWage`), shift type pay fields and position revenue fields are left out the same way. The audit log keeps ids, dates and times, never a name, a search or a comment.

## Getting the app's credentials

An administrator creates an app in Planday under **Settings > Integrations > API Access**, chooses its scopes and authorizes it. The table then shows the app's **App Id** (the client id) and a **Token** (the refresh token). The server exchanges the refresh token for an access token (`POST https://id.planday.com/connect/token`, valid one hour) and renews it a minute before it expires. Planday documents that refresh tokens do not expire; if a new one ever comes back, it is used from then on (and handed to an embedding host through `onRefreshToken`).

Give the app read access to departments, employees, employee groups, shifts, shift types, positions, punch clock records and absence, and for the writes the right to create, update and delete shifts, approve shift requests, update punch clock records and create absence; nothing more.

## Quick start

Requires Node.js 22 or later and a Planday app's client id and refresh token.

```bash
npx mcp-server-planday
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-planday.git
cd mcp-server-planday
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add planday \
  --env PLANDAY_CLIENT_ID=<app id> --env PLANDAY_REFRESH_TOKEN=<token> \
  -- npx -y mcp-server-planday
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "planday": {
      "command": "npx",
      "args": ["-y", "mcp-server-planday"],
      "env": {
        "PLANDAY_CLIENT_ID": "<app id>",
        "PLANDAY_REFRESH_TOKEN": "<token>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-planday`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name planday-mcp -p 127.0.0.1:3000:3000 \
  -e PLANDAY_CLIENT_ID=<app id> \
  -e PLANDAY_REFRESH_TOKEN=<token> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-planday:latest

claude mcp add --transport http planday http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `PLANDAY_AUDIT_LOG` into it (e.g. `-v planday-audit:/audit -e PLANDAY_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `PLANDAY_CLIENT_ID` | – | **Required.** The app's App Id. Sent as `X-ClientId` and in the token request; not a secret. |
| `PLANDAY_REFRESH_TOKEN` | – | **Required.** The app's Token (refresh token). A secret. |
| `PLANDAY_BASE_URL` | `https://openapi.planday.com` | API address. Must be on `openapi.planday.com` unless custom addresses are allowed (loopback `http` is allowed for local mocks). |
| `PLANDAY_TOKEN_URL` | `https://id.planday.com/connect/token` | Token endpoint. Must be on `id.planday.com` unless custom addresses are allowed. |
| `PLANDAY_ALLOW_CUSTOM_BASE_URL` | `false` | Allow addresses outside Planday's hosts. |
| `PLANDAY_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `PLANDAY_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `PLANDAY_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `PLANDAY_ENABLE_WRITES` | `false` | Enable the write tools. |
| `PLANDAY_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `planday_` prefix. |
| `PLANDAY_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids, dates and times in clear text and no free text at all, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createPlandayGateway, plandayToolCatalog } from 'mcp-server-planday/gateway';

const gateway = createPlandayGateway({
  clientId: tenant.plandayAppId,
  refreshToken: tenant.plandayToken,
  onRefreshToken: token => saveTenantToken(tenant, token),
  policy: { enableWrites: false, audit: record => writeAudit(record), pseudonymKey: tenant.auditKey },
});
const result = await gateway.callTool('list_shifts', { from: '2026-11-01', to: '2026-11-30' }, { caller: 'user@example.test' });
```

- **Explicit credentials.** `clientId` and `refreshToken` are required; a missing value throws when the gateway is created. A gateway never reads `PLANDAY_CLIENT_ID`, `PLANDAY_REFRESH_TOKEN`, `PLANDAY_BASE_URL` or `PLANDAY_TOKEN_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance keeps its own access token in memory and redacts error text, tool results and audit records with its own refresh token, access tokens and pseudonym key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createPlandayGateway`: `enableWrites` (default false), `disabledTools` (must name known tools), `pseudonymKey` (at least 32 random printable characters or 32 random bytes, admitted like the refresh token: a key that shares a piece of six characters with any text of this server is refused, so no error, fallback or tool description can carry part of it; the caller and request id in audit records become `hmac:` and 16 hex characters with it, else `sha256:`) and `audit`, a function that receives each audit record instead of `PLANDAY_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `PLANDAY_ENABLE_WRITES`, `PLANDAY_DISABLED_TOOLS`, `PLANDAY_AUDIT_LOG` or `PLANDAY_ALLOW_CUSTOM_BASE_URL`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`PLANDAY_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text.
- **Change resolution.** `resolvePlandayChange(tool, input, { pseudonymKey })` (or `gateway.resolveChange`) validates the input exactly as the call would, the tool's own checks included, and returns what a write call will change before it is sent, for a host that logs the change first: shift, department, employee, group, position and shift type ids, the date and the times; never the comment.
- **Call context in the audit.** The `caller` and the `requestId` a host passes are never logged in clear: any text can hold a name, a phone number or an address, so both become pseudonyms (HMAC-SHA-256 with `policy.pseudonymKey`, else SHA-256), which still tie the lines of one call together for a host that knows the key. Without a request id the audit makes its own.
- **Tool catalog.** `plandayToolCatalog` is a frozen list of every tool: `name` (without the `planday_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `plandayGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the app's tokens (the refresh token, the access tokens it gets and the host's pseudonym key; "the key" below), and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** The refresh token is a secret Planday issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured Planday app. Give it the least access that works; an administrator can withdraw the app under Settings > Integrations > API Access at any time.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the Planday app can see. To separate data, run several instances with different apps.
- **Writes are off by default.** Write tools are annotated as destructive so clients can ask for confirmation. Read-only tools get a client that refuses non-GET requests. When `PLANDAY_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The tokens stay on Planday's hosts.** The refresh token goes only to `id.planday.com` and the access token only to `openapi.planday.com` (other hosts need an explicit switch), redirects are never followed, addresses must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/planday.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/planday/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml`.

## What is not tested against a live portal

The tests use answers shaped as Planday's published OpenAPI documents show them (`https://openapi.planday.com/{hr,scheduling,punchclock}/swagger/v1.0/swagger.json`) and the token flow as the developer guide describes it. No Planday portal was used. Not verified live: the exact field set a portal returns for employees, shifts and punch clock records; that special fields stay out without the parameter; whether the token endpoint ever returns a new refresh token; and the answers of the assign and approve endpoints (documented without a body; the shift is read back instead). From 0.2.0 also: whether an update of a draft shift keeps a wage set on it in Planday (none is sent, and the API documents none to send back), the status a shift reads back with after its punch clock record is approved (`PunchclockApproved` or `Approved` is taken as approved), and the absence draft as a portal fills it in.

## License

Apache-2.0
