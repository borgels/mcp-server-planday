# Changelog

## 0.1.0

First version, built from the template (`borgels/mcp-server-template`) with
the lessons of the reviews of the Billy and WooCommerce servers.

- OAuth as the Planday Open API documents it for a customer-created app:
  the refresh token is exchanged at `https://id.planday.com/connect/token`
  (form-encoded `client_id`, `grant_type=refresh_token`, `refresh_token`)
  for an access token, sent as `Authorization: Bearer` with the client id in
  `X-ClientId`. The access token is kept in memory, renewed a minute before
  it expires and once after a 401, one renewal at a time per instance. A new
  refresh token in the answer (not documented to happen) is used from then
  on and handed to the host through `onRefreshToken`. The refresh token goes
  only to `id.planday.com`, the access token only to `openapi.planday.com`.
- Read tools: connection check, departments, employee groups, employees
  (work fields only), shifts (at most 62 days, no wages), shift types (no
  pay fields), positions (no revenue fields), shift requests and punch clock
  records.
- Personal data: the `special` parameter is never sent, so CPR number, bank
  account and birth date are not asked for; answers are parsed with a schema
  per resource that drops them, and the ordinary fields salary identifier,
  address and gender, whenever they come. The employee search refuses digits, since Planday also
  matches it against the CPR number and the salary identifier.
- Write tools, off by default: create a draft shift (`isDraft` true,
  `allowConflicts` false, break rules on, no wage), assign a shift or make it
  open, approve a shift request with no SMS or message. A write is reported
  as done only when the answer confirms it: the created shift must be the one
  asked for, as a draft; an assignment or approval is read back. The client
  sends only these three writes.
- Gateway (`./gateway`): explicit credentials, instance policy,
  `resolvePlandayChange`, tool catalog with the upstream requests. The audit
  keeps ids, dates and times, never a name, a search or a comment; the
  caller and the request id only as pseudonyms (`policy.pseudonymKey`, at
  least 32 characters or bytes, admitted like the refresh token and known to
  the error guard before anything is validated; registering it cannot
  throw). Periods are at most 62 days, both dates included. A host's
  `onRefreshToken` may return a promise; a rejection is caught.
- Not yet run against a live Planday portal: the tests use answers shaped as
  the published OpenAPI documents show them.
