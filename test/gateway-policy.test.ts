import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlandayGateway } from '../src/gateway.js';
import { pseudonym } from '../src/tools/planday.js';
import { BASE, stubFetch, texts, testGateway, SHIFT_CREATED } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planday-policy-'));
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

const KEY = `tenant-${'x'.repeat(12)}`;

function routes() {
  return stubFetch({
    [`GET ${BASE}/hr/v1.0/employees/12`]: { body: { data: { id: 12 } } },
    [`POST ${BASE}/scheduling/v1.0/shifts`]: { body: { data: SHIFT_CREATED } },
  });
}

/** Records every environment variable read while `work` runs. */
async function envReads(work: () => Promise<void>): Promise<Set<string>> {
  const reads = new Set<string>();
  const env = { ...process.env };
  process.env = new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        reads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await work();
  } finally {
    process.env = env;
  }
  return reads;
}

describe('instance policy from the host', () => {
  it('reads no policy or audit variable from the environment', async () => {
    process.env.PLANDAY_ENABLE_WRITES = 'true';
    process.env.PLANDAY_DISABLED_TOOLS = 'get_employee';
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.PLANDAY_ALLOW_CUSTOM_BASE_URL = 'true';

    const reads = await envReads(async () => {
      const gw = testGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('get_employee');
      const read = await gw.callTool('get_employee', { employeeId: 12 });
      expect(read.isError).toBeUndefined();
      const write = await gw.callTool('create_shift', { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'n' });
      expect(write.isError).toBe(true);
      expect(texts(write).join(' ')).toMatch(/host has not enabled writes/);
    });

    for (const name of ['PLANDAY_ENABLE_WRITES', 'PLANDAY_DISABLED_TOOLS', 'PLANDAY_AUDIT_LOG', 'PLANDAY_ALLOW_CUSTOM_BASE_URL']) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });

  it('keeps two instances in one process apart', async () => {
    const fetchImpl = routes() as unknown as typeof fetch;
    const a = testGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl, policy: { disabledTools: ['get_employee'] } });
    const b = testGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });

    expect(a.tools.map(tool => tool.name)).not.toContain('get_employee');
    expect(b.tools.map(tool => tool.name)).toContain('get_employee');

    const [denied, allowed] = await Promise.all([
      a.callTool('get_employee', { employeeId: 12 }),
      b.callTool('create_shift', { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'n' }),
    ]);
    expect(denied.isError).toBe(true);
    expect(texts(denied).join(' ')).toMatch(/disabled on this instance/);
    expect(allowed.isError).toBeUndefined();
  });

  it('sends audit records to the host and refuses a write whose start record is refused', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = testGateway({
      accessToken: KEY,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('get_employee', { employeeId: 12 }, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      [pseudonym('r1'), 'start', expect.stringMatching(/^sha256:[0-9a-f]{16}$/)],
      [pseudonym('r1'), 'finish', expect.stringMatching(/^sha256:[0-9a-f]{16}$/)],
    ]);

    const fetchImpl = routes();
    const refusing = testGateway({
      accessToken: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const write = await refusing.callTool('create_shift', { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'n' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unclear policy when the instance is created', () => {
    const create = (policy: unknown) => () =>
      testGateway({ accessToken: KEY, baseUrl: BASE, policy: policy as never });
    expect(create({ disabledTools: ['no_such_tool'] })).toThrow(/is not a known tool/);
    expect(create({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(create({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(create(null)).toThrow(/policy/);
  });

  it('still uses the environment without a host policy', async () => {
    process.env.PLANDAY_ENABLE_WRITES = 'true';
    const gw = testGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch });
    const write = await gw.callTool('create_shift', { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'n' });
    expect(write.isError).toBeUndefined();
  });
});
