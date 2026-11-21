# Changelog

## 0.3.0

- Gateway error results carry failure metadata: when Planday answered with
  an HTTP error (a refused token or redirect, or an approval that failed
  after an absence was submitted, included), the result has `failure: {
  httpStatus, requestId? }`, so a host can count failures by status without
  reading their text. `requestId` is the vendor's own id from a response
  header (`REQUEST_ID_HEADERS`; Planday documents none, so the common list),
  kept only when it is a hex id of 8 to 64 characters (one run of hex
  digits, or groups of four or more joined by single hyphens, as in a UUID)
  and does not hold the shape of a personal number. It is checked again
  after redaction, so an id that shared a piece with the refresh token or an
  access token is dropped. Never the body, the vendor's error code or
  message. The shared helpers are in `src/errors.ts` (`vendorRequestId`,
  `requestIdFrom`, `failureMetadata`, and `PlandayAnswerError`, the base of
  every error caused by an HTTP answer from Planday).

## 0.2.1

- `list_absence_requests` leaves out the accounts a request is asked on
  (`requestedAccounts`): an account's name, such as sickness, says why the
  employee is away (#11). A request is shown with its employee, period and
  status.

## 0.2.0

The everyday changes of a shift planner (#8), after Planday's OpenAPI
documents for scheduling, punch clock and absence. Every new write is off
until writes are enabled, reads its record first where the API allows it,
and is reported as done only when the answer or a read-back confirms it.

- `update_draft_shift`: change a draft shift. Read first and refused if it
  is published; sent whole with the changes (`isDraft` true,
  `allowConflicts` false, break rules on, manual breaks kept, no wage).
- `delete_draft_shift`: delete a draft shift; read first and refused if it
  is published. The only DELETE the client sends.
- `approve_punch_clock`: approve a worked shift's punch clock record on the
  timesheet (Timesheet API, `approve/simple`) with the punched times or
  corrected start and end; refused when the record is approved or not
  punched out; the record must read back approved. The scheduling
  endpoint `shifts/{id}/approve` is not used: Planday says it does not take
  punch clock data into account.
- `set_punch_out`: set or correct the punch-out time of a shift's punch
  clock record; refused when the record is approved or the end is not after
  the punch-in. No comment or salary note is sent.
- `register_absence` and `approve_absence_request`: register an employee's
  absence (Planday's draft submitted on their behalf and approved) and
  approve a request, notifying nobody, leaving the employee's shifts as they
  are and making no open shift. No note is sent.
- `list_absence_accounts` and `list_absence_requests`: the accounts to
  register on, without salary codes, and the requests, without the
  employee's note (it can say why they are away).

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
