import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/planday/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createPlandayGateway, plandayGatewayTools } from '../src/gateway.js';
import { PLANDAY_TOOLS, executeTool, validateStartupConfig, pseudonym } from '../src/tools/planday.js';
import { BASE, auditLines, connect, gateway, makeClient, texts, testGateway, SHIFT_CREATED } from './helpers.js';

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

const item = { id: 12, firstName: 'First item' };
const created = SHIFT_CREATED;

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(PLANDAY_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = PLANDAY_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/hr/v1.0/employees/12`]: { body: { data: item } } });
    const result = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12 } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(item);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12, other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: -1 } });
    expect(traversal.isError).toBe(true);
    const slash = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 'a/b' } });
    expect(slash.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'planday_create_shift', arguments: { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('PLANDAY_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.PLANDAY_ENABLE_WRITES = 'true';
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/scheduling/v1.0/shifts`]: { status: 200, body: { data: created } } });
    const result = await mcpClient.callTool({
      name: 'planday_create_shift',
      arguments: { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'First item' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0] ?? '')).toEqual(created);
    const init = fetchImpl.mock.calls[0]?.[1];
    // A draft, without conflicts, with the department's break rules, and no wage.
    expect(JSON.parse(String(init?.body))).toEqual({
      allowConflicts: false,
      useBreaks: true,
      isDraft: true,
      departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00',
      comment: 'First item',
    });

    const lines = auditLines(process.env.PLANDAY_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // The comment is not logged at all; ids, the date and the times are.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect(lines[0]?.target).toEqual({ departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00' });
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('PLANDAY_AUDIT_LOG');
    expect(() => testGateway({ accessToken: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('PLANDAY_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/hr/v1.0/employees/12`]: { body: { data: item } } });
    const result = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12 } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.PLANDAY_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/scheduling/v1.0/shifts`]: { body: { data: created } } });
    // The log becomes unwritable after startup.
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'planday_create_shift', arguments: { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.PLANDAY_DISABLED_TOOLS = 'create_shift,planday_get_employee';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('planday_create_shift');
    expect(tools.map(t => t.name)).not.toContain('planday_get_employee');
    expect(tools).toHaveLength(PLANDAY_TOOLS.length - 2);

    process.env.PLANDAY_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { clientId: 'c', refreshToken: 'k' } })).toThrow('PLANDAY_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/hr/v1.0/employees/12`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12 } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.PLANDAY_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...PLANDAY_TOOLS[0]!,
      name: 'planday_get_employee',
      handler: async (c: UpstreamClient) => c.post('/contacts', { name: 'x' }),
    };
    await expect(executeTool(misannotated, client, { employeeId: 12 })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = PLANDAY_TOOLS.find(t => t.name === 'planday_get_employee')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header Authorization: Bearer other-secret, {"refresh_token":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'planday_get_employee', arguments: { employeeId: 12 } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    for (const tool of plandayGatewayTools) {
      expect(tool.name.startsWith('planday_')).toBe(false);
      // Reads are on by default; writes are 'write' (the one deletion is of a draft shift) and off by default.
      expect([tool.riskLevel, tool.enabledByDefault]).toEqual(
        tool.riskLevel === 'read' ? ['read', true] : ['write', false],
      );
    }
    expect(plandayGatewayTools.filter(t => t.riskLevel === 'write').map(t => t.name)).toEqual([
      'create_shift',
      'assign_shift',
      'approve_shift_request',
      'update_draft_shift',
      'delete_draft_shift',
      'approve_punch_clock',
      'set_punch_out',
      'register_absence',
      'approve_absence_request',
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of plandayGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.PLANDAY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/hr/v1.0/employees/12`]: { body: { data: item } } });

    const ok = await gw.callTool('get_employee', { employeeId: 12 }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(item);

    const invalid = await gw.callTool('get_employee', { employeeId: 12, extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_shift', { departmentId: 1, employeeGroupId: 2, date: '2026-11-20', startTime: '08:00', endTime: '16:00', comment: 'x' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.PLANDAY_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: pseudonym('req-1'), caller: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), action: 'start' });
    expect(JSON.stringify(lines)).not.toContain('user@vendor.test');
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
