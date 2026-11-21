// The everyday changes of a shift planner (borgels/mcp-server-planday#8): change and delete draft shifts, approve
// punch clock records, set a forgotten punch-out, register and approve absence. Answers are shaped as Planday's
// published OpenAPI documents show them (https://openapi.planday.com/{scheduling,punchclock,absence}/swagger/v1.0/
// swagger.json); no Planday portal was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlandayGateway, resolvePlandayChange, type GatewayJsonObject } from '../src/gateway.js';
import { CLIENT_ID, SHIFT_CREATED, withToken } from './helpers.js';

const TOKEN = 'eeee-vvvv-dddd-aaaa-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('PLANDAY_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: URL, init: RequestInit) => unknown;
type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

/** A Planday stand-in: routes by "METHOD /path"; a route may be a list of answers, given in turn. Unknown: 404. */
function planday(routes: Record<string, Handler | unknown>, policy: Record<string, unknown> = { enableWrites: true }) {
  const calls: Call[] = [];
  const turns = new Map<string, number>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.pathname}`;
    let route = routes[key];
    if (Array.isArray(route) && route.length > 0 && route.every(entry => typeof entry === 'object' && entry !== null && 'turn' in entry)) {
      const turn = turns.get(key) ?? 0;
      turns.set(key, turn + 1);
      route = (route[Math.min(turn, route.length - 1)] as { turn: unknown }).turn;
    }
    if (route === undefined) return Response.json({ title: 'Not Found', status: 404 }, { status: 404 });
    const body = typeof route === 'function' ? (route as Handler)(url, init ?? {}) : route;
    if (body instanceof Response) return body;
    if (body === null) return new Response(null, { status: 204 });
    return Response.json(body);
  });
  const gw = createPlandayGateway({
    clientId: CLIENT_ID,
    refreshToken: TOKEN,
    maxAttempts: 1,
    fetchImpl: withToken(fetchImpl),
    policy: policy as never,
  });
  const writes = () => calls.filter(c => c.method !== 'GET');
  return { gw, calls, writes };
}

const call = (gw: ReturnType<typeof planday>['gw'], tool: string, input: GatewayJsonObject = {}) => gw.callTool(tool, input);
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join(' ');

const DRAFT = { ...SHIFT_CREATED, id: 31, status: 'Draft', employeeId: 7, positionId: 4, comment: 'Lukkevagt', skillIds: [3] };
const PUBLISHED = { ...DRAFT, isDraft: false, status: 'Assigned' };

describe('update_draft_shift', () => {
  it('sends the whole draft with the changes asked for, as a draft, without conflicts and without a wage', async () => {
    const { gw, writes } = planday({
      'GET /scheduling/v1.0/shifts/31': { data: DRAFT },
      'PUT /scheduling/v1.0/shifts/31': (_url: URL, init: RequestInit) => ({ data: { ...DRAFT, ...JSON.parse(String(init.body)) } }),
    });
    const result = await call(gw, 'update_draft_shift', { shiftId: 31, startTime: '09:00', positionId: null });
    expect(result.isError, text(result)).toBeUndefined();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual({
      allowConflicts: false,
      useBreaks: true,
      isDraft: true,
      date: '2026-11-20',
      startTime: '09:00',
      endTime: '16:00',
      employeeId: 7,
      employeeGroupId: 2,
      positionId: null,
      shiftTypeId: null,
      comment: 'Lukkevagt',
      skillIds: [3],
      timeZone: 'Europe/Copenhagen',
    });
    expect(JSON.stringify(writes()[0]?.body)).not.toMatch(/defaultWage|manualBreaks/);
  });

  it('refuses a published shift before anything is sent', async () => {
    const { gw, writes } = planday({ 'GET /scheduling/v1.0/shifts/31': { data: PUBLISHED } });
    const result = await call(gw, 'update_draft_shift', { shiftId: 31, startTime: '09:00' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not a draft/);
    expect(writes()).toEqual([]);
  });

  it('refuses a call with nothing to change, and a shift without length', async () => {
    const { gw, calls } = planday({});
    expect((await call(gw, 'update_draft_shift', { shiftId: 31 })).isError).toBe(true);
    expect((await call(gw, 'update_draft_shift', { shiftId: 31, startTime: '08:00', endTime: '08:00' })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('reports a failure when the answer is not the shift asked for, or no longer a draft', async () => {
    for (const answer of [{ ...DRAFT, startTime: '08:00' }, { ...DRAFT, startTime: '09:00', isDraft: false }, { ...DRAFT, startTime: '09:00', comment: 'Gammel' }]) {
      const { gw } = planday({
        'GET /scheduling/v1.0/shifts/31': { data: DRAFT },
        'PUT /scheduling/v1.0/shifts/31': { data: answer },
      });
      const result = await call(gw, 'update_draft_shift', { shiftId: 31, startTime: '09:00' });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/without the expected data/);
    }
  });
});

describe('delete_draft_shift', () => {
  it('deletes a draft after reading it', async () => {
    const { gw, writes } = planday({
      'GET /scheduling/v1.0/shifts/31': { data: DRAFT },
      'DELETE /scheduling/v1.0/shifts/31': null,
    });
    const result = await call(gw, 'delete_draft_shift', { shiftId: 31 });
    expect(result.isError, text(result)).toBeUndefined();
    expect(result.structuredContent).toEqual({ deleted: true, shiftId: 31 });
    expect(writes().map(c => `${c.method} ${c.path}`)).toEqual(['DELETE /scheduling/v1.0/shifts/31']);
  });

  it('never deletes a published or worked shift', async () => {
    for (const shift of [PUBLISHED, { ...PUBLISHED, status: 'PunchclockFinished' }, { ...DRAFT, isDraft: undefined, status: 'Open' }]) {
      const { gw, writes } = planday({ 'GET /scheduling/v1.0/shifts/31': { data: shift }, 'DELETE /scheduling/v1.0/shifts/31': null });
      const result = await call(gw, 'delete_draft_shift', { shiftId: 31 });
      expect(result.isError).toBe(true);
      expect(writes()).toEqual([]);
    }
  });
});

const PUNCH = { id: 51, shiftId: 33, departmentId: 1, employeeId: 7, startDateTime: '2026-11-19T08:00', endDateTime: null, isApproved: false };
const PUNCHED = { ...PUNCH, endDateTime: '2026-11-19T16:02' };
const WORKED = { data: { id: 33, employeeId: 7, punchClockShiftId: 51, status: 'PunchclockFinished' } };

describe('approve_punch_clock', () => {
  it('approves the punched times on the timesheet and reads the record back as approved', async () => {
    const { gw, writes } = planday({
      'GET /scheduling/v1.0/shifts/33': WORKED,
      'GET /punchclock/v1.0/punchclockshifts/byShift/33': [{ turn: { data: PUNCHED } }, { turn: { data: { ...PUNCHED, isApproved: true } } }],
      'POST /timesheet/v1.0/timesheets/approve/simple': null,
    });
    const result = await call(gw, 'approve_punch_clock', { shiftId: 33 });
    expect(result.isError, text(result)).toBeUndefined();
    expect(writes().map(c => `${c.method} ${c.path}`)).toEqual(['POST /timesheet/v1.0/timesheets/approve/simple']);
    // A combined shift: the scheduled shift's id and the punch clock record's id. No note, no comment.
    expect(writes()[0]?.body).toEqual({ employeeId: 7, shiftId: 33, punchClockShiftId: 51, start: '2026-11-19T08:00', end: '2026-11-19T16:02' });
  });

  it('approves corrected times when they are given', async () => {
    const { gw, writes } = planday({
      'GET /scheduling/v1.0/shifts/33': WORKED,
      'GET /punchclock/v1.0/punchclockshifts/byShift/33': [{ turn: { data: PUNCHED } }, { turn: { data: { ...PUNCHED, isApproved: true } } }],
      'POST /timesheet/v1.0/timesheets/approve/simple': null,
    });
    const result = await call(gw, 'approve_punch_clock', { shiftId: 33, start: '2026-11-19T07:45', end: '2026-11-19T16:00' });
    expect(result.isError, text(result)).toBeUndefined();
    expect(writes()[0]?.body).toMatchObject({ start: '2026-11-19T07:45', end: '2026-11-19T16:00' });
  });

  it('refuses a record that is approved, not punched out, or would end before it starts, before anything is sent', async () => {
    for (const [record, input] of [
      [{ ...PUNCHED, isApproved: true }, {}],
      [PUNCH, {}],
      [PUNCHED, { end: '2026-11-19T07:00' }],
    ] as const) {
      const { gw, writes } = planday({ 'GET /scheduling/v1.0/shifts/33': WORKED, 'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: record } });
      const result = await call(gw, 'approve_punch_clock', { shiftId: 33, ...input });
      expect(result.isError).toBe(true);
      expect(writes()).toEqual([]);
    }
  });

  it('does not report success when the record does not read back as approved, even if the shift says Approved', async () => {
    const { gw } = planday({
      'GET /scheduling/v1.0/shifts/33': [{ turn: WORKED }, { turn: { data: { ...WORKED.data, status: 'Approved' } } }],
      'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: PUNCHED },
      'POST /timesheet/v1.0/timesheets/approve/simple': null,
    });
    const result = await call(gw, 'approve_punch_clock', { shiftId: 33 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/without the expected data/);
  });

  it('logs the shift and the approved times', () => {
    const resolved = resolvePlandayChange('approve_punch_clock', { shiftId: 33, start: '2026-11-19T07:45', end: '2026-11-19T16:00' });
    expect(resolved.ok && resolved.change.values).toEqual({ shiftId: 33, start: '2026-11-19T07:45', end: '2026-11-19T16:00' });
  });
});

describe('set_punch_out', () => {
  it('sets the punch-out on the shift’s record, with no comment and no salary note', async () => {
    const { gw, writes } = planday({
      'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: PUNCH },
      'PUT /punchclock/v1.0/punchclockshifts': { data: [{ startDateTime: '2026-11-19T08:00', endDateTime: '2026-11-19T16:30', departmentId: 1 }] },
    });
    const result = await call(gw, 'set_punch_out', { shiftId: 33, end: '2026-11-19T16:30' });
    expect(result.isError, text(result)).toBeUndefined();
    expect(writes()[0]?.body).toEqual({ punchClockShiftId: 51, employeeId: 7, departmentId: 1, endDateTime: '2026-11-19T16:30' });
    expect(result.structuredContent).toMatchObject({ punchClockRecordId: 51, endDateTime: '2026-11-19T16:30' });
  });

  it('refuses an approved record and a punch-out before the punch-in, before anything is sent', async () => {
    for (const [record, end] of [
      [{ ...PUNCH, isApproved: true }, '2026-11-19T16:30'],
      [PUNCH, '2026-11-19T07:59'],
      [PUNCH, '2026-11-19T08:00'],
    ] as const) {
      const { gw, writes } = planday({ 'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: record } });
      const result = await call(gw, 'set_punch_out', { shiftId: 33, end });
      expect(result.isError).toBe(true);
      expect(writes()).toEqual([]);
    }
  });

  it('takes only a local date and time written YYYY-MM-DDTHH:MM', async () => {
    const { gw, calls } = planday({});
    for (const end of ['2026-11-19 16:30', '2026-11-19T16:30Z', '2026-11-19T24:00', '2026-02-30T10:00', '16:30']) {
      expect((await call(gw, 'set_punch_out', { shiftId: 33, end })).isError, end).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('logs the shift and the punch-out', () => {
    const resolved = resolvePlandayChange('set_punch_out', { shiftId: 33, end: '2026-11-19T16:30' });
    expect(resolved.ok && resolved.change.values).toEqual({ shiftId: 33, end: '2026-11-19T16:30' });
  });

  it('reports a failure when the answer does not show the punch-out asked for', async () => {
    const { gw } = planday({
      'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: PUNCH },
      'PUT /punchclock/v1.0/punchclockshifts': { data: [{ startDateTime: '2026-11-19T08:00', endDateTime: '2026-11-19T17:00', departmentId: 1 }] },
    });
    expect((await call(gw, 'set_punch_out', { shiftId: 33, end: '2026-11-19T16:30' })).isError).toBe(true);
  });
});

const DRAFT_ABSENCE = {
  data: {
    absenceRequest: {
      note: null,
      absenceType: 'Absence',
      absencePeriod: { start: '2026-11-23', end: '2026-11-24' },
      registrations: [
        { date: '2026-11-23', account: { id: 61, costs: [{ value: 7.5, unit: { type: 'Hours' } }] } },
        { date: '2026-11-24', account: { id: 61, costs: [{ value: 7.5, unit: { type: 'Hours' } }] } },
      ],
    },
    accounts: [{ id: 61, name: 'Sygdom', balance: null }],
  },
};

describe('register_absence', () => {
  it('gets a draft, submits it without a note and approves it, notifying nobody and leaving shifts alone', async () => {
    const { gw, calls, writes } = planday({
      'GET /absence/v1.0/absencerequests/draft': DRAFT_ABSENCE,
      'POST /absence/v1.0/absencerequests': { id: 81, status: 'Submitted' },
      'PUT /absence/v1.0/absencerequests/81/approve': null,
    });
    const result = await call(gw, 'register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', accountId: 61 });
    expect(result.isError, text(result)).toBeUndefined();
    const query = calls[0]!.query;
    expect([query.get('employeeId'), query.get('startDate'), query.get('endDate'), query.get('accountId'), query.get('absenceType')]).toEqual([
      '7',
      '2026-11-23',
      '2026-11-24',
      '61',
      null,
    ]);
    expect(writes().map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /absence/v1.0/absencerequests',
      'PUT /absence/v1.0/absencerequests/81/approve',
    ]);
    expect(writes()[0]?.body).toEqual({
      absenceType: 'Absence',
      absencePeriod: { start: '2026-11-23', end: '2026-11-24' },
      registrations: DRAFT_ABSENCE.data.absenceRequest.registrations,
    });
    expect(writes()[1]?.body).toEqual({ notify: false, existingShifts: { action: 'NoAction' }, coverShifts: { action: 'DoNotCreate' } });
    expect(result.structuredContent).toEqual({ registered: true, requestId: 81, employeeId: 7, from: '2026-11-23', to: '2026-11-24', days: 2 });
  });

  it('needs exactly one of account and type, and a period of at most a year in order', async () => {
    const { gw, calls } = planday({});
    const base = { employeeId: 7, from: '2026-11-23', to: '2026-11-24' };
    expect((await call(gw, 'register_absence', base)).isError).toBe(true);
    expect((await call(gw, 'register_absence', { ...base, accountId: 61, absenceType: 'Absence' })).isError).toBe(true);
    expect((await call(gw, 'register_absence', { ...base, to: '2026-11-22', absenceType: 'Absence' })).isError).toBe(true);
    expect((await call(gw, 'register_absence', { ...base, to: '2027-12-01', absenceType: 'Absence' })).isError).toBe(true);
    expect((await call(gw, 'register_absence', { ...base, absenceType: 'Sick' })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('submits nothing when the draft is for another period or another account', async () => {
    for (const draft of [
      { data: { absenceRequest: { ...DRAFT_ABSENCE.data.absenceRequest, absencePeriod: { start: '2026-11-23', end: '2026-11-25' } } } },
      {
        data: {
          absenceRequest: { ...DRAFT_ABSENCE.data.absenceRequest, registrations: [{ date: '2026-11-23', account: { id: 62, costs: [] } }] },
        },
      },
    ]) {
      const { gw, writes } = planday({ 'GET /absence/v1.0/absencerequests/draft': draft });
      const result = await call(gw, 'register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', accountId: 61 });
      expect(result.isError).toBe(true);
      expect(writes()).toEqual([]);
    }
  });

  it('says which request was submitted when the approval fails', async () => {
    const { gw } = planday({
      'GET /absence/v1.0/absencerequests/draft': DRAFT_ABSENCE,
      'POST /absence/v1.0/absencerequests': { id: 81, status: 'Submitted' },
      'PUT /absence/v1.0/absencerequests/81/approve': () =>
        Response.json(
          { title: 'Forbidden', detail: 'Mette er syg' },
          { status: 403, headers: { 'x-request-id': '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b' } },
        ),
    });
    const result = await call(gw, 'register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', absenceType: 'Absence' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('request 81');
    expect(text(result)).not.toContain('Mette');
    // The approval's HTTP answer, as metadata: its status and request id, nothing of its body.
    expect(result.failure).toEqual({ httpStatus: 403, requestId: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b' });
    expect(JSON.stringify(result)).not.toContain('Mette');
  });

  it('logs the employee, the period and the type, never a note', () => {
    const resolved = resolvePlandayChange('register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', absenceType: 'Absence' });
    expect(resolved.ok && resolved.change).toMatchObject({
      action: 'register',
      record: 'absence',
      values: { employeeId: 7, from: '2026-11-23', to: '2026-11-24', absenceType: 'Absence' },
    });
  });
});

describe('approve_absence_request', () => {
  it('approves without notifying anyone and without touching shifts', async () => {
    const { gw, writes } = planday({ 'PUT /absence/v1.0/absencerequests/81/approve': null });
    const result = await call(gw, 'approve_absence_request', { requestId: 81 });
    expect(result.isError, text(result)).toBeUndefined();
    expect(writes()[0]?.body).toEqual({ notify: false, existingShifts: { action: 'NoAction' }, coverShifts: { action: 'DoNotCreate' } });
  });
});

describe('absence reads', () => {
  it('lists absence requests without the employee’s note or the accounts, which say why they are away', async () => {
    const { gw, calls } = planday({
      'GET /absence/v1.0/absencerequests': {
        data: [
          {
            id: 81,
            employeeId: 7,
            note: 'Mette er syg med influenza',
            status: 'Submitted',
            absencePeriod: { start: '2026-11-23', end: '2026-11-24' },
            requestedAccounts: [{ id: 61, name: 'Sygdom', cost: [{ value: 2, unit: { type: 'Days' } }] }],
          },
        ],
        paging: { offset: 0, limit: 40, total: 1 },
      },
    });
    const result = await call(gw, 'list_absence_requests', { statuses: ['Submitted', 'Approved'], employeeId: 7 });
    expect(result.isError, text(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/influenza|note|Sygdom|requestedAccounts|"id":61/);
    expect(result.structuredContent).toMatchObject({ requests: [{ id: 81, employeeId: 7, status: 'Submitted' }] });
    expect(calls[0]?.query.getAll('status')).toEqual(['Submitted', 'Approved']);
  });

  it('lists an employee’s absence accounts without salary codes', async () => {
    const { gw } = planday({
      'GET /absence/v1.0/accounts': {
        data: [{ id: 61, employeeId: 7, typeId: 2, status: 'Active', name: 'Sygdom', salaryCodeCompanyPaid: 'SC-1234' }],
        paging: { offset: 0, limit: 50, total: 1 },
      },
    });
    const result = await call(gw, 'list_absence_accounts', { employeeId: 7 });
    expect(result.isError, text(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SC-1234|salaryCode/);
  });

  it('refuses accounts of another employee than the one asked for', async () => {
    const { gw } = planday({
      'GET /absence/v1.0/accounts': { data: [{ id: 61, employeeId: 8, name: 'Sygdom' }], paging: { offset: 0, limit: 50, total: 1 } },
    });
    expect((await call(gw, 'list_absence_accounts', { employeeId: 7 })).isError).toBe(true);
  });
});

describe('audit', () => {
  it('records the ids, dates and times of the new changes, never a comment', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw } = planday(
      {
        'PUT /absence/v1.0/absencerequests/81/approve': null,
        'GET /absence/v1.0/absencerequests/draft': DRAFT_ABSENCE,
        'POST /absence/v1.0/absencerequests': { id: 82, status: 'Submitted' },
        'PUT /absence/v1.0/absencerequests/82/approve': null,
        'GET /punchclock/v1.0/punchclockshifts/byShift/33': { data: PUNCH },
        'PUT /punchclock/v1.0/punchclockshifts': { data: [{ startDateTime: '2026-11-19T08:00', endDateTime: '2026-11-19T16:30', departmentId: 1 }] },
      },
      { enableWrites: true, audit: (record: Record<string, unknown>) => void records.push({ ...record }) },
    );
    await call(gw, 'approve_absence_request', { requestId: 81 });
    await call(gw, 'register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', accountId: 61 });
    await call(gw, 'set_punch_out', { shiftId: 33, end: '2026-11-19T16:30' });
    const starts = records.filter(r => r.action === 'start').map(r => r.target);
    expect(starts).toEqual([
      { requestId: 81 },
      { employeeId: 7, from: '2026-11-23', to: '2026-11-24', accountId: 61 },
      { shiftId: 33, end: '2026-11-19T16:30' },
    ]);
  });
});

describe('writes stay off without the host turning them on', () => {
  it('refuses every new write when writes are not enabled', async () => {
    const { gw, calls } = planday({}, {});
    for (const [tool, input] of [
      ['update_draft_shift', { shiftId: 31, startTime: '09:00' }],
      ['delete_draft_shift', { shiftId: 31 }],
      ['approve_punch_clock', { shiftId: 33 }],
      ['set_punch_out', { shiftId: 33, end: '2026-11-19T16:30' }],
      ['register_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', absenceType: 'Absence' }],
      ['approve_absence_request', { requestId: 81 }],
    ] as const) {
      expect((await call(gw, tool, input as GatewayJsonObject)).isError, tool).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
