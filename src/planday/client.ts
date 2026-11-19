import { ConfigError, readEnvBoolean, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { PlandayHttpError, describeUrl, parseRetryAfterMs, SecretRedactor } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface PlandayClientOptions {
  /**
   * The app's client id: the "App Id" column under Settings > Integrations >
   * API Access in Planday. Sent as X-ClientId and in the token request. Not
   * a secret. When omitted, read from PLANDAY_CLIENT_ID in `credentialEnv`.
   */
  clientId?: string;
  /**
   * The refresh token: the "Token" column of the authorized app. A secret.
   * When omitted, read from PLANDAY_REFRESH_TOKEN in `credentialEnv`.
   */
  refreshToken?: string;
  /**
   * Called when the token endpoint answers with a refresh token that differs
   * from the one in use. Planday documents that refresh tokens do not expire
   * and does not document rotation; if it rotates one, the client uses the
   * new one from then on, and a host that stores tokens can save it here.
   */
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  /** API base URL (default https://openapi.planday.com; env PLANDAY_BASE_URL). */
  baseUrl?: string;
  /** Token endpoint (default https://id.planday.com/connect/token; env PLANDAY_TOKEN_URL). */
  tokenUrl?: string;
  /**
   * Where omitted credentials are read from. Defaults to process.env for the
   * standalone server. The gateway passes `{}`, so an embedded instance only
   * ever uses the credentials it was given.
   */
  credentialEnv?: Env;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env PLANDAY_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env PLANDAY_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env PLANDAY_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for idempotent GETs on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Allow hosts other than Planday's (env PLANDAY_ALLOW_CUSTOM_BASE_URL=true). Loopback http is always allowed for mocks. */
  allowCustomBaseUrl?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests: the clock used for the access token's lifetime. */
  now?: () => number;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * The header that carries the access token ("Authorization: Bearer ...",
 * https://developer.planday.com/gettingstarted/authorization/); error text
 * redaction follows it.
 */
export const API_KEY_HEADER = 'Authorization';

/** The header that carries the client id on every API request (same page). */
export const CLIENT_ID_HEADER = 'X-ClientId';

/** The API host and the token host from Planday's documentation (exact host match, no subdomains). */
export const API_HOST = 'openapi.planday.com';
export const TOKEN_HOST = 'id.planday.com';

export const DEFAULT_BASE_URL = `https://${API_HOST}`;
export const DEFAULT_TOKEN_URL = `https://${TOKEN_HOST}/connect/token`;

/**
 * The only writes the client sends: method and path (relative to the base
 * URL). Anything else, a DELETE among them, is refused before it is sent,
 * whatever a tool or a policy says. The client has no delete method at all.
 */
export const ALLOWED_WRITES: ReadonlyArray<{ method: 'POST' | 'PUT'; path: RegExp }> = [
  { method: 'POST', path: /^\/scheduling\/v1\.0\/shifts$/ },
  { method: 'POST', path: /^\/scheduling\/v1\.0\/shifts\/\d+\/employee$/ },
  { method: 'POST', path: /^\/scheduling\/v1\.0\/shifts\/\d+\/requests\/\d+\/approve$/ },
];

/** An access token is renewed this long before it expires. */
const TOKEN_EARLY_RENEWAL_MS = 60_000;

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The client as handed to tool handlers. Read-only tools get a view whose
 * non-GET methods throw (see readOnlyClient), so the write gate does not
 * depend on tool annotations alone.
 */
export interface UpstreamClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
}

/**
 * A view of the client that only allows GET. A read-only tool that needs a
 * POST (e.g. a search endpoint that takes a body) should get an explicit,
 * named method here rather than the full client.
 */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get: (path, query) => client.get(path, query),
    post: refuse('POST'),
    put: refuse('PUT'),
  };
}

/** The token endpoint refused the refresh token or the client id: our own text, nothing of the answer. */
export class PlandayTokenError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      `Planday refused the app's token (HTTP ${status}). The app may have been removed or its access withdrawn; ` +
        'an administrator authorizes it again under Settings > Integrations > API Access and copies the new token.',
    );
    this.name = 'PlandayTokenError';
    this.status = status;
  }
}

/**
 * Client for the Planday Open API. Authenticates with OAuth: the app's
 * refresh token is exchanged at the token endpoint for an access token
 * (documented lifetime one hour), which is sent as a Bearer token with the
 * client id in X-ClientId. The access token is kept in memory, renewed a
 * minute before it expires, and renewed once when the API answers 401.
 *
 * Redirects are never followed, so no token can be forwarded to another
 * origin. Idempotent GETs are retried with backoff on throttling, gateway
 * errors and transient network failures; other methods are never retried.
 * Missing credentials only fail when a request is made, so the tool list can
 * be read without credentials.
 *
 * Each client owns a SecretRedactor holding its refresh token and the
 * access token in use; errors raised by the client, and the audit and tool
 * results of calls made through it, are redacted with it.
 */
export class PlandayClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  readonly clientId?: string;
  private refreshToken?: string;
  private readonly onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  readonly baseUrl: string;
  private readonly tokenUrl: string;
  private access?: { token: string; expiresAt: number };
  private readonly retired: string[] = [];
  private pendingToken?: Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: PlandayClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    this.clientId = options.clientId ?? readEnvString('PLANDAY_CLIENT_ID', credentialEnv);
    this.refreshToken = options.refreshToken ?? readEnvString('PLANDAY_REFRESH_TOKEN', credentialEnv);
    this.onRefreshToken = options.onRefreshToken;
    this.redactor = new SecretRedactor().addHeader(API_KEY_HEADER).addSecret(this.refreshToken);
    const allowCustom = options.allowCustomBaseUrl ?? readEnvBoolean('PLANDAY_ALLOW_CUSTOM_BASE_URL', false);
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? readEnvString('PLANDAY_BASE_URL', credentialEnv) ?? DEFAULT_BASE_URL);
    assertSafeUrl(this.baseUrl, API_HOST, 'PLANDAY_BASE_URL', allowCustom);
    this.tokenUrl = options.tokenUrl ?? readEnvString('PLANDAY_TOKEN_URL', credentialEnv) ?? DEFAULT_TOKEN_URL;
    assertSafeUrl(this.tokenUrl, TOKEN_HOST, 'PLANDAY_TOKEN_URL', allowCustom);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'PLANDAY_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'PLANDAY_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(intOption('maxConcurrency', options.maxConcurrency, 'PLANDAY_MAX_CONCURRENCY', 4, 1, 64));
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', this.buildUrl(path, query));
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('POST', this.buildUrl(path, query), body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', this.buildUrl(path), body);
  }

  /** A query value that is a list is sent as the parameter repeated, as the Open API takes arrays (e.g. departmentId). */
  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** The access token in use, renewed when it is about to expire. One renewal at a time per client. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - TOKEN_EARLY_RENEWAL_MS > this.now()) return this.access.token;
    this.pendingToken ??= this.renewAccessToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  /** Forget the access token (after a 401), so the next request renews it. */
  private dropAccessToken(token: string): void {
    if (this.access?.token === token) {
      this.access = undefined;
    }
  }

  /**
   * POST the refresh token to the token endpoint, form-encoded, as the
   * documentation shows: client_id, grant_type=refresh_token, refresh_token.
   * The answer must hold an access_token; expires_in (seconds) sets its
   * lifetime (one hour when absent, as documented).
   */
  private async renewAccessToken(): Promise<string> {
    if (!this.clientId) throw new Error('Missing PLANDAY_CLIENT_ID. Set it in the MCP server environment.');
    if (!this.refreshToken) throw new Error('Missing PLANDAY_REFRESH_TOKEN. Set it in the MCP server environment.');
    const body = new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.refreshToken });
    const init: RequestInit = {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    };
    const answer = await this.execute('POST', this.tokenUrl, init, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new Error(redirectRefusedMessage(response, 'POST', this.tokenUrl));
      }
      if (!response.ok) {
        // The body is Planday's text: never read into an error.
        await discardBody(response);
        if (response.status === 400 || response.status === 401) throw new PlandayTokenError(response.status);
        throw new PlandayHttpError({ status: response.status, url: describeUrl(this.tokenUrl), retryAfter: response.headers.get('retry-after') ?? undefined });
      }
      return readResponseBody(response, this.maxResponseBytes);
    });
    const value = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
    const token = value.access_token;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(token)) {
      throw new Error('Planday answered the token request without an access token. Nothing in the answer was used.');
    }
    if (value.token_type !== undefined && (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer')) {
      throw new Error('Planday answered the token request with another token type than Bearer. Nothing in the answer was used.');
    }
    const expiresIn =
      typeof value.expires_in === 'number' && Number.isInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 86_400
        ? value.expires_in
        : 3_600;
    // Earlier access tokens stay redacted for two renewals: one renewed early, or dropped after a 401, may still be
    // valid, and errors in flight may hold it. Older ones have expired and are let go, so a long-running instance
    // does not keep every token it ever had.
    const previous = this.access?.token;
    this.redactor.addSecret(token);
    if (previous && previous !== token) {
      this.retired.push(previous);
      while (this.retired.length > 2) this.redactor.removeSecret(this.retired.shift() as string);
    }
    this.access = { token, expiresAt: this.now() + expiresIn * 1000 };
    const rotated = value.refresh_token;
    if (typeof rotated === 'string' && /^[\x21-\x7e]{16,8192}$/.test(rotated) && rotated !== this.refreshToken) {
      // Not documented to happen; if it does, the new refresh token is used from now on, and both stay redacted.
      this.redactor.addSecret(rotated);
      this.refreshToken = rotated;
      try {
        const stored: unknown = this.onRefreshToken?.(rotated);
        // A host that stores the token asynchronously: a rejected promise must not become an unhandled
        // rejection (which ends a Node process). The token is in use in memory either way.
        if (stored && typeof (stored as Promise<void>).then === 'function') {
          (stored as Promise<void>).then(undefined, () => undefined);
        }
      } catch {
        // A host's callback failing does not fail the call; the token is in use in memory.
      }
    }
    return token;
  }

  private async request<T>(method: HttpMethod, url: string, body?: unknown): Promise<T> {
    if (method !== 'GET') {
      // The fixed list of writes: anything else is refused before any token is put in a header.
      const path = new URL(url).pathname.slice(new URL(`${this.baseUrl}/`).pathname.length - 1);
      if (!ALLOWED_WRITES.some(entry => entry.method === method && entry.path.test(path))) {
        throw new Error(`Refused: ${method} to that Planday path is not among the writes this server sends.`);
      }
    }
    if (!this.clientId) throw new Error('Missing PLANDAY_CLIENT_ID. Set it in the MCP server environment.');
    // A 401 means the access token was not accepted and nothing was done: renew it once and send again.
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        [CLIENT_ID_HEADER]: this.clientId,
        [API_KEY_HEADER]: `Bearer ${token}`,
      };
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const result = await this.execute(method, url, init, async response => {
        if (isRedirect(response.status)) {
          await discardBody(response);
          throw new Error(this.redactor.redact(redirectRefusedMessage(response, method, url)));
        }
        if (response.status === 401 && attempt === 1) {
          await discardBody(response);
          return { unauthorised: true as const };
        }
        if (!response.ok) {
          // The body is Planday's text: it is never read into an error, a result or an audit record.
          await discardBody(response);
          throw new PlandayHttpError({
            status: response.status,
            url: describeUrl(url),
            retryAfter: response.headers.get('retry-after') ?? undefined,
          });
        }
        return { body: (await readResponseBody(response, this.maxResponseBytes)) as T };
      });
      if ('unauthorised' in result) {
        this.dropAccessToken(token);
        continue;
      }
      return result.body;
    }
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * idempotent GETs on retryable statuses and transient network errors
   * within the retry budget. `handle` runs while the concurrency slot is
   * held, so body reads count against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = method === 'GET' ? this.maxAttempts : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, url, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, url, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, url, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is configuration and is not quoted.
  private transportError(method: HttpMethod, _url: string, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`Planday API request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling the Planday API (${method})${shown}.`), { cause: error });
  }
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      // The value is not quoted: an option may hold a secret put there by mistake.
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The redirect's Location is the vendor's text and is never quoted; only the status and our own request. */
function redirectRefusedMessage(response: Response, method: HttpMethod, _url: string): string {
  return (
    `Planday API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
    'redirects are not followed. Check PLANDAY_BASE_URL and PLANDAY_TOKEN_URL.'
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`Planday API response of ${declared} bytes exceeds the ${maxBytes} byte limit (PLANDAY_MAX_RESPONSE_BYTES).`);
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    // A timeout or a dropped connection goes on to execute(), which reports it as a transport error. Anything else
    // thrown while reading the body is replaced by a fixed text: its message is not ours.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error('The Planday API response could not be read.');
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    throw new Error(`Planday API response exceeds the ${maxBytes} byte limit (PLANDAY_MAX_RESPONSE_BYTES).`);
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * A URL a token may be sent to: https on exactly `host` (Planday's documented
 * host for it), no credentials, query or fragment. Loopback http is allowed
 * for local mocks; another host only with allowCustomHost. The value is
 * never quoted: it is configuration.
 */
function assertSafeUrl(value: string, host: string, name: string, allowCustomHost: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL.`);
  }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    throw new ConfigError(`${name} must not contain credentials, a query string or a fragment.`);
  }
  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return;
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`Refusing to send a token over a scheme other than https://. ${name} must use https://.`);
  }
  if (parsed.hostname.toLowerCase() === host || allowCustomHost) return;
  throw new ConfigError(`Refusing to send a token to that host: ${name} must be on ${host}. Set PLANDAY_ALLOW_CUSTOM_BASE_URL=true to allow another host.`);
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
