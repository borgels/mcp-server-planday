import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACT_AS_TEXTS, plandayToolCatalog, resolvePlandayChange } from '../src/gateway.js';
import { testGateway, texts } from './helpers.js';

/**
 * Acting as the person (src/act-as.ts): the self-service tools find the person's own employee by the work e-mail in
 * the host's actAs, and touch nobody else. A change is never made without them.
 */

const ME = 'Mette@Example.com';
const MY_ID = 21;

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

function employees(rows: Array<Record<string, unknown>>): Route {
  return url =>
    url.pathname === '/hr/v1.0/employees'
      ? Response.json({ data: rows, paging: { offset: 0, limit: 50, total: rows.length } })
      : undefined;
}

const DRAFT: Route = url =>
  url.pathname === '/absence/v1.0/absencerequests/draft'
    ? Response.json({
        data: {
          absenceRequest: {
            absenceType: 'Vacation',
            absencePeriod: { start: url.searchParams.get('startDate'), end: url.searchParams.get('endDate') },
            registrations: [{ date: url.searchParams.get('startDate'), account: { id: 61 } }],
          },
        },
      })
    : undefined;

/** The person's own accounts: 61 (on the first page) and 63 (on the second). */
const ACCOUNTS: Route = url =>
  url.pathname === '/absence/v1.0/accounts' && url.searchParams.get('employeeId') === String(MY_ID)
    ? Response.json({
        data: url.searchParams.get('Offset') === '0' ? [{ id: 61, employeeId: MY_ID }] : [{ id: 63, employeeId: MY_ID }],
        paging: { offset: Number(url.searchParams.get('Offset')), limit: 1, total: 2 },
      })
    : undefined;

function setup(routes: Route[], policy: Record<string, unknown> = {}) {
  const records: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    for (const route of routes) {
      const answer = route(url, init);
      if (answer) return answer;
    }
    if ((init?.method ?? 'GET') === 'POST' && url.pathname === '/absence/v1.0/absencerequests') {
      return Response.json({ id: 41, status: 'Submitted' });
    }
    return new Response(JSON.stringify({ message: 'no stub' }), { status: 404 });
  });
  const gw = testGateway({
    accessToken: 'tttt-gggg-wwww-vvvv-1',
    fetchImpl,
    policy: { enableWrites: true, audit: (record: Record<string, unknown>) => void records.push({ ...record }), ...policy },
  });
  const requests = () =>
    (fetchImpl.mock.calls as unknown as Array<[string, RequestInit | undefined]>).map(([url, init]) => ({
      method: init?.method ?? 'GET',
      url: new URL(url),
    }));
  return { gw, fetchImpl, records, requests };
}

afterEach(() => vi.restoreAllMocks());

describe('the catalog', () => {
  it('marks exactly the self-service tools as self, with a change spec for the write', () => {
    expect(plandayToolCatalog.filter(entry => entry.self).map(entry => [entry.name, entry.riskLevel])).toEqual([
      ['list_my_shifts', 'read'],
      ['list_my_absence_requests', 'read'],
      ['request_my_absence', 'write'],
    ]);
    for (const entry of plandayToolCatalog.filter(e => e.self)) {
      expect(Object.keys(entry.inputSchema.properties as object)).not.toContain('employeeId');
      expect(entry.inputSchema.additionalProperties).toBe(false);
    }
    const request = plandayToolCatalog.find(entry => entry.name === 'request_my_absence')!;
    expect(request.change).toEqual({
      action: 'request',
      record: 'absence',
      movesMoney: false,
      logFields: [
        { name: 'from', type: 'date' },
        { name: 'to', type: 'date' },
        { name: 'accountId', type: 'recordId' },
        { name: 'absenceType', type: 'kind' },
      ],
    });
    // Never an approval.
    expect(request.upstream.map(op => `${op.method} ${op.path}`)).not.toContain('PUT /absence/v1.0/absencerequests/{requestId}/approve');
  });

  it('resolves what request_my_absence changes, without a person', () => {
    const resolved = resolvePlandayChange('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' });
    expect(resolved).toEqual({
      ok: true,
      change: {
        tool: 'request_my_absence',
        action: 'request',
        record: 'absence',
        movesMoney: false,
        requiresConfirmation: false,
        values: { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' },
      },
    });
    expect(resolvePlandayChange('request_my_absence', { employeeId: 7, from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }).ok).toBe(
      false,
    );
  });
});

describe('finding the person', () => {
  it('matches the work e-mail exactly, ignoring case, and sends it only as the search', async () => {
    const { gw, requests, records } = setup([
      employees([
        { id: 20, email: 'mette@example.com.other' },
        { id: MY_ID, email: 'mette@example.com' },
      ]),
      url =>
        url.pathname === '/scheduling/v1.0/shifts'
          ? Response.json({ data: [{ id: 31, employeeId: MY_ID }], paging: { offset: 0, limit: 50, total: 1 } })
          : undefined,
    ]);
    const result = await gw.callTool('list_my_shifts', { from: '2026-11-01', to: '2026-11-30' }, { caller: 'p1', actAs: { email: ME } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ shifts: [{ id: 31, employeeId: MY_ID }] });
    const [lookup, shifts] = requests();
    expect(lookup!.url.pathname).toBe('/hr/v1.0/employees');
    expect(lookup!.url.searchParams.get('searchQuery')).toBe('mette@example.com');
    expect(shifts!.url.searchParams.get('employeeId')).toBe(String(MY_ID));
    // The e-mail is in no audit record and in no text of ours.
    expect(JSON.stringify(records).toLowerCase()).not.toContain('mette@');
    expect(texts(result).join(' ').toLowerCase()).not.toContain('mette@');
  });

  it.each([
    ['no employee', []],
    ['two employees', [{ id: 1, email: 'mette@example.com' }, { id: 2, email: 'METTE@example.com' }]],
    ['a deactivated employee', [{ id: 1, email: 'mette@example.com', isDeactivated: true }]],
    ['a similar address only', [{ id: 1, email: 'mette@example.co' }]],
  ])('refuses with no_user for %s, and sends nothing else', async (_what, rows) => {
    const { gw, requests } = setup([employees(rows), DRAFT]);
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, { actAs: { email: ME } });
    expect(result).toMatchObject({ isError: true, actAsRefused: 'no_user' });
    expect(texts(result)).toEqual([ACT_AS_TEXTS.no_user]);
    expect(requests().map(r => r.url.pathname)).toEqual(['/hr/v1.0/employees']);
  });

  it('reads every page before deciding', async () => {
    const pages: Route = url =>
      url.pathname === '/hr/v1.0/employees'
        ? Response.json({
            data: url.searchParams.get('offset') === '0' ? [{ id: 1, email: 'other@example.com' }] : [{ id: 1 + MY_ID, email: 'mette@example.com' }],
            paging: { offset: Number(url.searchParams.get('offset')), limit: 50, total: 2 },
          })
        : undefined;
    const { gw, requests } = setup([pages, url => (url.pathname.endsWith('/absencerequests') ? Response.json({ data: [], paging: { offset: 0, limit: 40, total: 0 } }) : undefined)]);
    const result = await gw.callTool('list_my_absence_requests', {}, { actAs: { email: ME } });
    expect(result.isError).toBeUndefined();
    expect(requests().filter(r => r.url.pathname === '/hr/v1.0/employees')).toHaveLength(2);
    expect(requests().at(-1)!.url.searchParams.get('employeeId')).toBe(String(1 + MY_ID));
  });
});

describe('without a person', () => {
  it.each([
    ['no context', undefined],
    ['no actAs', { caller: 'p1' }],
  ])('refuses a self-service tool with invalid (%s), and sends nothing', async (_what, context) => {
    const { gw, fetchImpl } = setup([]);
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, context as never);
    expect(result).toMatchObject({ isError: true, actAsRefused: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, 'mette@example.com', { email: 'not an address' }, { email: ME, name: 7 }])('refuses a malformed actAs (%j) for any tool', async actAs => {
    const { gw, fetchImpl } = setup([]);
    const result = await gw.callTool('list_departments', {}, { actAs } as never);
    expect(result).toMatchObject({ isError: true, actAsRefused: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs a company-wide tool as before, ignoring a valid actAs', async () => {
    const { gw, requests } = setup([
      url => (url.pathname === '/hr/v1.0/departments' ? Response.json({ data: [{ id: 1 }], paging: { offset: 0, limit: 50, total: 1 } }) : undefined),
    ]);
    const result = await gw.callTool('list_departments', {}, { actAs: { email: ME } });
    expect(result.isError).toBeUndefined();
    expect(requests().map(r => r.url.pathname)).toEqual(['/hr/v1.0/departments']);
  });
});

describe('only the own employee', () => {
  it('list_my_shifts refuses an answer with a colleague’s shift', async () => {
    const { gw } = setup([
      employees([{ id: MY_ID, email: 'mette@example.com' }]),
      url =>
        url.pathname === '/scheduling/v1.0/shifts'
          ? Response.json({ data: [{ id: 31, employeeId: MY_ID }, { id: 32, employeeId: 99 }], paging: { offset: 0, limit: 50, total: 2 } })
          : undefined,
    ]);
    const result = await gw.callTool('list_my_shifts', { from: '2026-11-01', to: '2026-11-30' }, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"id":32');
  });

  it('list_my_absence_requests refuses an answer with a colleague’s request', async () => {
    const { gw } = setup([
      employees([{ id: MY_ID, email: 'mette@example.com' }]),
      url =>
        url.pathname === '/absence/v1.0/absencerequests'
          ? Response.json({ data: [{ id: 41, employeeId: 99 }], paging: { offset: 0, limit: 40, total: 1 } })
          : undefined,
    ]);
    const result = await gw.callTool('list_my_absence_requests', {}, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
  });

  it('refuses an employee id in the input', async () => {
    const { gw, fetchImpl } = setup([]);
    const result = await gw.callTool('list_my_shifts', { from: '2026-11-01', to: '2026-11-30', employeeId: 99 }, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('request_my_absence', () => {
  it('submits the draft for the own employee and never approves it', async () => {
    const { gw, requests, records } = setup([employees([{ id: MY_ID, email: 'mette@example.com' }]), ACCOUNTS, DRAFT]);
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, { actAs: { email: ME } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ requested: true, requestId: 41, status: 'Submitted' });
    const made = requests();
    const draft = made.find(r => r.url.pathname.endsWith('/draft'))!;
    expect(draft.url.searchParams.get('employeeId')).toBe(String(MY_ID));
    expect(made.map(r => r.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'POST']);
    expect(made.some(r => r.method === 'PUT')).toBe(false);
    expect(JSON.stringify(records).toLowerCase()).not.toContain('mette@');
  });

  it('sends nothing when the draft for a type holds an account that is not the person’s', async () => {
    const foreign: Route = url =>
      url.pathname === '/absence/v1.0/absencerequests/draft'
        ? Response.json({
            data: {
              absenceRequest: {
                absenceType: 'Vacation',
                absencePeriod: { start: '2026-11-23', end: '2026-11-24' },
                registrations: [{ date: '2026-11-23', account: { id: 61 } }, { date: '2026-11-24', account: { id: 99 } }],
              },
            },
          })
        : undefined;
    const { gw, requests } = setup([employees([{ id: MY_ID, email: 'mette@example.com' }]), ACCOUNTS, foreign]);
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
    expect(requests().filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('refuses an account list that holds a colleague’s account', async () => {
    const mixed: Route = url =>
      url.pathname === '/absence/v1.0/accounts'
        ? Response.json({ data: [{ id: 61, employeeId: MY_ID }, { id: 62, employeeId: 99 }], paging: { offset: 0, limit: 50, total: 2 } })
        : undefined;
    const { gw, requests } = setup([employees([{ id: MY_ID, email: 'mette@example.com' }]), mixed, DRAFT]);
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
    expect(requests().filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('takes only one of the person’s own absence accounts, from any page', async () => {
    const draftFor = (id: number): Route => url =>
      url.pathname === '/absence/v1.0/absencerequests/draft'
        ? Response.json({
            data: {
              absenceRequest: {
                absencePeriod: { start: '2026-11-23', end: '2026-11-24' },
                registrations: [{ date: '2026-11-23', account: { id } }],
              },
            },
          })
        : undefined;
    const { gw, requests } = setup([employees([{ id: MY_ID, email: 'mette@example.com' }]), ACCOUNTS, draftFor(63)]);
    const other = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', accountId: 62 }, { actAs: { email: ME } });
    expect(other.isError).toBe(true);
    expect(requests().some(r => r.method === 'POST')).toBe(false);
    expect(requests().find(r => r.url.pathname === '/absence/v1.0/accounts')!.url.searchParams.get('employeeId')).toBe(String(MY_ID));

    // 63 is on the second page of the person's accounts.
    const own = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', accountId: 63 }, { actAs: { email: ME } });
    expect(own.isError, texts(own).join(' ')).toBeUndefined();
  });

  it('is refused like any write when writes are off', async () => {
    const { gw, fetchImpl } = setup([employees([{ id: MY_ID, email: 'mette@example.com' }]), ACCOUNTS, DRAFT], { enableWrites: false });
    const result = await gw.callTool('request_my_absence', { from: '2026-11-23', to: '2026-11-24', absenceType: 'Vacation' }, { actAs: { email: ME } });
    expect(result.isError).toBe(true);
    expect(fetchImpl.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});

