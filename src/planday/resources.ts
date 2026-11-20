import { z } from 'zod/v4';
import { nestedFailuresAsStatus } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UpstreamClient } from './client.js';

/**
 * Calls to the Planday Open API, after its published OpenAPI documents
 * (https://openapi.planday.com/{hr,scheduling,punchclock}/swagger/v1.0/swagger.json)
 * and https://developer.planday.com. From those:
 *
 * - A record is answered as `{ "data": {...} }`, a list as
 *   `{ "data": [...], "paging": { "offset", "limit", "total" } }`.
 * - Ids are 64-bit integers; lists take `offset` and `limit` (at most 50
 *   for employees, departments, employee groups, shift types and positions).
 *
 * Every answer is parsed with a schema per resource, sub-objects included:
 * a present field must have its documented type, a record must have the id
 * that was asked for, and one entry of a list that does not fit refuses the
 * whole answer. Fields a schema does not name are dropped by the parse.
 *
 * Personal data. Employees are read without the fields Planday calls
 * "special" (SSN, i.e. CPR, bank account, birth date): the `special` query
 * parameter is never sent, and the schemas leave those fields out even if
 * they come. Salary identifier, home address, gender, username and the
 * reason for a deactivation are left out as well. No tool reads wages, pay
 * rates, salary codes or the time-and-cost figures; shift types are read
 * without their pay fields, shifts without their default wage.
 */

type Json = Record<string, unknown>;

/** An answer that is not shaped as documented: our own text, nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('Planday answered without the expected data. Nothing in the answer was used.');
    this.name = 'UnexpectedAnswerError';
  }
}

// ---------------------------------------------------------------------------
// Schemas, after the OpenAPI documents.

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/).max(40);
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/).max(40);
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/);
const text = (max: number) => z.string().max(max);
const ids = z.array(id).max(10_000);

const paging = z.object({ offset: z.number().int().min(0), limit: z.number().int().min(0), total: z.number().int().min(0) });

const department = z.object({ id, name: text(500).nullable().optional(), number: text(100).nullable().optional() });
const employeeGroup = z.object({ id, name: text(500).nullable().optional() });

/** The work fields of an employee. CPR (ssn), bank account, birth date (special fields), salary identifier, address and gender (ordinary fields) are not here, so the parse drops them. */
const employee = z.object({
  id,
  firstName: text(200).nullable().optional(),
  lastName: text(200).nullable().optional(),
  jobTitle: text(500).nullable().optional(),
  email: text(320).nullable().optional(),
  cellPhone: text(100).nullable().optional(),
  primaryDepartmentId: id.nullable().optional(),
  departments: ids.nullable().optional(),
  employeeGroups: ids.nullable().optional(),
  employeeTypeId: id.nullable().optional(),
  skillIds: ids.nullable().optional(),
  supervisorEmployeeId: id.nullable().optional(),
  hiredDate: date.nullable().optional(),
  hiredFrom: date.nullable().optional(),
  deactivationDate: date.nullable().optional(),
  isDeactivated: z.boolean().optional(),
});

const SHIFT_STATUSES = [
  'Open',
  'Assigned',
  'Approved',
  'ForSale',
  'Draft',
  'OnDuty',
  'PendingSwapAcceptance',
  'PendingApproval',
  'PunchclockStarted',
  'PunchclockFinished',
  'PunchclockApproved',
] as const;

const manualBreak = z.object({
  id,
  startDateTime: dateTime.optional(),
  endDateTime: dateTime.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  isPaidBreak: z.boolean().optional(),
});

/** A shift. The default wage (defaultWage) is not here. */
const shift = z.object({
  id,
  departmentId: id.nullable().optional(),
  employeeId: id.nullable().optional(),
  employeeGroupId: id.nullable().optional(),
  positionId: id.nullable().optional(),
  shiftTypeId: id.nullable().optional(),
  date: date.nullable().optional(),
  comment: text(5000).nullable().optional(),
  timeZone: text(100).nullable().optional(),
  punchClockShiftId: id.nullable().optional(),
  startDateTime: dateTime.nullable().optional(),
  endDateTime: dateTime.nullable().optional(),
  startTime: time.nullable().optional(),
  endTime: time.nullable().optional(),
  status: z.enum(SHIFT_STATUSES).optional(),
  isDraft: z.boolean().optional(),
  dateTimeCreated: dateTime.nullable().optional(),
  dateTimeModified: dateTime.nullable().optional(),
  skillIds: ids.nullable().optional(),
  manualBreaks: z.array(manualBreak).max(100).nullable().optional(),
});

/** A shift type, without its pay fields (salaryCode, payPercentage, payMonetary, paymentType). */
const shiftType = z.object({
  id,
  name: text(500).nullable().optional(),
  color: text(20).nullable().optional(),
  isActive: z.boolean().optional(),
  allowsBreaks: z.boolean().optional(),
  allowBooking: z.boolean().optional(),
});

/** A position, without its revenue fields. */
const position = z.object({
  id,
  name: text(500).nullable().optional(),
  isActive: z.boolean().optional(),
  departmentId: id.nullable().optional(),
  sectionId: id.nullable().optional(),
  employeeGroupId: id.nullable().optional(),
  startDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
});

const requester = z.object({ employeeId: id, shiftRequestId: id.optional(), dateCreated: dateTime.nullable().optional() });
const shiftWithRequests = z.object({
  shiftId: id,
  departmentId: id.nullable().optional(),
  date: date.nullable().optional(),
  startDateTime: dateTime.nullable().optional(),
  endDateTime: dateTime.nullable().optional(),
  employeeGroupId: id.nullable().optional(),
  positionId: id.nullable().optional(),
  shiftTypeId: id.nullable().optional(),
  status: z.enum(SHIFT_STATUSES).optional(),
  requesters: z.array(requester).max(1_000),
});

const punchClockRecord = z.object({
  id,
  shiftId: id.nullable().optional(),
  departmentId: id,
  employeeId: id.nullable().optional(),
  startDateTime: dateTime.nullable().optional(),
  endDateTime: dateTime.nullable().optional(),
  shiftStartDateTime: dateTime.nullable().optional(),
  shiftEndDateTime: dateTime.nullable().optional(),
  description: text(5000).nullable().optional(),
  isApproved: z.boolean().nullable().optional(),
});

/** `{ data: {...} }` with the schema; with `expectedId`, the record asked for. */
function record<S extends z.ZodType>(schema: S, body: unknown, expectedId?: number): z.infer<S> {
  const result = z.object({ data: schema }).safeParse(body);
  if (!result.success) throw new UnexpectedAnswerError();
  const data = (result.data as { data: z.infer<S> }).data;
  if (expectedId !== undefined && (data as { id?: unknown }).id !== expectedId) throw new UnexpectedAnswerError();
  return data;
}

/** `{ data: [...], paging? }` with every entry fitting the schema. */
function list<S extends z.ZodType>(schema: S, body: unknown): { rows: Array<z.infer<S>>; paging?: z.infer<typeof paging> } {
  const result = z.object({ data: z.array(schema).max(10_000), paging: paging.nullable().optional() }).safeParse(body);
  if (!result.success) throw new UnexpectedAnswerError();
  return { rows: result.data.data as Array<z.infer<S>>, ...(result.data.paging ? { paging: result.data.paging } : {}) };
}

async function get(client: UpstreamClient, path: string, query?: Record<string, QueryValue>): Promise<unknown> {
  return nestedFailuresAsStatus(await client.get(path, query));
}

function idPath(prefix: string, recordId: number, name: string): string {
  return `${prefix}/${encodePathParam(String(recordId), name)}`;
}

function pageQuery(input: { offset?: number; limit?: number }, defaultLimit: number): Record<string, QueryValue> {
  return { offset: input.offset ?? 0, limit: input.limit ?? defaultLimit };
}

// ---------------------------------------------------------------------------
// Connection, departments, employee groups

/** One cheap read: the first department. Returns only that the app's token works and the number of departments. */
export async function checkConnection(client: UpstreamClient): Promise<Json> {
  const { paging: page } = list(department, await get(client, '/hr/v1.0/departments', { offset: 0, limit: 1 }));
  return { connected: true, ...(page ? { departments: page.total } : {}) };
}

export async function listDepartments(client: UpstreamClient, input: { offset?: number; limit?: number }): Promise<Json> {
  const { rows, paging: page } = list(department, await get(client, '/hr/v1.0/departments', pageQuery(input, 50)));
  return { departments: rows, paging: page ?? null };
}

export async function listEmployeeGroups(client: UpstreamClient, input: { offset?: number; limit?: number }): Promise<Json> {
  const { rows, paging: page } = list(employeeGroup, await get(client, '/hr/v1.0/employeegroups', pageQuery(input, 50)));
  return { employeeGroups: rows, paging: page ?? null };
}

// ---------------------------------------------------------------------------
// Employees

/**
 * Active employees, a page at a time (at most 50, as documented). The
 * `special` parameter is never sent, so CPR, bank account and birth date
 * are not asked for; `searchQuery` is sent only as a name or e-mail text
 * (the tool refuses digits, since Planday also matches it against the SSN
 * and the salary identifier).
 */
export async function listEmployees(
  client: UpstreamClient,
  input: { search?: string; offset?: number; limit?: number },
): Promise<Json> {
  const query: Record<string, QueryValue> = { ...pageQuery(input, 50), searchQuery: input.search };
  const { rows, paging: page } = list(employee, await get(client, '/hr/v1.0/employees', query));
  return { employees: rows, paging: page ?? null };
}

export async function getEmployee(client: UpstreamClient, input: { employeeId: number }): Promise<Json> {
  return record(employee, await get(client, idPath('/hr/v1.0/employees', input.employeeId, 'employeeId')), input.employeeId);
}

// ---------------------------------------------------------------------------
// Scheduling

export { SHIFT_STATUSES };

/** Shifts between two dates (inclusive), with the documented filters; 50 per page by default. */
export async function listShifts(
  client: UpstreamClient,
  input: {
    from: string;
    to: string;
    departmentId?: number;
    employeeId?: number;
    employeeGroupId?: number;
    status?: string;
    offset?: number;
    limit?: number;
  },
): Promise<Json> {
  const query: Record<string, QueryValue> = {
    from: input.from,
    to: input.to,
    departmentId: input.departmentId,
    employeeId: input.employeeId,
    employeeGroupId: input.employeeGroupId,
    shiftStatus: input.status,
    ...pageQuery(input, 50),
  };
  const { rows, paging: page } = list(shift, await get(client, '/scheduling/v1.0/shifts', query));
  return { shifts: rows, paging: page ?? null };
}

export async function getShift(client: UpstreamClient, input: { shiftId: number }): Promise<Json> {
  return record(shift, await get(client, idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId')), input.shiftId);
}

export async function listShiftTypes(client: UpstreamClient, input: { activeOnly?: boolean; offset?: number; limit?: number }): Promise<Json> {
  const query = { ...pageQuery(input, 50), isActive: input.activeOnly === undefined ? undefined : input.activeOnly };
  const { rows, paging: page } = list(shiftType, await get(client, '/scheduling/v1.0/shifttypes', query));
  return { shiftTypes: rows, paging: page ?? null };
}

export async function listPositions(client: UpstreamClient, input: { activeOnly?: boolean; offset?: number; limit?: number }): Promise<Json> {
  const query = { ...pageQuery(input, 50), isActive: input.activeOnly === undefined ? undefined : input.activeOnly };
  const { rows, paging: page } = list(position, await get(client, '/scheduling/v1.0/positions', query));
  return { positions: rows, paging: page ?? null };
}

/** Shifts with pending requests from employees, from 7 days ago on (as documented), for the departments given. */
export async function listShiftRequests(
  client: UpstreamClient,
  input: { departmentIds: number[]; offset?: number; limit?: number },
): Promise<Json> {
  const query = { departmentId: input.departmentIds, ...pageQuery(input, 50) };
  const { rows, paging: page } = list(shiftWithRequests, await get(client, '/scheduling/v1.0/shifts/requests', query));
  return { shifts: rows, paging: page ?? null };
}

// ---------------------------------------------------------------------------
// Punch clock

/** Punch clock records between two instants (the documented required period), optionally for one employee or shift. */
export async function listPunchClockRecords(
  client: UpstreamClient,
  input: { from: string; to: string; employeeId?: number; shiftId?: number; offset?: number; limit?: number },
): Promise<Json> {
  const query: Record<string, QueryValue> = {
    from: `${input.from}T00:00:00Z`,
    to: `${input.to}T23:59:59Z`,
    employeeId: input.employeeId,
    shiftId: input.shiftId,
    ...pageQuery(input, 50),
  };
  const { rows, paging: page } = list(punchClockRecord, await get(client, '/punchclock/v1.0/punchclockshifts', query));
  return { records: rows, paging: page ?? null };
}

// ---------------------------------------------------------------------------
// Writes

/**
 * Create a shift as a draft (isDraft true: not published to employees until
 * someone publishes it in Planday), without conflicts (allowConflicts
 * false: Planday refuses a shift that conflicts) and with the department's
 * break rules (useBreaks true). No default wage is sent.
 */
export async function createShift(
  client: UpstreamClient,
  input: {
    departmentId: number;
    employeeGroupId: number;
    date: string;
    startTime: string;
    endTime: string;
    employeeId?: number;
    positionId?: number;
    shiftTypeId?: number;
    comment?: string;
  },
): Promise<Json> {
  const body = {
    allowConflicts: false,
    useBreaks: true,
    isDraft: true,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    departmentId: input.departmentId,
    employeeGroupId: input.employeeGroupId,
    ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
    ...(input.positionId === undefined ? {} : { positionId: input.positionId }),
    ...(input.shiftTypeId === undefined ? {} : { shiftTypeId: input.shiftTypeId }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
  const created = record(shift, nestedFailuresAsStatus(await client.post('/scheduling/v1.0/shifts', body)));
  // The answer must be the shift asked for, as a draft. CreateShiftOutputModel requires every one of these fields
  // (https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json); one that is missing or differs is a failure.
  const sameTime = (answered: string | null | undefined, asked: string) => typeof answered === 'string' && answered.slice(0, 5) === asked;
  if (
    created.isDraft !== true ||
    created.date?.slice(0, 10) !== input.date ||
    !sameTime(created.startTime, input.startTime) ||
    !sameTime(created.endTime, input.endTime) ||
    created.departmentId !== input.departmentId ||
    created.employeeGroupId !== input.employeeGroupId ||
    (created.employeeId ?? null) !== (input.employeeId ?? null) ||
    (input.positionId !== undefined && created.positionId !== input.positionId) ||
    (input.shiftTypeId !== undefined && created.shiftTypeId !== input.shiftTypeId)
  ) {
    throw new UnexpectedAnswerError();
  }
  return created;
}

/**
 * Assign a shift to an employee, or make it open (employeeId null). Planday
 * documents no answer body, so the shift is read back and must show the
 * assignment.
 */
export async function assignShift(client: UpstreamClient, input: { shiftId: number; employeeId: number | null }): Promise<Json> {
  const path = idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId');
  nestedFailuresAsStatus(await client.post(`${path}/employee`, { employeeId: input.employeeId }));
  const after = record(shift, await get(client, path), input.shiftId);
  if ((after.employeeId ?? null) !== input.employeeId) throw new UnexpectedAnswerError();
  return after;
}

/**
 * Approve an employee's request for a shift: Planday assigns the shift to
 * them and keeps its other details (documented 204, 404 when there is no
 * pending request, 409 when it would break a conflict or labour rule).
 * Nobody is notified: notifyBySms and notifyByMessage are sent as false. The
 * shift is read back and must show the employee.
 */
export async function approveShiftRequest(client: UpstreamClient, input: { shiftId: number; employeeId: number }): Promise<Json> {
  const path = idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId');
  nestedFailuresAsStatus(
    await client.post(`${path}/requests/${encodePathParam(String(input.employeeId), 'employeeId')}/approve`, {
      notifyBySms: false,
      notifyByMessage: false,
    }),
  );
  const after = record(shift, await get(client, path), input.shiftId);
  if (after.employeeId !== input.employeeId) throw new UnexpectedAnswerError();
  return after;
}

/** A refusal of our own about the state of a record, said before anything was sent. */
export class RefusedChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedChangeError';
  }
}

const NOT_A_DRAFT =
  'Refused: the shift is not a draft. Only a shift that is not yet published can be changed or deleted here; a published shift is changed in Planday.';

/** A shift is changed or deleted here only while it is a draft: employees have not seen it, and nobody has worked it. */
async function draftShift(client: UpstreamClient, shiftId: number): Promise<z.infer<typeof shift>> {
  const current = record(shift, await get(client, idPath('/scheduling/v1.0/shifts', shiftId, 'shiftId')), shiftId);
  if (current.status !== 'Draft' && current.isDraft !== true) throw new RefusedChangeError(NOT_A_DRAFT);
  return current;
}

const hhmm = (value: string | null | undefined): string | null => (typeof value === 'string' ? value.slice(0, 5) : null);

/**
 * Change a draft shift. The shift is read first and must still be a draft.
 * Planday's UpdateShiftInputModel takes the whole shift (allowConflicts,
 * useBreaks, date and employeeGroupId are required), so the body is the
 * shift as it is with the fields asked for changed: allowConflicts false (a
 * change that conflicts is refused), useBreaks true (the department's break
 * rules), isDraft true (it stays a draft), manualBreaks left out (kept, as
 * documented). No wage is sent. The answer (UpdateShiftOutputModel) must
 * show the shift as asked for, still a draft.
 */
export async function updateDraftShift(
  client: UpstreamClient,
  input: {
    shiftId: number;
    date?: string;
    startTime?: string;
    endTime?: string;
    employeeId?: number | null;
    employeeGroupId?: number;
    positionId?: number | null;
    shiftTypeId?: number | null;
    comment?: string | null;
  },
): Promise<Json> {
  const current = await draftShift(client, input.shiftId);
  const pick = <T>(asked: T | undefined, now: T | null | undefined): T | null => (asked !== undefined ? asked : (now ?? null));
  const date = input.date ?? current.date?.slice(0, 10);
  const employeeGroupId = input.employeeGroupId ?? current.employeeGroupId;
  if (!date || !employeeGroupId) throw new UnexpectedAnswerError();
  const want = {
    date,
    startTime: input.startTime ?? hhmm(current.startTime),
    endTime: input.endTime ?? hhmm(current.endTime),
    employeeId: pick(input.employeeId, current.employeeId),
    employeeGroupId,
    positionId: pick(input.positionId, current.positionId),
    shiftTypeId: pick(input.shiftTypeId, current.shiftTypeId),
    comment: pick(input.comment, current.comment),
  };
  if (want.startTime !== null && want.startTime === want.endTime) {
    throw new RefusedChangeError('Refused: the shift would have no length; start and end are the same.');
  }
  const body = {
    allowConflicts: false,
    useBreaks: true,
    isDraft: true,
    ...want,
    skillIds: current.skillIds ?? null,
    ...(current.timeZone ? { timeZone: current.timeZone } : {}),
  };
  const path = idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId');
  const updated = record(shift, nestedFailuresAsStatus(await client.put(path, body)), input.shiftId);
  if (
    updated.isDraft !== true ||
    updated.date?.slice(0, 10) !== want.date ||
    hhmm(updated.startTime) !== want.startTime ||
    hhmm(updated.endTime) !== want.endTime ||
    (updated.employeeId ?? null) !== want.employeeId ||
    updated.employeeGroupId !== want.employeeGroupId ||
    (updated.positionId ?? null) !== want.positionId ||
    (updated.shiftTypeId ?? null) !== want.shiftTypeId
  ) {
    throw new UnexpectedAnswerError();
  }
  return updated;
}

/**
 * Delete a draft shift: read first, and it must still be a draft, so a
 * shift employees have seen or worked is never deleted here. Planday answers
 * 204 without a body.
 */
export async function deleteDraftShift(client: UpstreamClient, input: { shiftId: number }): Promise<Json> {
  await draftShift(client, input.shiftId);
  nestedFailuresAsStatus(await client.delete(idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId')));
  return { deleted: true, shiftId: input.shiftId };
}

/**
 * Approve a worked shift's punch clock record. Planday documents it as
 * "Approve a shift that is ready for payroll processing" (POST
 * /scheduling/v1.0/shifts/{shiftId}/approve, 204 without a body). The shift
 * is read first and must be punched out and not yet approved (status
 * PunchclockFinished); afterwards it is read again and must show it
 * approved.
 */
export async function approvePunchClockShift(client: UpstreamClient, input: { shiftId: number }): Promise<Json> {
  const path = idPath('/scheduling/v1.0/shifts', input.shiftId, 'shiftId');
  const before = record(shift, await get(client, path), input.shiftId);
  if (before.status !== 'PunchclockFinished') {
    throw new RefusedChangeError(
      before.status === 'PunchclockApproved'
        ? 'Refused: the punch clock record of this shift is already approved.'
        : 'Refused: only a shift that has been punched in and out (status PunchclockFinished) can be approved here.',
    );
  }
  nestedFailuresAsStatus(await client.post(`${path}/approve`));
  const after = record(shift, await get(client, path), input.shiftId);
  if (after.status !== 'PunchclockApproved' && after.status !== 'Approved') throw new UnexpectedAnswerError();
  return after;
}

const punchOutAnswer = z.object({
  startDateTime: dateTime.nullable().optional(),
  endDateTime: dateTime,
  departmentId: id,
});

/** "YYYY-MM-DDTHH:MM" as minutes, read as UTC: only ever compared with another value written the same way. */
function minutes(value: string): number {
  return Date.parse(`${value.slice(0, 16)}:00Z`) / 60_000;
}

/**
 * Set or correct the punch-out time of a shift's punch clock record with
 * Planday's PUT /punchclock/v1.0/punchclockshifts ("Set the punch out time
 * on a punch clock shift"): for an employee who forgot to punch out or
 * punched out at the wrong time. The record is read by its shift first
 * (GET .../punchclockshifts/byShift/{shiftId}) for its id, employee and
 * department; an approved record is not changed, and the end must be after
 * the punch-in. No comment and no salary note is sent. The answer must show
 * the end asked for.
 */
export async function setPunchOut(client: UpstreamClient, input: { shiftId: number; end: string }): Promise<Json> {
  const current = record(
    punchClockRecord,
    await get(client, `/punchclock/v1.0/punchclockshifts/byShift/${encodePathParam(String(input.shiftId), 'shiftId')}`),
  );
  if (current.shiftId !== input.shiftId || !current.employeeId || !current.startDateTime) throw new UnexpectedAnswerError();
  if (current.isApproved === true) {
    throw new RefusedChangeError('Refused: the punch clock record is approved; it is not changed here.');
  }
  if (minutes(input.end) <= minutes(current.startDateTime)) {
    throw new RefusedChangeError('Refused: the punch-out must be after the punch-in.');
  }
  const answer = nestedFailuresAsStatus(
    await client.put('/punchclock/v1.0/punchclockshifts', {
      punchClockShiftId: current.id,
      employeeId: current.employeeId,
      departmentId: current.departmentId,
      endDateTime: input.end,
    }),
  );
  const { rows } = list(punchOutAnswer, answer);
  const updated = rows[0];
  if (rows.length !== 1 || !updated || updated.endDateTime.slice(0, 16) !== input.end || updated.departmentId !== current.departmentId) {
    throw new UnexpectedAnswerError();
  }
  return {
    punchClockRecordId: current.id,
    shiftId: input.shiftId,
    employeeId: current.employeeId,
    startDateTime: updated.startDateTime ?? current.startDateTime,
    endDateTime: updated.endDateTime,
  };
}

// ---------------------------------------------------------------------------
// Absence (https://openapi.planday.com/absence/swagger/v1.0/swagger.json)

export const ABSENCE_TYPES = ['Vacation', 'Absence', 'Flextime', 'Accrued'] as const;
export const ABSENCE_REQUEST_STATUSES = ['Submitted', 'Declined', 'Approved', 'Cancelled'] as const;

const range = z.object({ start: text(40).nullable().optional(), end: text(40).nullable().optional() });

/** An absence account: what it counts (its name and type) and when it is valid, never its salary code. */
const absenceAccount = z.object({
  id,
  employeeId: id.nullable().optional(),
  typeId: id.nullable().optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
  name: text(500).nullable().optional(),
  validityPeriod: range.nullable().optional(),
});

/** An absence request without its note: the note is the employee's own text and can say why they are away. */
const absenceRequest = z.object({
  id,
  employeeId: id,
  absencePeriod: range.nullable().optional(),
  status: z.enum(ABSENCE_REQUEST_STATUSES).nullable().optional(),
  requestedAccounts: z
    .array(z.object({ id, name: text(500).nullable().optional() }))
    .max(100)
    .nullable()
    .optional(),
});

/** The accounts an employee's absence is counted on (holiday, sickness and so on), a page at a time. */
export async function listAbsenceAccounts(
  client: UpstreamClient,
  input: { employeeId: number; activeOnly?: boolean; offset?: number; limit?: number },
): Promise<Json> {
  const query: Record<string, QueryValue> = {
    employeeId: input.employeeId,
    status: input.activeOnly === undefined ? undefined : input.activeOnly ? 'Active' : 'Inactive',
    Offset: input.offset ?? 0,
    Limit: input.limit ?? 50,
  };
  const { rows, paging: page } = list(absenceAccount, await get(client, '/absence/v1.0/accounts', query));
  if (rows.some(row => (row.employeeId ?? input.employeeId) !== input.employeeId)) throw new UnexpectedAnswerError();
  return { accounts: rows, paging: page ?? null };
}

/** Absence requests, optionally for one employee, with the given statuses or overlapping two dates. */
export async function listAbsenceRequests(
  client: UpstreamClient,
  input: { employeeId?: number; statuses?: string[]; from?: string; to?: string; offset?: number; limit?: number },
): Promise<Json> {
  const query: Record<string, QueryValue> = {
    employeeId: input.employeeId,
    status: input.statuses,
    startDate: input.from,
    endDate: input.to,
    Offset: input.offset ?? 0,
    Limit: input.limit ?? 40,
  };
  const { rows, paging: page } = list(absenceRequest, await get(client, '/absence/v1.0/absencerequests', query));
  return { requests: rows, paging: page ?? null };
}

const cost = z.object({
  value: z.number().finite(),
  unit: z.object({ type: text(50).nullable().optional() }).nullable().optional(),
});

/** The draft Planday makes for an absence (GET /absence/v1.0/absencerequests/draft): the request body to submit. */
const absenceDraft = z.object({
  absenceRequest: z.object({
    absenceType: z.enum(ABSENCE_TYPES).nullable().optional(),
    absencePeriod: range,
    registrations: z
      .array(
        z.object({
          date: text(40),
          account: z
            .object({ id: id.nullable().optional(), costs: z.array(cost).max(50).nullable().optional() })
            .nullable()
            .optional(),
        }),
      )
      .min(1)
      .max(400),
  }),
});

const submitted = z.object({ id, status: z.enum(ABSENCE_REQUEST_STATUSES).nullable().optional() });

/**
 * The body of an approval: nobody is notified, the employee's shifts in the
 * period are left as they are (no shift is deleted or changed), and no open
 * shift is made to cover them.
 */
const APPROVAL = { notify: false, existingShifts: { action: 'NoAction' }, coverShifts: { action: 'DoNotCreate' } } as const;

/** Approve a submitted absence request (documented 204 without a body), with APPROVAL. */
export async function approveAbsenceRequest(client: UpstreamClient, input: { requestId: number }): Promise<Json> {
  nestedFailuresAsStatus(
    await client.put(`/absence/v1.0/absencerequests/${encodePathParam(String(input.requestId), 'requestId')}/approve`, APPROVAL),
  );
  return { approved: true, requestId: input.requestId };
}

/** The request was submitted, but its approval failed: our own text with the request's id, so it can be found. */
export class AbsenceNotApprovedError extends Error {
  constructor(requestId: number) {
    super(
      `The absence was submitted as request ${requestId}, but Planday did not approve it. ` +
        'Approve it with approve_absence_request or in Planday.',
    );
    this.name = 'AbsenceNotApprovedError';
  }
}

/**
 * Register an employee's absence the way Planday documents it for a manager:
 * get a draft for the employee, the period and the account or type (GET
 * .../absencerequests/draft), submit the draft unchanged on their behalf
 * (POST .../absencerequests), and approve it (PUT .../approve, with
 * APPROVAL). No note is sent.
 */
export async function registerAbsence(
  client: UpstreamClient,
  input: { employeeId: number; from: string; to: string; accountId?: number; absenceType?: string },
): Promise<Json> {
  const query: Record<string, QueryValue> = {
    employeeId: input.employeeId,
    startDate: input.from,
    endDate: input.to,
    accountId: input.accountId,
    absenceType: input.absenceType,
  };
  const parsed = z.object({ data: absenceDraft }).safeParse(await get(client, '/absence/v1.0/absencerequests/draft', query));
  if (!parsed.success) throw new UnexpectedAnswerError();
  const draft = parsed.data.data.absenceRequest;
  if (draft.absencePeriod.start?.slice(0, 10) !== input.from || draft.absencePeriod.end?.slice(0, 10) !== input.to) {
    throw new UnexpectedAnswerError();
  }
  if (input.accountId !== undefined && draft.registrations.some(entry => entry.account?.id !== input.accountId)) {
    throw new UnexpectedAnswerError();
  }
  const body = {
    ...(draft.absenceType ? { absenceType: draft.absenceType } : {}),
    absencePeriod: { start: draft.absencePeriod.start, end: draft.absencePeriod.end },
    registrations: draft.registrations,
  };
  const answer = submitted.safeParse(nestedFailuresAsStatus(await client.post('/absence/v1.0/absencerequests', body)));
  if (!answer.success) throw new UnexpectedAnswerError();
  const requestId = answer.data.id;
  if (answer.data.status !== 'Approved') {
    try {
      await approveAbsenceRequest(client, { requestId });
    } catch {
      throw new AbsenceNotApprovedError(requestId);
    }
  }
  return { registered: true, requestId, employeeId: input.employeeId, from: input.from, to: input.to, days: draft.registrations.length };
}
