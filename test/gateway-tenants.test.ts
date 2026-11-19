import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, PlandayClient } from '../src/planday/client.js';
import { createPlandayGateway, plandayGatewayTools, plandayToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { PLANDAY_TOOLS, pseudonym } from '../src/tools/planday.js';
import { accessTokenFor, BASE, CLIENT_ID, TOKEN_URL, auditLines, connect, stubFetch, texts, testGateway, testClient, withToken, SHIFT_CREATED } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planday-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PLANDAY_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'omega-0123456789-kq'; // gitleaks:allow (a test value, not a key)
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77'; // gitleaks:allow (a test value, not a key)

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires the client id and the refresh token, and ignores the environment', () => {
    process.env.PLANDAY_CLIENT_ID = CLIENT_ID;
    process.env.PLANDAY_REFRESH_TOKEN = ENV_KEY;

    expect(() => createPlandayGateway({ clientId: CLIENT_ID } as never)).toThrow(/requires options\.refreshToken/);
    expect(() => createPlandayGateway({ clientId: CLIENT_ID, refreshToken: '  ' })).toThrow(/requires options\.refreshToken/);
    expect(() => createPlandayGateway({ refreshToken: KEY_A } as never)).toThrow(/requires options\.clientId/);
    expect(() => createPlandayGateway({ clientId: 'with space', refreshToken: KEY_A })).toThrow(/requires options\.clientId/);
    expect(() => createPlandayGateway(undefined as never)).toThrow(/requires options\.refreshToken/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, PLANDAY_CLIENT_ID: 'env-client', PLANDAY_REFRESH_TOKEN: ENV_KEY, PLANDAY_BASE_URL: BASE };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createPlandayGateway({ clientId: CLIENT_ID } as never)).toThrow(/requires options\.refreshToken/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/hr/v1.0/employees/12`]: { body: { data: { id: 12 } } } });
    const gw = createPlandayGateway({ clientId: CLIENT_ID, refreshToken: KEY_A, fetchImpl: withToken(fetchImpl) });
    const result = await gw.callTool('get_employee', { employeeId: 12 });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(`Bearer ${accessTokenFor(KEY_A)}`);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])['X-ClientId']).toBe(CLIENT_ID);

    for (const name of ['PLANDAY_CLIENT_ID', 'PLANDAY_REFRESH_TOKEN', 'PLANDAY_BASE_URL', 'PLANDAY_TOKEN_URL']) expect(reads.has(name), name).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.PLANDAY_CLIENT_ID = 'env-client';
    process.env.PLANDAY_REFRESH_TOKEN = ENV_KEY;
    const token = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toBe(`client_id=env-client&grant_type=refresh_token&refresh_token=${ENV_KEY}`);
      return Response.json({ access_token: accessTokenFor(ENV_KEY), expires_in: 3600 });
    });
    const api = vi.fn(async () => Response.json({}));
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === TOKEN_URL ? token(input, init) : api()) as typeof fetch;
    await new PlandayClient({ fetchImpl }).get('/hr/v1.0/employees/1');
    expect(token).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = testGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: echoingFetch(KEY_A) });
    const b = testGateway({ accessToken: KEY_B, baseUrl: BASE, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_employee', { employeeId: 12 })).join(' ');
    const resultB = texts(await b.callTool('get_employee', { employeeId: 12 })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = testClient({ accessToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    const b = testClient({ accessToken: KEY_B, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      testGateway({ accessToken: `short-lived-key-${index}`, baseUrl: BASE });
    }
    const fresh = testClient({ accessToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = testGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = testGateway({ accessToken: KEY_B, baseUrl: BASE, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_employee', { employeeId: 12 }, { requestId: 'a' });
    await b.callTool('get_employee', { employeeId: 12 }, { requestId: 'b' });

    const errors = auditLines(process.env.PLANDAY_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual([pseudonym('a'), pseudonym('b')]);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = PLANDAY_TOOLS.find(t => t.name === 'planday_get_employee')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12 } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createPlandayGateway> | undefined = testGateway({
      accessToken: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, GatewayJsonObject> = {
  check_connection: {},
  list_departments: {},
  list_employee_groups: { limit: 10 },
  list_employees: { search: 'Hansen' },
  get_employee: { employeeId: 21 },
  list_shifts: { from: '2026-11-01', to: '2026-11-30', departmentId: 1 },
  get_shift: { shiftId: 31 },
  list_shift_types: { activeOnly: true },
  list_positions: {},
  list_shift_requests: { departmentIds: [1, 2] },
  list_punch_clock_records: { from: '2026-11-01', to: '2026-11-07' },
  create_shift: { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00' },
  assign_shift: { shiftId: 31, employeeId: 21 },
  approve_shift_request: { shiftId: 31, employeeId: 21 },
};

/** Answers that let every tool run to its end: the record asked for, a list of one, a shift with employee 21. */
async function catalogFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? 'GET';
  if (method === 'POST' && path.endsWith('/shifts')) return Response.json({ data: SHIFT_CREATED });
  if (method === 'POST') return new Response(null, { status: 204 });
  const shiftId = /\/shifts\/(\d+)$/.exec(path)?.[1];
  if (shiftId) return Response.json({ data: { id: Number(shiftId), employeeId: 21 } });
  if (path.endsWith('/shifts/requests')) return Response.json({ data: [{ shiftId: 31, requesters: [{ employeeId: 21 }] }] });
  const employeeId = /\/employees\/(\d+)$/.exec(path)?.[1];
  if (employeeId) return Response.json({ data: { id: Number(employeeId) } });
  return Response.json({ data: [{ id: 1, departmentId: 1 }], paging: { offset: 0, limit: 50, total: 1 } });
}

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(plandayToolCatalog.map(entry => entry.name)).toEqual(plandayGatewayTools.map(tool => tool.name));
    for (const entry of plandayToolCatalog) {
      const { upstream, broad, requiresConfirmation, change, ...definition } = entry;
      expect(typeof requiresConfirmation).toBe('boolean');
      expect(change === undefined).toBe(entry.riskLevel === 'read');
      if (requiresConfirmation) expect(entry.riskLevel).toBe('write');
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(plandayGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      plandayToolCatalog.map(entry => `planday_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = plandayToolCatalog.find(e => `planday_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(plandayToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(plandayToolCatalog);
    expect(() => {
      (plandayToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.PLANDAY_ENABLE_WRITES = 'true';
    for (const entry of plandayToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(catalogFetch);
      const gw = testGateway({ accessToken: KEY_A, fetchImpl });
      const result = await gw.callTool(entry.name, input!);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input![name] ?? ''))),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname,
      }));
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
