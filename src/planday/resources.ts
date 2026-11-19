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
