// Planday-specific behaviour, against answers shaped as the Planday Open API documents them (the OpenAPI documents
// at https://openapi.planday.com/{hr,scheduling,punchclock}/swagger/v1.0/swagger.json: `{ data, paging }`, int64
// ids, the CreateShiftOutputModel). These are recorded from the documentation, not from a live portal: no Planday
// account was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlandayGateway, plandayToolCatalog, resolvePlandayChange, type GatewayJsonObject } from '../src/gateway.js';
import { REDACTION_MARKER } from '../src/errors.js';
import { fixedOutputs, RESULT_WITHHELD } from '../src/fallbacks.js';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';
import { CLIENT_ID, SHIFT_CREATED, TOKEN_URL, withToken } from './helpers.js';

const TOKEN = 'tttt-gggg-wwww-vvvv-1';
// Pseudonym keys: 32 or more random printable characters that share no piece with any text of ours.
const PSEUDONYM_KEY_1 = 'Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm1Fs5Jd0Ga'; // gitleaks:allow (a test value, not a key)
const PSEUDONYM_KEY_2 = 'Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe'; // gitleaks:allow (a test value, not a key)
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('PLANDAY_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: URL, init: RequestInit) => unknown;
type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

/** A Planday stand-in: routes by "METHOD /path". An unknown route answers 404. The token endpoint is answered by withToken. */
function planday(routes: Record<string, Handler | unknown>, policy: Record<string, unknown> = { enableWrites: true }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.pathname}`];
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
  return { gw, calls, fetchImpl };
}

const call = (gw: ReturnType<typeof planday>['gw'], tool: string, input: GatewayJsonObject = {}) => gw.callTool(tool, input);
const PAGING = { offset: 0, limit: 50, total: 1 };
const SHIFT_INPUT = { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00' };

/** An employee as the HR document shows one, with the special fields a portal can return when asked for them. */
const EMPLOYEE = {
  id: 7,
  firstName: 'Mette',
  lastName: 'Testesen',
  email: 'mette@example.test',
  cellPhone: '12345678',
  primaryDepartmentId: 1,
  departments: [1],
  employeeGroups: [2],
  hiredDate: '2024-01-01',
  ssn: '010190-1234',
  bankAccount: { registrationNumber: '1234', accountNumber: '0001234567' },
  birthDate: '1990-01-01',
  salaryIdentifier: 'S-77',
  street1: 'Testvej 1',
  gender: 'Female',
};

describe('reads', () => {
  it('lists employees without asking for the special fields, and leaves them out if they come anyway', async () => {
    const { gw, calls } = planday({ 'GET /hr/v1.0/employees': { data: [EMPLOYEE], paging: PAGING } });
    const result = await call(gw, 'list_employees', { search: 'Mette' });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.query.get('searchQuery')).toBe('Mette');
    expect(calls[0]?.query.has('special')).toBe(false);
    const text = JSON.stringify(result);
    for (const value of ['010190', '0001234567', '1990-01-01', 'S-77', 'Testvej', 'Female', 'ssn', 'bankAccount', 'salaryIdentifier']) {
      expect(text).not.toContain(value);
    }
    expect(result.structuredContent).toMatchObject({ employees: [{ id: 7, firstName: 'Mette', email: 'mette@example.test' }], paging: PAGING });
  });

  it('refuses a search with digits, since Planday also matches it against CPR and salary identifiers', async () => {
    const { gw, calls } = planday({});
    for (const search of ['010190', 'Mette 12', '1234']) {
      expect((await call(gw, 'list_employees', { search })).isError, search).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('gets one employee and refuses an answer about another', async () => {
    const ok = planday({ 'GET /hr/v1.0/employees/7': { data: EMPLOYEE } });
    expect((await call(ok.gw, 'get_employee', { employeeId: 7 })).structuredContent).toMatchObject({ id: 7, firstName: 'Mette' });
    const other = planday({ 'GET /hr/v1.0/employees/7': { data: { ...EMPLOYEE, id: 8 } } });
    expect((await call(other.gw, 'get_employee', { employeeId: 7 })).isError).toBe(true);
  });

  it('lists shifts for at most 62 days with the documented filters, and leaves the wage out', async () => {
    const shift = { ...SHIFT_CREATED, status: 'Assigned', employeeId: 7, defaultWage: { rate: 180, type: 'Hourly' } };
    const { gw, calls } = planday({ 'GET /scheduling/v1.0/shifts': { data: [shift], paging: PAGING } });
    const result = await call(gw, 'list_shifts', { from: '2026-11-01', to: '2026-11-30', departmentId: 1, status: 'Assigned' });
    expect(result.isError).toBeUndefined();
    expect(Object.fromEntries(calls[0]!.query)).toMatchObject({ from: '2026-11-01', to: '2026-11-30', departmentId: '1', shiftStatus: 'Assigned' });
    expect(JSON.stringify(result)).not.toMatch(/defaultWage|180/);
    for (const input of [
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-11-30', to: '2026-11-01' },
      { from: '2026-02-30', to: '2026-03-01' },
    ]) {
      expect((await call(gw, 'list_shifts', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('refuses a shift with a status outside the documented list, and a list entry without an id', async () => {
    for (const data of [[{ ...SHIFT_CREATED, status: 'Paid' }], [{ ...SHIFT_CREATED }, { date: '2026-11-20' }]]) {
      const { gw } = planday({ 'GET /scheduling/v1.0/shifts': { data, paging: PAGING } });
      expect((await call(gw, 'list_shifts', { from: '2026-11-01', to: '2026-11-30' })).isError, JSON.stringify(data)).toBe(true);
    }
  });

  it('leaves pay fields out of shift types and revenue fields out of positions', async () => {
    const { gw } = planday({
      'GET /scheduling/v1.0/shifttypes': {
        data: [{ id: 3, name: 'Aften', isActive: true, salaryCode: 'L-9', payPercentage: 25, payMonetary: 40, paymentType: 'Percentage' }],
        paging: PAGING,
      },
      'GET /scheduling/v1.0/positions': { data: [{ id: 4, name: 'Bar', isActive: true, revenueUnitId: 9 }], paging: PAGING },
    });
    const types = JSON.stringify(await call(gw, 'list_shift_types', {}));
    expect(types).toContain('Aften');
    expect(types).not.toMatch(/salaryCode|L-9|payPercentage|payMonetary|paymentType/);
    expect(JSON.stringify(await call(gw, 'list_positions', {}))).not.toContain('revenue');
  });

  it('sends the departments of shift requests as the parameter repeated', async () => {
    const { gw, calls } = planday({
      'GET /scheduling/v1.0/shifts/requests': {
        data: [{ shiftId: 5, departmentId: 1, requesters: [{ employeeId: 7, shiftRequestId: 9 }] }],
        paging: PAGING,
      },
    });
    const result = await call(gw, 'list_shift_requests', { departmentIds: [1, 2] });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.query.getAll('departmentId')).toEqual(['1', '2']);
  });

  it('asks for punch clock records over whole days', async () => {
    const { gw, calls } = planday({
      'GET /punchclock/v1.0/punchclockshifts': {
        data: [{ id: 11, departmentId: 1, employeeId: 7, startDateTime: '2026-11-20T08:01:00', isApproved: false }],
        paging: PAGING,
      },
    });
    expect((await call(gw, 'list_punch_clock_records', { from: '2026-11-01', to: '2026-11-30' })).isError).toBeUndefined();
    expect(calls[0]?.query.get('from')).toBe('2026-11-01T00:00:00Z');
    expect(calls[0]?.query.get('to')).toBe('2026-11-30T23:59:59Z');
  });
});

describe('writes', () => {
  it('are refused unless the host enables them, with nothing sent', async () => {
    const { gw, calls } = planday({}, {});
    for (const [tool, input] of [
      ['create_shift', SHIFT_INPUT],
      ['assign_shift', { shiftId: 5, employeeId: 7 }],
      ['approve_shift_request', { shiftId: 5, employeeId: 7 }],
    ] as Array<[string, GatewayJsonObject]>) {
      expect((await call(gw, tool, input)).isError, tool).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('creates a shift as a draft, without conflicts, with the break rules, and without a wage', async () => {
    const { gw, calls } = planday({ 'POST /scheduling/v1.0/shifts': { data: SHIFT_CREATED } });
    const result = await call(gw, 'create_shift', { ...SHIFT_INPUT, comment: 'Ekstra vagt' });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ allowConflicts: false, useBreaks: true, isDraft: true, ...SHIFT_INPUT, comment: 'Ekstra vagt' });
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/wage/i);
  });

  it('reports a shift as created only when the answer is that shift, as a draft', async () => {
    for (const answer of [
      { ...SHIFT_CREATED, isDraft: false },
      { ...SHIFT_CREATED, isDraft: undefined },
      { ...SHIFT_CREATED, date: '2026-11-21' },
      { ...SHIFT_CREATED, startTime: '09:00' },
      { ...SHIFT_CREATED, endTime: null },
      { ...SHIFT_CREATED, departmentId: 9 },
      { ...SHIFT_CREATED, employeeGroupId: 9 },
      { ...SHIFT_CREATED, employeeId: 7 },
    ]) {
      const { gw } = planday({ 'POST /scheduling/v1.0/shifts': { data: answer } });
      expect((await call(gw, 'create_shift', SHIFT_INPUT)).isError, JSON.stringify(answer)).toBe(true);
    }
    // Times written with seconds are the same times.
    const { gw } = planday({ 'POST /scheduling/v1.0/shifts': { data: { ...SHIFT_CREATED, startTime: '08:00:00', endTime: '16:00:00' } } });
    expect((await call(gw, 'create_shift', SHIFT_INPUT)).isError).toBeUndefined();
  });

  it('refuses a shift without length and an invalid time before anything is sent', async () => {
    const { gw, calls } = planday({});
    for (const input of [
      { ...SHIFT_INPUT, endTime: '08:00' },
      { ...SHIFT_INPUT, startTime: '24:00' },
      { ...SHIFT_INPUT, date: '2026-02-30' },
      { ...SHIFT_INPUT, wage: 200 },
      { ...SHIFT_INPUT, allowConflicts: true },
    ]) {
      expect((await call(gw, 'create_shift', input as GatewayJsonObject)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('assigns a shift and reads it back; an answer without the assignment is a failure', async () => {
    let employeeId: number | null = null;
    const { gw, calls } = planday({
      'POST /scheduling/v1.0/shifts/5/employee': (_url: URL, init: RequestInit) => {
        employeeId = (JSON.parse(String(init.body)) as { employeeId: number | null }).employeeId;
        return null;
      },
      'GET /scheduling/v1.0/shifts/5': () => ({ data: { ...SHIFT_CREATED, id: 5, employeeId } }),
    });
    expect((await call(gw, 'assign_shift', { shiftId: 5, employeeId: 7 })).isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /scheduling/v1.0/shifts/5/employee', 'GET /scheduling/v1.0/shifts/5']);
    expect(calls[0]?.body).toEqual({ employeeId: 7 });
    expect((await call(gw, 'assign_shift', { shiftId: 5, employeeId: null })).isError).toBeUndefined();

    const stale = planday({
      'POST /scheduling/v1.0/shifts/5/employee': null,
      'GET /scheduling/v1.0/shifts/5': { data: { ...SHIFT_CREATED, id: 5, employeeId: 8 } },
    });
    expect((await call(stale.gw, 'assign_shift', { shiftId: 5, employeeId: 7 })).isError).toBe(true);
  });

  it('approves a shift request without notifying anyone, and reads the shift back', async () => {
    const { gw, calls } = planday({
      'POST /scheduling/v1.0/shifts/5/requests/7/approve': null,
      'GET /scheduling/v1.0/shifts/5': { data: { ...SHIFT_CREATED, id: 5, employeeId: 7 } },
    });
    expect((await call(gw, 'approve_shift_request', { shiftId: 5, employeeId: 7 })).isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ notifyBySms: false, notifyByMessage: false });

    const other = planday({
      'POST /scheduling/v1.0/shifts/5/requests/7/approve': null,
      'GET /scheduling/v1.0/shifts/5': { data: { ...SHIFT_CREATED, id: 5, employeeId: null } },
    });
    expect((await call(other.gw, 'approve_shift_request', { shiftId: 5, employeeId: 7 })).isError).toBe(true);
  });

  it('reports a refusal from Planday with our own text, never its body', async () => {
    const { gw } = planday({
      'POST /scheduling/v1.0/shifts': () => Response.json({ title: 'Conflict', detail: 'Mette Testesen is already on a shift' }, { status: 409 }),
    });
    const result = await call(gw, 'create_shift', SHIFT_INPUT);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Mette|already/);
    expect(JSON.stringify(result)).toContain('409');
  });

  it('declares only the writes the client allows', () => {
    const writes = plandayToolCatalog.flatMap(entry => entry.upstream.filter(op => op.access === 'write'));
    expect(writes.map(op => `${op.method} ${op.path}`).sort()).toEqual([
      'POST /scheduling/v1.0/shifts',
      'POST /scheduling/v1.0/shifts/{shiftId}/employee',
      'POST /scheduling/v1.0/shifts/{shiftId}/requests/{employeeId}/approve',
    ]);
  });
});

describe('change resolution and audit', () => {
  it('resolves what a write changes, with ids, the date and the times, never the comment', () => {
    const created = resolvePlandayChange('create_shift', { ...SHIFT_INPUT, comment: 'Mette er syg' });
    expect(created.ok && created.change).toMatchObject({
      tool: 'create_shift',
      action: 'create',
      record: 'shift',
      movesMoney: false,
      values: { ...SHIFT_INPUT },
    });
    expect(JSON.stringify(created)).not.toContain('Mette');
    expect(resolvePlandayChange('get_employee', { employeeId: 7 }).ok).toBe(false);
    expect(resolvePlandayChange('create_shift', { ...SHIFT_INPUT, endTime: '08:00' }).ok).toBe(false);
  });

  it('logs ids and dates, never a search, a comment, the caller or the request id in clear', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw } = planday(
      {
        'GET /hr/v1.0/employees': { data: [], paging: PAGING },
        'POST /scheduling/v1.0/shifts': { data: SHIFT_CREATED },
      },
      { enableWrites: true, audit: (record: Record<string, unknown>) => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY_1 }, // gitleaks:allow (a test constant, not a key)
    );
    await gw.callTool('list_employees', { search: 'Mette Testesen' }, { caller: 'mette@example.test', requestId: 'Mette-Testesen' });
    await gw.callTool('create_shift', { ...SHIFT_INPUT, comment: 'Mette er syg' }, { caller: 'mette@example.test' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/Mette|Testesen|syg/);
    expect(records.find(r => r.tool === 'planday_create_shift')?.target).toEqual(SHIFT_INPUT);
    expect(records[0]?.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records[0]?.requestId).toMatch(/^hmac:[0-9a-f]{16}$/);
  });
});

describe('the pseudonym key anywhere', () => {
  /** Every piece of six characters of a key (the redactor's fragment length). */
  const pieces = (key: string) => Array.from({ length: Math.max(0, key.length - 5) }, (_, i) => key.slice(i, i + 6));
  /** The pieces of any form of the key found in any of the values, raw or serialised. */
  const leaked = (forms: string[], values: unknown[]) => {
    const texts = values.map(value => (typeof value === 'string' ? value : JSON.stringify(value) ?? ''));
    return forms.flatMap(pieces).filter(piece => texts.some(text => text.includes(piece)));
  };
  const formsOf = (key: string | Uint8Array) =>
    typeof key === 'string' ? [key] : ['hex', 'base64', 'base64url', 'latin1'].map(form => Buffer.from(key).toString(form as BufferEncoding));
  const construct = (options: Record<string, unknown>): Error | undefined => {
    try {
      createPlandayGateway(options as never);
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  const OWN_TEXTS = [
    ...FIXED_CORPUS.filter(text => text.length >= 32),
    `${RESULT_WITHHELD}${REDACTION_MARKER}`,
    `policy.enableWrites must be a boolean ${'z'.repeat(10)}`,
    `PLANDAY_REFRESH_TOKEN-${'7'.repeat(12)}`,
  ];
  const BROKEN: Array<Record<string, unknown>> = [
    {},
    { baseUrl: 'not a url' },
    { baseUrl: 'https://elsewhere.invalid' },
    { refreshToken: 'short' },
    { clientId: '' },
    { policy: { enableWrites: 'yes' } },
    { policy: { disabledTools: ['no_such_tool'] } },
  ];
  const base = { clientId: CLIENT_ID, refreshToken: TOKEN };

  it('refuses a pseudonym key that shares text with ours, and no construction error shows a piece of it', () => {
    let checked = 0;
    for (const text of OWN_TEXTS) {
      for (const key of [text, new TextEncoder().encode(text)]) {
        for (const broken of BROKEN) {
          const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
          const error = construct({ ...base, ...rest, policy: { ...brokenPolicy, pseudonymKey: key } });
          expect(error, text).toBeInstanceOf(Error);
          expect(leaked(formsOf(key), [error!.message, error!.stack, error!.name, error]), text).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps an admitted pseudonym key out of construction errors, the tool list and every fixed output', () => {
    for (const key of [PSEUDONYM_KEY_2, Buffer.from('a7f3c91e5b2d8046f1e9c3a7b5d20864d18b6e2f4a9c07e35b1d8f62c4a09e17', 'hex')]) {
      for (const broken of BROKEN.slice(1)) {
        const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
        const error = construct({ ...base, ...rest, policy: { ...brokenPolicy, pseudonymKey: key } });
        expect(error).toBeInstanceOf(Error);
        expect(leaked(formsOf(key), [error!.message, error!.stack, error])).toEqual([]);
      }
      const gw = createPlandayGateway({ ...base, policy: { pseudonymKey: key } });
      expect(leaked(formsOf(key), [gw.tools, plandayToolCatalog, fixedOutputs()])).toEqual([]);
    }
  });

  it('refuses a pseudonym key that is too short, as text or bytes', () => {
    for (const key of ['Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm', new Uint8Array(31)]) {
      expect(construct({ ...base, policy: { pseudonymKey: key } })?.message).toMatch(/pseudonymKey/);
    }
  });

  it('keeps an admitted pseudonym key out of results, errors and audit records wherever Planday or the host puts it', async () => {
    const key = PSEUDONYM_KEY_1; // gitleaks:allow (a test constant, not a key)
    const records: unknown[] = [];
    const gw = createPlandayGateway({
      ...base,
      maxAttempts: 1,
      fetchImpl: withToken(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/employees/1')) return Response.json({ data: { id: 1, firstName: key, lastName: key.slice(3, 20), jobTitle: `x${key}x` } });
        if (path.endsWith('/employees/2')) return Response.json({ title: key, detail: key }, { status: 400 });
        if (path.endsWith('/employees/3')) return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${key}` } });
        throw new TypeError(`fetch failed ${key}`);
      }),
      policy: { audit: record => void records.push(record), pseudonymKey: key },
    });
    const results = [];
    for (const employeeId of [1, 2, 3, 4]) {
      results.push(await gw.callTool('get_employee', { employeeId }, { caller: key, requestId: key }));
    }
    results.push(await gw.callTool(`get_${key}`, { [key]: key }, { caller: key }));
    results.push(await gw.callTool('get_employee', { employeeId: 1, [key]: 1 }));
    results.push(await gw.callTool('list_employees', { search: key.replace(/\d/g, '') }));
    expect(results[0]?.isError).toBeUndefined();
    expect(leaked([key], [results, records])).toEqual([]);
  });
});

describe('after review 1', () => {
  it('takes 62 days with both dates included, and refuses 63', async () => {
    const { gw, calls } = planday({
      'GET /scheduling/v1.0/shifts': { data: [], paging: PAGING },
      'GET /punchclock/v1.0/punchclockshifts': { data: [], paging: PAGING },
    });
    // 2026-11-01 to 2027-01-01 is 62 days; to 2027-01-02 is 63.
    for (const tool of ['list_shifts', 'list_punch_clock_records']) {
      expect((await call(gw, tool, { from: '2026-11-01', to: '2027-01-01' })).isError, tool).toBeUndefined();
      expect((await call(gw, tool, { from: '2026-11-01', to: '2027-01-02' })).isError, tool).toBe(true);
      expect((await call(gw, tool, { from: '2026-11-01', to: '2026-11-01' })).isError, tool).toBeUndefined();
    }
    expect(calls).toHaveLength(4);
  });

  it('catches a rejected promise from an asynchronous onRefreshToken, and keeps using the new token', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ROTATED = 'refresh-token-rotated-4242'; // gitleaks:allow (a test value, not a token)
      let tokenCalls = 0;
      const bodies: string[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === TOKEN_URL) {
          tokenCalls += 1;
          bodies.push(String(init?.body));
          return Response.json({ access_token: `access-token-${tokenCalls}-0000000000`, expires_in: 3600, refresh_token: ROTATED });
        }
        return Response.json({ data: [], paging: PAGING });
      }) as typeof fetch;
      let now = 1_000_000;
      const gw = createPlandayGateway({
        clientId: CLIENT_ID,
        refreshToken: TOKEN,
        fetchImpl,
        now: () => now,
        onRefreshToken: async () => {
          throw new Error('host store down');
        },
      });
      expect((await call(gw, 'list_departments', {})).isError).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 20));
      now += 3_600_000;
      expect((await call(gw, 'list_departments', {})).isError).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(new URLSearchParams(bodies[1]).get('refresh_token')).toBe(ROTATED);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a pseudonym key that is not valid UTF-16, with the sealed refusal and no piece of it', () => {
    const pieces = (key: string) => Array.from({ length: key.length - 5 }, (_, i) => key.slice(i, i + 6));
    for (const key of [`Qh7Vz2Lr9Xw4Nc8T\uD800p3Yk6Bm1Fs5Jd0Ga`, `\uDC00Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe`, `Zr8qLw2Xv7NcT4pK9mYb3HsD6fJgQ1aE\uDBFF`]) {
      for (const broken of [{}, { baseUrl: 'not a url' }, { refreshToken: 'short' }]) {
        let caught: Error | undefined;
        try {
          createPlandayGateway({ clientId: CLIENT_ID, refreshToken: TOKEN, ...broken, policy: { pseudonymKey: key } } as never);
        } catch (error) {
          caught = error as Error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.name).toBe('ConfigError');
        expect(String(caught!.stack)).toBe(`${caught!.name}: ${caught!.message}`);
        const text = [caught!.message, caught!.stack, JSON.stringify(caught)].join(' ');
        for (const piece of pieces(key)) expect(text, piece).not.toContain(piece);
      }
    }
  });
});
