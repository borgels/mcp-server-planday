import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../planday/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../planday/audit.js';
import { readOnlyClient, type UpstreamClient } from '../planday/client.js';
import { formatUnknownError, redactDeep, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import {
  ABSENCE_REQUEST_STATUSES,
  ABSENCE_TYPES,
  approveAbsenceRequest,
  approvePunchClockShift,
  deleteDraftShift,
  listAbsenceAccounts,
  listAbsenceRequests,
  registerAbsence,
  setPunchOut,
  updateDraftShift,
  approveShiftRequest,
  assignShift,
  checkConnection,
  createShift,
  getEmployee,
  getShift,
  listDepartments,
  listEmployeeGroups,
  listEmployees,
  listPositions,
  listPunchClockRecords,
  listShiftRequests,
  listShifts,
  listShiftTypes,
  SHIFT_STATUSES,
} from '../planday/resources.js';
import {
  checkInputPolicy,
  checkToolPolicy,
  currentInstancePolicy,
  isToolDisabled,
  redactInScope,
  runInCallScope,
  validatePolicyConfig,
} from '../planday/policy.js';
import { daysBetween, isIsoDate, isRecordId, isTime, TIME_PATTERN } from '../planday/values.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the API base (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
}

/** A client that carries the redactor of its instance (PlandayClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/** What a write tool does. */
export type PlandayChangeAction = 'create' | 'assign' | 'approve_request' | 'update' | 'delete' | 'approve' | 'punch_out' | 'register';

/** The kind of record a write tool touches. */
export type PlandayChangeRecord = 'shift' | 'punch_clock' | 'absence';

/**
 * The type a logged value must have; anything else is left out of the values.
 *   recordId  a Planday id (a positive integer), in clear
 *   date      a date YYYY-MM-DD, in clear
 *   time      a time HH:MM, in clear
 *   count     the number of entries in a list, never the entries
 *   flag      true or false, in clear
 *   kind      one value from a fixed list the tool's schema allows, in clear
 *   pseudonym a value a person chose; never logged in clear: "sha256:" and
 *             16 hex characters, or "hmac:" with a key from the host.
 * Names, e-mail addresses, comments and other free text are never log fields.
 */
export type PlandayLogFieldType = 'recordId' | 'date' | 'time' | 'count' | 'flag' | 'kind' | 'pseudonym';

export interface PlandayLogField {
  readonly name: string;
  readonly type: PlandayLogFieldType;
}

/**
 * Write tools only: what the change does, for a host that logs a change
 * before it is sent. `logFields` are the input fields that identify it, each
 * with the one type its value must have.
 */
export interface PlandayChangeSpec {
  readonly action: PlandayChangeAction;
  readonly record: PlandayChangeRecord;
  /** Always false: no tool moves money or sets a wage. */
  readonly movesMoney: false;
  readonly logFields: readonly PlandayLogField[];
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`planday_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /** True when the tool can read more than its name says. None of these tools does. */
  broad?: boolean;
  /** Write tools: what the change does. */
  change?: PlandayChangeSpec;
  /** True when a person should confirm each call outside the chat. No tool here moves money, so none is. */
  requiresConfirmation?: boolean;
  /** Cross-field checks the schema shape cannot express. Returns a refusal or undefined. */
  check?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const change = (
  action: PlandayChangeAction,
  record: PlandayChangeRecord,
  logFields: Record<string, PlandayLogFieldType>,
): PlandayChangeSpec => ({
  action,
  record,
  movesMoney: false,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

// ---------------------------------------------------------------------------
// Schemas

const recordId = (what: string) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(what);
const dateSchema = z.string().trim().refine(isIsoDate, 'must be a date written YYYY-MM-DD');
const timeSchema = z.string().trim().regex(TIME_PATTERN, 'must be a time written HH:MM');
const dateTimeSchema = z
  .string()
  .trim()
  .refine(
    value => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) && isIsoDate(value.slice(0, 10)),
    'must be a local date and time written YYYY-MM-DDTHH:MM',
  );
/** At most this many days of absence in one registration, both dates included. */
const MAX_ABSENCE_DAYS = 366;
const pageShape = (max: number) => ({
  offset: z.number().int().min(0).max(1_000_000).optional().describe('Skip this many records (default 0).'),
  limit: z.number().int().min(1).max(max).optional().describe(`Records per page (default 50, at most ${max}).`),
});
/** At most this many days per shift or punch clock query, both dates included. */
const MAX_PERIOD_DAYS = 62;

function absencePeriod(input: Record<string, unknown>): string | undefined {
  const days = daysBetween(String(input.from), String(input.to));
  if (days < 0) return 'to is before from.';
  if (days + 1 > MAX_ABSENCE_DAYS) return `Register at most ${MAX_ABSENCE_DAYS} days at a time.`;
  if ((input.accountId === undefined) === (input.absenceType === undefined)) return 'Give either accountId or absenceType, not both.';
  return undefined;
}

function period(input: Record<string, unknown>): string | undefined {
  const from = String(input.from);
  const to = String(input.to);
  const days = daysBetween(from, to);
  if (days < 0) return 'to is before from.';
  // Both dates count: 2026-11-01 to 2026-11-01 is one day.
  return days + 1 > MAX_PERIOD_DAYS ? `Ask for at most ${MAX_PERIOD_DAYS} days at a time.` : undefined;
}

const WRITE_NOTE = 'Off unless writes are enabled (PLANDAY_ENABLE_WRITES, or the gateway host policy enableWrites).';

export const PLANDAY_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'planday_check_connection',
    title: 'Check Planday connection',
    description: "Check that the app's token works, by reading one department. Returns only whether it works and the number of departments.",
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Checked the connection.',
    upstream: [{ access: 'read', method: 'GET', path: '/hr/v1.0/departments' }],
    handler: async client => checkConnection(client),
  }),
  defineTool({
    name: 'planday_list_departments',
    title: 'List departments (Planday)',
    description: 'Departments of the portal: id, name and number.',
    inputShape: pageShape(50),
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed departments.',
    upstream: [{ access: 'read', method: 'GET', path: '/hr/v1.0/departments' }],
    handler: async (client, input) => listDepartments(client, input),
  }),
  defineTool({
    name: 'planday_list_employee_groups',
    title: 'List employee groups (Planday)',
    description: 'Employee groups (e.g. kitchen, bar): id and name.',
    inputShape: pageShape(50),
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed employee groups.',
    upstream: [{ access: 'read', method: 'GET', path: '/hr/v1.0/employeegroups' }],
    handler: async (client, input) => listEmployeeGroups(client, input),
  }),
  defineTool({
    name: 'planday_list_employees',
    title: 'List employees (Planday)',
    description:
      'Active employees, a page at a time: name, job title, work e-mail and mobile, departments, employee groups, skills and hire date. CPR number, bank account, birth date, salary identifier, home address and wages are never passed on.',
    inputShape: {
      search: z
        .string()
        .trim()
        .min(2)
        .max(100)
        .regex(/^[^\d]+$/, 'search by name or e-mail, without digits')
        .optional()
        .describe('A name or an e-mail address to search for. No digits: Planday also searches CPR numbers and salary identifiers.'),
      ...pageShape(50),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed employees.',
    upstream: [{ access: 'read', method: 'GET', path: '/hr/v1.0/employees' }],
    handler: async (client, input) => listEmployees(client, input),
  }),
  defineTool({
    name: 'planday_get_employee',
    title: 'Get employee (Planday)',
    description:
      'One employee: name, job title, work e-mail and mobile, departments, groups, skills, supervisor, hire and end date. CPR number, bank account, birth date, salary identifier, home address, gender and wages are never passed on.',
    inputShape: { employeeId: recordId('The employee id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched employee.',
    upstream: [{ access: 'read', method: 'GET', path: '/hr/v1.0/employees/{employeeId}' }],
    handler: async (client, input) => getEmployee(client, input),
  }),
  defineTool({
    name: 'planday_list_shifts',
    title: 'List shifts (Planday)',
    description:
      'Shifts between two dates (inclusive, at most 62 days): date, start and end, department, employee, employee group, position, shift type, status, breaks and the comment. No wages.',
    inputShape: {
      from: dateSchema.describe('First date, YYYY-MM-DD.'),
      to: dateSchema.describe('Last date, YYYY-MM-DD.'),
      departmentId: recordId('Only this department.').optional(),
      employeeId: recordId('Only this employee.').optional(),
      employeeGroupId: recordId('Only this employee group.').optional(),
      status: z.enum(SHIFT_STATUSES.slice(0, 8) as [string, ...string[]]).optional().describe('Only shifts with this status.'),
      ...pageShape(200),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed shifts.',
    upstream: [{ access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts' }],
    check: period,
    handler: async (client, input) => listShifts(client, input),
  }),
  defineTool({
    name: 'planday_get_shift',
    title: 'Get shift (Planday)',
    description: 'One shift with its breaks. No wages.',
    inputShape: { shiftId: recordId('The shift id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched shift.',
    upstream: [{ access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' }],
    handler: async (client, input) => getShift(client, input),
  }),
  defineTool({
    name: 'planday_list_shift_types',
    title: 'List shift types (Planday)',
    description: 'Shift types: name, colour, whether active and whether breaks and booking are allowed. Salary codes and pay supplements are left out.',
    inputShape: { activeOnly: z.boolean().optional().describe('Only active (true) or inactive (false) types.'), ...pageShape(50) },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed shift types.',
    upstream: [{ access: 'read', method: 'GET', path: '/scheduling/v1.0/shifttypes' }],
    handler: async (client, input) => listShiftTypes(client, input),
  }),
  defineTool({
    name: 'planday_list_positions',
    title: 'List positions (Planday)',
    description: 'Schedule positions: name, department, section, employee group and period. Revenue settings are left out.',
    inputShape: { activeOnly: z.boolean().optional().describe('Only active (true) or inactive (false) positions.'), ...pageShape(50) },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed positions.',
    upstream: [{ access: 'read', method: 'GET', path: '/scheduling/v1.0/positions' }],
    handler: async (client, input) => listPositions(client, input),
  }),
  defineTool({
    name: 'planday_list_shift_requests',
    title: 'List shift requests (Planday)',
    description:
      'Shifts that employees have asked to take, from 7 days ago on, for the departments given: the shift and who asked, oldest first. The app needs permission to approve shift requests in every department given.',
    inputShape: {
      departmentIds: z.array(recordId('A department id.')).min(1).max(50).describe('The departments, 1 to 50.'),
      ...pageShape(50),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed shift requests.',
    upstream: [{ access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/requests' }],
    handler: async (client, input) => listShiftRequests(client, input),
  }),
  defineTool({
    name: 'planday_list_punch_clock_records',
    title: 'List punch clock records (Planday)',
    description:
      'Punch clock records between two dates (at most 62 days): employee, shift, department, punched in and out, the planned shift times, the description and whether approved.',
    inputShape: {
      from: dateSchema.describe('First date, YYYY-MM-DD.'),
      to: dateSchema.describe('Last date, YYYY-MM-DD.'),
      employeeId: recordId('Only this employee.').optional(),
      shiftId: recordId('Only this shift.').optional(),
      ...pageShape(200),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed punch clock records.',
    upstream: [{ access: 'read', method: 'GET', path: '/punchclock/v1.0/punchclockshifts' }],
    check: period,
    handler: async (client, input) => listPunchClockRecords(client, input),
  }),

  // -------------------------------------------------------------------------
  defineTool({
    name: 'planday_list_absence_accounts',
    title: 'List absence accounts (Planday)',
    description:
      "One employee's absence accounts (holiday, sickness, time off in lieu and so on): id, name, type, whether active and the period it is valid. Salary codes are left out.",
    inputShape: {
      employeeId: recordId('The employee.'),
      activeOnly: z.boolean().optional().describe('Only active (true) or inactive (false) accounts.'),
      ...pageShape(50),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed absence accounts.',
    upstream: [{ access: 'read', method: 'GET', path: '/absence/v1.0/accounts' }],
    handler: async (client, input) => listAbsenceAccounts(client, input),
  }),
  defineTool({
    name: 'planday_list_absence_requests',
    title: 'List absence requests (Planday)',
    description:
      "Absence requests: employee, period, status (Submitted, Declined, Approved, Cancelled) and the accounts asked for. The employee's note is left out, since it can say why they are away.",
    inputShape: {
      employeeId: recordId('Only this employee.').optional(),
      statuses: z.array(z.enum(ABSENCE_REQUEST_STATUSES)).min(1).max(4).optional().describe('Only requests with these statuses.'),
      from: dateSchema.describe('Only requests ending on this date or later, YYYY-MM-DD.').optional(),
      to: dateSchema.describe('Only requests starting on this date or earlier, YYYY-MM-DD.').optional(),
      ...pageShape(50),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed absence requests.',
    upstream: [{ access: 'read', method: 'GET', path: '/absence/v1.0/absencerequests' }],
    check: input =>
      typeof input.from === 'string' && typeof input.to === 'string' && daysBetween(input.from, input.to) < 0 ? 'to is before from.' : undefined,
    handler: async (client, input) => listAbsenceRequests(client, input),
  }),

  // -------------------------------------------------------------------------
  // Writes. No tool publishes the schedule, changes or deletes a published shift, swaps, punches in, changes an
  // employee or an absence account, sets or reads a wage, or notifies anyone. The only deletion is of a draft shift.

  defineTool({
    name: 'planday_create_shift',
    title: 'Create draft shift (Planday)',
    description: `Create a shift as a draft: employees do not see it until someone publishes the schedule in Planday. Planday refuses a shift that conflicts with others, and the department's break rules apply. No wage is set. ${WRITE_NOTE}`,
    inputShape: {
      departmentId: recordId('The department.'),
      employeeGroupId: recordId('The employee group the shift belongs to.'),
      date: dateSchema.describe('The date of the shift, YYYY-MM-DD.'),
      startTime: timeSchema.describe('Start, HH:MM.'),
      endTime: timeSchema.describe('End, HH:MM (an end before the start means the next day).'),
      employeeId: recordId('The employee to assign (left out: an open shift).').optional(),
      positionId: recordId('The position.').optional(),
      shiftTypeId: recordId('The shift type.').optional(),
      comment: z.string().trim().min(1).max(1000).optional().describe('A comment managers and employees can see.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created draft shift.',
    upstream: [{ access: 'write', method: 'POST', path: '/scheduling/v1.0/shifts' }],
    change: change('create', 'shift', {
      departmentId: 'recordId',
      employeeGroupId: 'recordId',
      employeeId: 'recordId',
      positionId: 'recordId',
      shiftTypeId: 'recordId',
      date: 'date',
      startTime: 'time',
      endTime: 'time',
    }),
    check: input => (isTime(input.startTime) && input.startTime === input.endTime ? 'The shift has no length: start and end are the same.' : undefined),
    handler: async (client, input) => createShift(client, input),
  }),
  defineTool({
    name: 'planday_assign_shift',
    title: 'Assign shift (Planday)',
    description: `Give a shift to an employee, or make it open (employeeId null). Nothing else on the shift changes. Reads the shift back to confirm. ${WRITE_NOTE}`,
    inputShape: {
      shiftId: recordId('The shift.'),
      employeeId: z.union([recordId('The employee.'), z.null()]).describe('The employee, or null for an open shift.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Assigned shift.',
    upstream: [
      { access: 'write', method: 'POST', path: '/scheduling/v1.0/shifts/{shiftId}/employee' },
      { access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' },
    ],
    change: change('assign', 'shift', { shiftId: 'recordId', employeeId: 'recordId' }),
    handler: async (client, input) => assignShift(client, input),
  }),
  defineTool({
    name: 'planday_approve_shift_request',
    title: 'Approve shift request (Planday)',
    description: `Approve an employee's request for a shift (from list_shift_requests): Planday gives them the shift and keeps its other details, and refuses when the employee has no pending request or it would break a conflict or labour rule. No SMS or message is sent. ${WRITE_NOTE}`,
    inputShape: {
      shiftId: recordId('The shift.'),
      employeeId: recordId('The employee who asked for it.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Approved shift request.',
    upstream: [
      { access: 'write', method: 'POST', path: '/scheduling/v1.0/shifts/{shiftId}/requests/{employeeId}/approve' },
      { access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' },
    ],
    change: change('approve_request', 'shift', { shiftId: 'recordId', employeeId: 'recordId' }),
    handler: async (client, input) => approveShiftRequest(client, input),
  }),
  defineTool({
    name: 'planday_update_draft_shift',
    title: 'Change draft shift (Planday)',
    description: `Change a shift that is still a draft (not yet published): date, times, employee, employee group, position, shift type or comment. A field left out keeps its value; null empties employee, position, shift type or comment. The shift is read first and refused if it is published. It stays a draft, Planday refuses a change that conflicts with other shifts, and the department's break rules apply. No wage is set. ${WRITE_NOTE}`,
    inputShape: {
      shiftId: recordId('The draft shift.'),
      date: dateSchema.describe('New date, YYYY-MM-DD.').optional(),
      startTime: timeSchema.describe('New start, HH:MM.').optional(),
      endTime: timeSchema.describe('New end, HH:MM (an end before the start means the next day).').optional(),
      employeeId: z.union([recordId('The employee.'), z.null()]).optional().describe('The employee, or null for an open shift.'),
      employeeGroupId: recordId('The employee group.').optional(),
      positionId: z.union([recordId('The position.'), z.null()]).optional().describe('The position, or null for none.'),
      shiftTypeId: z.union([recordId('The shift type.'), z.null()]).optional().describe('The shift type, or null for none.'),
      comment: z
        .union([z.string().trim().min(1).max(1000), z.null()])
        .optional()
        .describe('A comment managers and employees can see, or null to remove it.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Changed draft shift.',
    upstream: [
      { access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' },
      { access: 'write', method: 'PUT', path: '/scheduling/v1.0/shifts/{shiftId}' },
    ],
    change: change('update', 'shift', {
      shiftId: 'recordId',
      date: 'date',
      startTime: 'time',
      endTime: 'time',
      employeeId: 'recordId',
      employeeGroupId: 'recordId',
      positionId: 'recordId',
      shiftTypeId: 'recordId',
    }),
    check: input =>
      Object.keys(input).filter(key => key !== 'shiftId' && input[key] !== undefined).length === 0
        ? 'Nothing to change: give at least one field besides shiftId.'
        : isTime(input.startTime) && input.startTime === input.endTime
          ? 'The shift has no length: start and end are the same.'
          : undefined,
    handler: async (client, input) => updateDraftShift(client, input),
  }),
  defineTool({
    name: 'planday_delete_draft_shift',
    title: 'Delete draft shift (Planday)',
    description: `Delete a shift that is still a draft (not yet published): no employee has seen it and nobody has worked it. The shift is read first and refused if it is published. A published or worked shift is never deleted. ${WRITE_NOTE}`,
    inputShape: { shiftId: recordId('The draft shift.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Deleted draft shift.',
    upstream: [
      { access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' },
      { access: 'write', method: 'DELETE', path: '/scheduling/v1.0/shifts/{shiftId}' },
    ],
    change: change('delete', 'shift', { shiftId: 'recordId' }),
    handler: async (client, input) => deleteDraftShift(client, input),
  }),
  defineTool({
    name: 'planday_approve_punch_clock',
    title: 'Approve punch clock record (Planday)',
    description: `Approve the punch clock record of a worked shift, so it is ready for payroll in Planday. The shift is read first and must be punched in and out and not yet approved (status PunchclockFinished); it is read again afterwards to confirm. No wage is set and nothing is paid. ${WRITE_NOTE}`,
    inputShape: { shiftId: recordId('The worked shift (from list_shifts or list_punch_clock_records).') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Approved punch clock record.',
    upstream: [
      { access: 'read', method: 'GET', path: '/scheduling/v1.0/shifts/{shiftId}' },
      { access: 'write', method: 'POST', path: '/scheduling/v1.0/shifts/{shiftId}/approve' },
    ],
    change: change('approve', 'punch_clock', { shiftId: 'recordId' }),
    handler: async (client, input) => approvePunchClockShift(client, input),
  }),
  defineTool({
    name: 'planday_set_punch_out',
    title: 'Set punch-out time (Planday)',
    description: `Set or correct when an employee punched out of a shift, for example when they forgot to punch out. The shift's punch clock record is read first; an approved record is not changed, and the punch-out must be after the punch-in. The time is the portal's local time. The punch-in time cannot be changed through Planday's API. ${WRITE_NOTE}`,
    inputShape: {
      shiftId: recordId('The shift the punch clock record belongs to.'),
      end: dateTimeSchema.describe('The punch-out, local date and time YYYY-MM-DDTHH:MM.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Set punch-out time.',
    upstream: [
      { access: 'read', method: 'GET', path: '/punchclock/v1.0/punchclockshifts/byShift/{shiftId}' },
      { access: 'write', method: 'PUT', path: '/punchclock/v1.0/punchclockshifts' },
    ],
    change: change('punch_out', 'punch_clock', { shiftId: 'recordId' }),
    handler: async (client, input) => setPunchOut(client, input),
  }),
  defineTool({
    name: 'planday_register_absence',
    title: 'Register absence (Planday)',
    description: `Register an employee's absence from one date to another (both included), on an absence account (accountId, from list_absence_accounts) or by type (absenceType): Planday makes the request as it would for the employee, and it is approved at once. Nobody is notified, the employee's shifts in the period are left as they are, and no open shift is made. No note is sent. ${WRITE_NOTE}`,
    inputShape: {
      employeeId: recordId('The employee.'),
      from: dateSchema.describe('First day of absence, YYYY-MM-DD.'),
      to: dateSchema.describe('Last day of absence, YYYY-MM-DD.'),
      accountId: recordId('The absence account (from list_absence_accounts).').optional(),
      absenceType: z.enum(ABSENCE_TYPES).optional().describe('The type of absence, when no account is given.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Registered absence.',
    upstream: [
      { access: 'read', method: 'GET', path: '/absence/v1.0/absencerequests/draft' },
      { access: 'write', method: 'POST', path: '/absence/v1.0/absencerequests' },
      { access: 'write', method: 'PUT', path: '/absence/v1.0/absencerequests/{requestId}/approve' },
    ],
    change: change('register', 'absence', {
      employeeId: 'recordId',
      from: 'date',
      to: 'date',
      accountId: 'recordId',
      absenceType: 'kind',
    }),
    check: absencePeriod,
    handler: async (client, input) => registerAbsence(client, input),
  }),
  defineTool({
    name: 'planday_approve_absence_request',
    title: 'Approve absence request (Planday)',
    description: `Approve an employee's absence request (from list_absence_requests). Nobody is notified, the employee's shifts in the period are left as they are, and no open shift is made. Planday refuses a request that does not exist. ${WRITE_NOTE}`,
    inputShape: { requestId: recordId('The absence request.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Approved absence request.',
    upstream: [{ access: 'write', method: 'PUT', path: '/absence/v1.0/absencerequests/{requestId}/approve' }],
    change: change('approve', 'absence', { requestId: 'recordId' }),
    handler: async (client, input) => approveAbsenceRequest(client, input),
  }),
];

/**
 * Validate a write call's input exactly as executeTool does before it sends
 * anything: the strict schema, then the tool's own cross-field check. Used
 * by the change resolution, so a call it accepts is one that would run.
 */
export function validateCall(tool: ToolDefinition, input: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false };
  const data = parsed.data as Record<string, unknown>;
  return tool.check?.(data) ? { ok: false } : { ok: true, data };
}

export function findTool(name: string): ToolDefinition | undefined {
  return PLANDAY_TOOLS.find(tool => tool.name === name);
}

/** The pseudonym of a value: HMAC-SHA-256 with the host's key, else SHA-256; 16 hex characters with a prefix. */
export function pseudonym(value: string, key?: string | Uint8Array): string {
  if (key !== undefined && key.length > 0) {
    return `hmac:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
  }
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

const KIND_VALUES = /^[A-Za-z][A-Za-z_-]{0,19}$/;

/**
 * The value of one log field when it has exactly the field's type; otherwise
 * undefined. A number the company chose comes back only as a pseudonym.
 */
export function logFieldValue(
  type: PlandayLogFieldType,
  value: unknown,
  pseudonymKey?: string | Uint8Array,
): string | number | boolean | undefined {
  switch (type) {
    case 'recordId':
      return isRecordId(value) ? value : undefined;
    case 'date':
      return isIsoDate(value) ? value : undefined;
    case 'time':
      return isTime(value) ? value : undefined;
    case 'count':
      return Array.isArray(value) ? value.length : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'kind':
      return typeof value === 'string' && KIND_VALUES.test(value) ? value : undefined;
    case 'pseudonym':
      return typeof value === 'string' && value.length > 0 && value.length <= 100 ? pseudonym(value, pseudonymKey) : undefined;
    default:
      return undefined;
  }
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(PLANDAY_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (PLANDAY_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return PLANDAY_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        let result: { content: Array<{ type: 'text'; text: string }>; isError?: true };
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // Planday data can echo a token, in values or in object keys: redacted as data before it is serialised (a
          // serialised token is escaped and no longer matches), as on the gateway.
          result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          result = { isError: true, content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }] };
        }
        // The same last check as the gateway: a result that still holds a piece of the token is withheld whole.
        return leaksSecret(result, client.redactor) ? withheldResult() : result;
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * The audit's view of a call context. Nothing the host sends is kept in
 * clear: a request id may be any text (a name, a phone number, an address),
 * so the audit keeps its pseudonym, which still ties the lines of one call
 * together for the host that knows the key; without a request id the audit
 * makes one. The caller becomes a pseudonym the same way. Both are keyed
 * with the host's policy.pseudonymKey when given.
 */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  const key = currentInstancePolicy()?.pseudonymKey;
  const given = typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId.slice(0, 1000) : undefined;
  const requestId = given === undefined ? newRequestId() : pseudonym(given, key);
  const caller = contextString(value.caller, 320);
  return {
    requestId,
    ...(caller === undefined ? {} : { caller: pseudonym(caller, key) }),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  const refusal = inputPolicy.allowed ? tool.check?.(input) : undefined;
  if (!inputPolicy.allowed || refusal) {
    const reason = inputPolicy.allowed ? (refusal as string) : inputPolicy.reason;
    await writeAuditEvent({ requestId, tool: tool.name, caller, action: 'policy_denied', target, reason }, { redactor });
    throw new Error(reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

/** Why a call was rejected before it ran: a fixed code, never text from the caller. */
export type RejectionCode = 'unknown_tool' | 'invalid_input';

/**
 * Audit a call rejected before execution (unknown tool or invalid input).
 * The record holds only what we wrote: a known tool name (an unknown one is
 * recorded as `unknown` with a pseudonym of what was given), the argument
 * names that the tool's schema knows, the number of other arguments, and a
 * fixed code. A caller can put a name or a text anywhere, so nothing it
 * chose is logged in clear.
 */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  code: RejectionCode,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const tool = typeof toolName === 'string' ? findTool(toolName) : undefined;
  const known = new Set(tool ? Object.keys(tool.inputShape) : []);
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const fields = keys.filter(key => known.has(key)).sort();
  await writeAuditEvent({
    requestId,
    tool: tool ? tool.name : 'unknown',
    caller,
    action: 'rejected',
    target: {
      ...(tool ? {} : { toolPseudonym: pseudonym(String(toolName).slice(0, 200)) }),
      fields,
      otherFields: keys.length - fields.length,
    },
    reason: code,
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
