import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, CLIENT_ID_HEADER, PlandayClient, PlandayTokenError, type PlandayClientOptions } from '../src/planday/client.js';
import { accessTokenFor, CLIENT_ID, TOKEN_URL, withToken } from './helpers.js';
import { PlandayHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://openapi.planday.com';

/**
 * A client in the shape the error, retry and redirect tests were written in
 * (`accessToken`): the key becomes the refresh token, and the fetch answers
 * the token endpoint itself, so the test's stub sees only API requests.
 */
function pc(options: Record<string, unknown> & { accessToken?: string }) {
  const { accessToken, fetchImpl, ...rest } = options;
  return new PlandayClient({
    clientId: CLIENT_ID,
    refreshToken: accessToken,
    fetchImpl: withToken(fetchImpl ?? fetch),
    ...rest,
  } as PlandayClientOptions);
}

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof PlandayClient>[0]> = {}) {
  return pc({ accessToken: 'k', baseUrl: BASE, fetchImpl, sleep: noSleep, ...extra });
}

describe('PlandayClient', () => {
  it('sends the access token as Bearer with the client id and User-Agent, and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { data: [] };
    });

    await pc({ accessToken: 'refresh-token-0001', baseUrl: `${BASE}/`, fetchImpl }).get('/hr/v1.0/departments', { limit: 5 });

    expect(seenUrl).toBe(`${BASE}/hr/v1.0/departments?limit=5`);
    expect(headersOf(seenInit)[API_KEY_HEADER]).toBe(`Bearer ${accessTokenFor('refresh-token-0001')}`);
    expect(headersOf(seenInit)[CLIENT_ID_HEADER]).toBe(CLIENT_ID);
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(JSON.stringify(seenInit)).not.toContain('refresh-token-0001');
    expect(seenInit?.redirect).toBe('manual');
  });

  it('repeats a list in the query as the parameter repeated', () => {
    const url = new URL(pc({ accessToken: 'k' }).buildUrl('/scheduling/v1.0/shifts', { departmentId: [1, 2], from: '2026-11-01' }));
    expect(url.searchParams.getAll('departmentId')).toEqual(['1', '2']);
    expect(url.searchParams.get('from')).toBe('2026-11-01');
  });

  it('throws before sending anything when the client id or refresh token is missing, and uses the documented hosts by default', async () => {
    const fetchImpl = makeFetch(() => ({}));
    for (const name of ['PLANDAY_CLIENT_ID', 'PLANDAY_REFRESH_TOKEN', 'PLANDAY_BASE_URL', 'PLANDAY_TOKEN_URL']) delete process.env[name];

    await expect(new PlandayClient({ refreshToken: 'k', fetchImpl }).get('/x')).rejects.toThrow('PLANDAY_CLIENT_ID');
    await expect(new PlandayClient({ clientId: CLIENT_ID, fetchImpl }).get('/x')).rejects.toThrow('PLANDAY_REFRESH_TOKEN');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new PlandayClient({ clientId: CLIENT_ID, refreshToken: 'k' }).baseUrl).toBe('https://openapi.planday.com');
  });

  it('pins the tokens to the Planday hosts', () => {
    delete process.env.PLANDAY_ALLOW_CUSTOM_BASE_URL;
    expect(() => pc({ accessToken: 'k', baseUrl: 'https://openapi.planday.com' })).not.toThrow();
    expect(() => pc({ accessToken: 'k', baseUrl: 'https://openapi.planday.com.evil.test' })).toThrow(/must be on/);
    expect(() => pc({ accessToken: 'k', baseUrl: 'https://evil.test' })).toThrow(/must be on/);
    expect(() => pc({ accessToken: 'k', tokenUrl: 'https://id.planday.com.evil.test/connect/token' })).toThrow(/must be on/);
    expect(() => pc({ accessToken: 'k', tokenUrl: 'https://evil.test/connect/token' })).toThrow(/must be on/);
  });

  it('sends only the writes on its fixed list, and no DELETE but of one shift', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ data: { id: 1 } }, 200));
    const client = makeClient(fetchImpl);
    await expect(client.post('/hr/v1.0/employees', {})).rejects.toThrow('Refused');
    await expect(client.put('/hr/v1.0/employees/1', {})).rejects.toThrow('Refused');
    await expect(client.put('/scheduling/v1.0/shifts/1/employee', {})).rejects.toThrow('Refused');
    await expect(client.delete('/scheduling/v1.0/shifts')).rejects.toThrow('Refused');
    await expect(client.delete('/hr/v1.0/employees/1')).rejects.toThrow('Refused');
    await expect(client.delete('/absence/v1.0/absencerequests/1')).rejects.toThrow('Refused');
    await expect(client.delete('/scheduling/v1.0/positions/1')).rejects.toThrow('Refused');
    await expect(client.put('/absence/v1.0/absencerequests/1/decline', {})).rejects.toThrow('Refused');
    await expect(client.put('/absence/v1.0/accounts/1', {})).rejects.toThrow('Refused');
    await expect(client.post('/punchclock/v1.0/punchclockshifts', {})).rejects.toThrow('Refused');
    await expect(client.post('/scheduling/v1.0/shifts/drafts/publish', {})).rejects.toThrow('Refused');
    await expect(client.post('/scheduling/v1.0/shifts/1/requests/2/decline', {})).rejects.toThrow('Refused');
    await expect(client.post('/pay/v1.0/salaries', {})).rejects.toThrow('Refused');
    await expect(client.post('/scheduling/v1.0/shifts/x/employee', {})).rejects.toThrow('Refused');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.post('/scheduling/v1.0/shifts', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.post('/scheduling/v1.0/shifts/7/employee', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.post('/scheduling/v1.0/shifts/7/requests/9/approve', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.put('/scheduling/v1.0/shifts/7', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.delete('/scheduling/v1.0/shifts/7')).resolves.toEqual({ data: { id: 1 } });
    await expect(client.post('/scheduling/v1.0/shifts/7/approve')).resolves.toEqual({ data: { id: 1 } });
    await expect(client.put('/punchclock/v1.0/punchclockshifts', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.post('/absence/v1.0/absencerequests', {})).resolves.toEqual({ data: { id: 1 } });
    await expect(client.put('/absence/v1.0/absencerequests/5/approve', {})).resolves.toEqual({ data: { id: 1 } });
  });

  it('refuses unsafe base URLs without echoing credentials', () => {
    expect(() => pc({ accessToken: 'k', baseUrl: 'http://api.vendor.test' })).toThrow('https://');
    expect(() => pc({ accessToken: 'k', baseUrl: 'not a url' })).toThrow('not a valid URL');
    expect(() => pc({ accessToken: 'k', baseUrl: 'http://127.0.0.1:8080/api' })).not.toThrow();
    expect(() => pc({ accessToken: 'k', baseUrl: 'http://localhost:8080/api' })).not.toThrow();
    expect(() => pc({ accessToken: 'k', baseUrl: 'http://[::1]:8080/api' })).not.toThrow();

    for (const baseUrl of [
      'https://user:hunter2@api.vendor.test/v1',
      'https://openapi.planday.com?x=1',
      'https://openapi.planday.com#frag',
    ]) {
      let message = '';
      try {
        pc({ accessToken: 'k', baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    process.env.PLANDAY_TIMEOUT_MS = '30s';
    expect(() => pc({ accessToken: 'k' })).toThrow('PLANDAY_TIMEOUT_MS');
    process.env.PLANDAY_TIMEOUT_MS = '3000000000';
    expect(() => pc({ accessToken: 'k' })).toThrow('PLANDAY_TIMEOUT_MS');
    delete process.env.PLANDAY_TIMEOUT_MS;
    process.env.PLANDAY_MAX_CONCURRENCY = 'many';
    expect(() => pc({ accessToken: 'k' })).toThrow('PLANDAY_MAX_CONCURRENCY');
    delete process.env.PLANDAY_MAX_CONCURRENCY;
    process.env.PLANDAY_MAX_RESPONSE_BYTES = '10MB';
    expect(() => pc({ accessToken: 'k' })).toThrow('PLANDAY_MAX_RESPONSE_BYTES');
    delete process.env.PLANDAY_MAX_RESPONSE_BYTES;
    process.env.PLANDAY_ALLOW_CUSTOM_BASE_URL = 'perhaps';
    expect(() => pc({ accessToken: 'k', baseUrl: BASE })).toThrow('PLANDAY_ALLOW_CUSTOM_BASE_URL');
    delete process.env.PLANDAY_ALLOW_CUSTOM_BASE_URL;

    expect(() => pc({ accessToken: 'k', maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => pc({ accessToken: 'k', maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => pc({ accessToken: 'k', timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => pc({ accessToken: 'k', maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own hint, never the vendor body or code', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ code: 'invalid_key', message: 'Unrecognized key' }, 401));
    const error = await makeClient(fetchImpl).get('/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlandayHttpError);
    expect((error as PlandayHttpError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('Settings > Integrations > API Access');
    expect((error as Error).message).not.toContain('Unrecognized key');
    expect((error as Error).message).not.toContain('invalid_key');
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(error.message).toBe('Planday API request failed with HTTP 502');
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(error).toBeInstanceOf(PlandayHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the configured access token wherever it appears, before truncating', async () => {
    const accessToken = 'live-key-0123456789abcdef'; // gitleaks:allow (a test value, not a key)
    const respond = (body: string, type = 'text/plain') =>
      pc({
        accessToken,
        baseUrl: BASE,
        fetchImpl: makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })),
      });

    const echoed = (await respond(`proxy error: ${accessToken} and ${encodeURIComponent(accessToken)}`)
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(echoed.message).not.toContain(accessToken);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${accessToken}`)
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(boundary.message).not.toContain(accessToken.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: accessToken } }), 'application/json')
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(JSON.stringify(nested)).not.toContain(accessToken);

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('PLANDAY_ACCESS_TOKEN=abc123')).not.toContain('abc123');
  });

  it('redacts the configured key header by name', () => {
    const redactor = new SecretRedactor().addHeader('X-Vendor-Token').addHeader(API_KEY_HEADER);
    const redactSecrets = (text: string) => redactor.redact(text);
    expect(redactSecrets('sent x-vendor-token: abc123, ok')).toBe('sent x-vendor-token: ‹redacted›, ok');
    expect(redactSecrets(`${API_KEY_HEADER}: abc123`)).not.toContain('abc123');
    for (const text of [
      '{"X-Vendor-Token":"abc123"}',
      "{'x-vendor-token': 'abc123'}",
      'x-vendor-token=abc123',
      `{"${API_KEY_HEADER}": "abc123"}`,
      '{"authorization":"Bearer abc123"}',
      'authorization=abc123',
      'x-api-key=abc123:def',
      'X-Vendor-Token=abc123=def',
      'authorization=abc123:pass',
      'Authorization: Basic abc123',
      'Authorization: Token abc123',
      '"Authorization": "Digest abc123"',
    ]) {
      expect(redactSecrets(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get('/scheduling/v1.0/shifts', { cursor: 'secret-cursor' })
      .catch((e: unknown) => e)) as PlandayHttpError;
    expect(error.url).toBe(`${BASE}/scheduling/v1.0/shifts`);
    expect(error.message).not.toContain('secret-cursor');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.vendor.test'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling the Planday API \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('reports timeouts clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl).get('/items?cursor=c')).rejects.toThrow(
      /timed out after \d+ ms \(GET\)/,
    );
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(
      () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(makeClient(big, { maxResponseBytes: 10 }).get('/x')).rejects.toThrow('exceeds the 10 byte limit');
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('/x')).resolves.toBe('x'.repeat(100));
  });
});

describe('redirects', () => {
  it('never follows redirects and names the target without its query', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/v1/items?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get('/scheduling/v1.0/shifts')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('PLANDAY_BASE_URL');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    await expect(makeClient(fetchImpl).post('/scheduling/v1.0/shifts', {})).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/x')
      .catch((e: unknown) => e)) as PlandayHttpError;

    expect(error).toBeInstanceOf(PlandayHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries GETs on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/x')).rejects.toThrow('Network error');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('never retries POST or PUT', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('/scheduling/v1.0/shifts', {})).rejects.toBeInstanceOf(PlandayHttpError);
    await expect(client.post('/scheduling/v1.0/shifts/7/employee', {})).rejects.toBeInstanceOf(PlandayHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    await expect(makeClient(failing).post('/scheduling/v1.0/shifts', {})).rejects.toThrow('Network error');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1 });
    await expect(client.get('/x')).rejects.toThrow('timed out');
    await expect(client.get('/x')).rejects.toBeInstanceOf(PlandayHttpError);
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});

describe('against a local upstream (real sockets)', () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
  });

  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  }

  it('sends the key, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; key?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/v1/contacts/1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
        return;
      }
      res.writeHead(302, { location: `${base}/contacts/1` }).end();
    });
    const client = pc({ accessToken: 'local-key-123456', baseUrl: base });

    await expect(client.get('/contacts/1')).resolves.toEqual({ id: '1' });
    await expect(client.get('/moved')).rejects.toThrow('redirects are not followed');
    expect(seen).toEqual([
      { url: '/v1/contacts/1', key: `Bearer ${accessTokenFor('local-key-123456')}` },
      { url: '/v1/moved', key: `Bearer ${accessTokenFor('local-key-123456')}` },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = pc({ accessToken: 'k', baseUrl: base, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow(/timed out after 100 ms/);
    upstream?.closeAllConnections();
  });
});

describe('OAuth with the refresh token', () => {
  const REFRESH = 'refresh-token-0123456789'; // gitleaks:allow (a test value, not a token)
  const tokenAnswer = (access: string, extra: Record<string, unknown> = {}) =>
    jsonResponse({ access_token: access, expires_in: 3600, token_type: 'Bearer', ...extra }, 200);

  /** A fetch that answers the token endpoint from `tokens` in turn and the API from `api`. */
  function oauthFetch(tokens: Array<() => Response>, api: Handler = () => ({ data: [] })) {
    const tokenCalls: Array<{ url: string; init?: RequestInit }> = [];
    const apiCalls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        tokenCalls.push({ url, init });
        const next = tokens[Math.min(tokenCalls.length - 1, tokens.length - 1)];
        return next ? next() : jsonResponse({}, 500);
      }
      apiCalls.push({ url, auth: headersOf(init)[API_KEY_HEADER] });
      const result = await api(url, init);
      return result instanceof Response ? result : jsonResponse(result, 200);
    }) as unknown as typeof fetch;
    return { fetchImpl, tokenCalls, apiCalls };
  }

  function client(fetchImpl: typeof fetch, extra: Partial<PlandayClientOptions> = {}) {
    return new PlandayClient({ clientId: CLIENT_ID, refreshToken: REFRESH, baseUrl: BASE, fetchImpl, sleep: noSleep, ...extra });
  }

  it('posts the refresh token form-encoded to the token endpoint, as documented', async () => {
    const { fetchImpl, tokenCalls, apiCalls } = oauthFetch([() => tokenAnswer('access-token-aaaaaaaaaaaa')]);
    await client(fetchImpl).get('/hr/v1.0/departments');
    expect(tokenCalls).toHaveLength(1);
    const init = tokenCalls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(headersOf(init)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
    });
    expect(init?.redirect).toBe('manual');
    expect(apiCalls[0]?.auth).toBe('Bearer access-token-aaaaaaaaaaaa');
  });

  it('keeps the access token for its lifetime, renews it a minute early, and renews once for parallel calls', async () => {
    let now = 1_000_000;
    const { fetchImpl, tokenCalls, apiCalls } = oauthFetch([
      () => tokenAnswer('access-token-first-000000'),
      () => tokenAnswer('access-token-second-00000'),
    ]);
    const c = client(fetchImpl, { now: () => now });
    await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')]);
    expect(tokenCalls).toHaveLength(1);
    now += 3_600_000 - 61_000;
    await c.get('/d');
    expect(tokenCalls).toHaveLength(1);
    now += 2_000;
    await c.get('/e');
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map(call => call.auth)).toEqual([
      'Bearer access-token-first-000000',
      'Bearer access-token-first-000000',
      'Bearer access-token-first-000000',
      'Bearer access-token-first-000000',
      'Bearer access-token-second-00000',
    ]);
  });

  it('renews the access token once on a 401 and sends again; a second 401 is an error', async () => {
    let unauthorised = 1;
    const { fetchImpl, tokenCalls, apiCalls } = oauthFetch(
      [() => tokenAnswer('access-token-first-000000'), () => tokenAnswer('access-token-second-00000')],
      () => (unauthorised-- > 0 ? jsonResponse({}, 401) : { data: [] }),
    );
    const c = client(fetchImpl);
    await expect(c.get('/x')).resolves.toEqual({ data: [] });
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map(call => call.auth)).toEqual(['Bearer access-token-first-000000', 'Bearer access-token-second-00000']);

    const always = oauthFetch([() => tokenAnswer('access-token-first-000000')], () => jsonResponse({}, 401));
    const error = await client(always.fetchImpl).get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlandayHttpError);
    expect((error as PlandayHttpError).status).toBe(401);
    expect(always.apiCalls).toHaveLength(2);
  });

  it('reports a refused refresh token with our own text and sends nothing to the API', async () => {
    for (const status of [400, 401]) {
      const { fetchImpl, apiCalls } = oauthFetch([
        () => jsonResponse({ error: 'invalid_grant', error_description: `vendor text ${REFRESH}` }, status),
      ]);
      const error = await client(fetchImpl).get('/x').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlandayTokenError);
      expect((error as Error).message).toContain('Settings > Integrations > API Access');
      expect(JSON.stringify(error)).not.toMatch(/invalid_grant|vendor text/);
      expect((error as Error).message).not.toContain(REFRESH);
      expect(apiCalls).toHaveLength(0);
    }
  });

  it('refuses a token answer without a usable access token or with another token type', async () => {
    for (const answer of [
      {},
      { access_token: 'short' },
      { access_token: 42 },
      { access_token: 'access-token-aaaaaaaaaaaa', token_type: 'mac' },
    ]) {
      const { fetchImpl, apiCalls } = oauthFetch([() => jsonResponse(answer, 200)]);
      const error = await client(fetchImpl).get('/x').catch((e: unknown) => e);
      expect((error as Error).message, JSON.stringify(answer)).toMatch(/token/);
      expect((error as Error).message).not.toContain('access-token-aaaa');
      expect(apiCalls).toHaveLength(0);
    }
  });

  it('never follows a redirect from the token endpoint', async () => {
    const { fetchImpl, apiCalls } = oauthFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://evil.test/collect?token=x' } }),
    ]);
    await expect(client(fetchImpl).get('/x')).rejects.toThrow(/redirect/);
    expect(apiCalls).toHaveLength(0);
  });

  it('uses a rotated refresh token from then on, tells the host, and redacts both', async () => {
    const ROTATED = 'refresh-token-rotated-9876'; // gitleaks:allow (a test value, not a token)
    let now = 1_000_000;
    const seen: string[] = [];
    const { fetchImpl, tokenCalls } = oauthFetch([
      () => tokenAnswer('access-token-first-000000', { refresh_token: ROTATED }),
      () => tokenAnswer('access-token-second-00000'),
    ]);
    const c = client(fetchImpl, { now: () => now, onRefreshToken: token => void seen.push(token) });
    await c.get('/x');
    now += 3_600_000;
    await c.get('/y');
    expect(seen).toEqual([ROTATED]);
    expect(new URLSearchParams(String(tokenCalls[1]?.init?.body)).get('refresh_token')).toBe(ROTATED);
    const text = c.redactor.redact(`${REFRESH} ${ROTATED} access-token-first-000000 access-token-second-00000`);
    for (const secret of [REFRESH, ROTATED, 'access-token-first-000000', 'access-token-second-00000']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps recent access tokens redacted and lets old ones go', async () => {
    let now = 1_000_000;
    let n = 0;
    const { fetchImpl } = oauthFetch([() => tokenAnswer(`access-${'vwxyz'[n++]!.repeat(20)}`)]);
    const c = client(fetchImpl, { now: () => now });
    for (let i = 0; i < 5; i += 1) {
      await c.get('/x');
      now += 3_600_000;
    }
    // Five tokens were handed out; the one in use and the two before it stay redacted, the first two are let go.
    for (const kept of ['z', 'y', 'x']) expect(c.redactor.redact(`access-${kept.repeat(20)}`)).not.toContain(kept.repeat(8));
    for (const old of ['v', 'w']) expect(c.redactor.redact(`access-${old.repeat(20)}`)).toContain(old.repeat(20));
    // The refresh token is never let go.
    expect(c.redactor.redact(REFRESH)).not.toContain(REFRESH);
  });

  it('keeps a host callback that throws from failing the call', async () => {
    const { fetchImpl } = oauthFetch([() => tokenAnswer('access-token-first-000000', { refresh_token: 'refresh-token-rotated-9876' })]);
    const c = client(fetchImpl, {
      onRefreshToken: () => {
        throw new Error('host store down');
      },
    });
    await expect(c.get('/x')).resolves.toEqual({ data: [] });
  });
});
