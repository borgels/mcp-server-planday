import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlandayClient } from '../src/planday/client.js';
import { createPlandayGateway, type PlandayGatewayOptions } from '../src/gateway.js';
import { createServer } from '../src/server.js';

export const BASE = 'https://openapi.planday.com';
export const TOKEN_URL = 'https://id.planday.com/connect/token';
/** The app's client id in tests (not a secret). */
export const CLIENT_ID = 'test-client-id';
/**
 * The access token the stand-in token endpoint hands out for a refresh
 * token: its own per refresh token, so two instances in one test never
 * share one and a mix-up between tenants shows.
 */
export function accessTokenFor(refreshToken: string): string {
  return `at-${createHash('sha256').update(refreshToken).digest('hex').slice(0, 24)}`;
}

/**
 * A fetch that answers the token endpoint itself (a refresh-token grant gets
 * accessTokenFor(refresh token) for an hour) and passes every other request
 * to `inner`, so a test's own stub sees only API requests.
 */
export function withToken(inner: unknown = async () => { throw new TypeError('fetch failed'); }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TOKEN_URL) {
      const refresh = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
      return new Response(JSON.stringify({ access_token: accessTokenFor(refresh), expires_in: 3600, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return (inner as typeof fetch)(input, init);
  }) as typeof fetch;
}

/**
 * Options in the shape the shared tests were written in (`accessToken`,
 * `baseUrl`, `fetchImpl`) as Planday options: the key becomes the refresh
 * token, the fetch answers the token endpoint. Options without
 * `accessToken` are passed on as they are.
 */
type TestOptions = Omit<Partial<PlandayGatewayOptions>, 'fetchImpl'> & {
  accessToken?: string;
  baseUrl?: string;
  allowCustomBaseUrl?: boolean;
  fetchImpl?: unknown;
  credentialEnv?: Record<string, string | undefined>;
};

function plandayOptions(options: TestOptions): Record<string, unknown> {
  if (!('accessToken' in options)) return options;
  const { accessToken, baseUrl, fetchImpl, ...rest } = options;
  // The documented address is the default; another one is passed on, so a test of a refused address still runs.
  return { clientId: CLIENT_ID, refreshToken: accessToken, fetchImpl: withToken(fetchImpl), ...(baseUrl === BASE ? {} : { baseUrl }), ...rest };
}

export function testGateway(options: TestOptions) {
  return createPlandayGateway(plandayOptions(options) as never);
}

export function testClient(options: TestOptions) {
  return new PlandayClient(plandayOptions(options) as never);
}

export type Stub = { status?: number; body?: unknown; raw?: string };

/** A fetch stub keyed by "METHOD URL" (URL without query string). Unknown routes answer 404. */
export function stubFetch(routes: Record<string, Stub>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!stub) {
      return new Response(JSON.stringify({ message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export function makeClient(fetchImpl: unknown) {
  return testClient({ accessToken: 'test-api-key', fetchImpl });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

export function gateway(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const gw = testGateway({ accessToken: 'tttt-gggg-wwww-vvvv-1', fetchImpl });
  return { gw, fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * What POST /scheduling/v1.0/shifts answers for the shift the shared tests
 * create (departmentId 1, employeeGroupId 2, 2026-11-20 08:00-16:00): the
 * CreateShiftOutputModel of the scheduling OpenAPI document, as a draft.
 */
export const SHIFT_CREATED = {
  id: 2,
  departmentId: 1,
  employeeId: null,
  employeeGroupId: 2,
  positionId: null,
  shiftTypeId: null,
  date: '2026-11-20',
  comment: null,
  timeZone: 'Europe/Copenhagen',
  startTime: '08:00',
  endTime: '16:00',
  skillIds: [],
  isDraft: true,
  manualBreaks: [],
};
