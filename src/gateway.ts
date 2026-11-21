import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './planday/annotations.js';
import { PlandayClient, type PlandayClientOptions } from './planday/client.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type InstancePolicy,
} from './planday/policy.js';
import { ConfigError } from './config-env.js';
import {
  failureMetadata,
  formatUnknownError,
  redactDeep,
  SecretRedactor,
  vendorRequestId,
  type FailureMetadata,
} from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import {
  auditRejectedCall,
  PLANDAY_TOOLS,
  executeTool,
  findTool,
  logFieldValue,
  validateCall,
  validateStartupConfig,
  type PlandayChangeAction,
  type PlandayChangeRecord,
  type PlandayChangeSpec,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
} from './tools/planday.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/planday.ts.
 *
 * One instance per Planday portal: an app's token is tied to the portal it
 * was authorized in ("there needs to be an unique (Refresh) Token from each
 * of the portals", https://developer.planday.com/gettingstarted/authorization/).
 * Several instances can run in one process. Each instance uses only the
 * credentials passed to createPlandayGateway (never PLANDAY_CLIENT_ID,
 * PLANDAY_REFRESH_TOKEN or the URLs from the environment) and redacts errors
 * with its own secrets only.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of PLANDAY_ENABLE_WRITES,
 * PLANDAY_DISABLED_TOOLS, PLANDAY_AUDIT_LOG or PLANDAY_ALLOW_CUSTOM_BASE_URL,
 * so two tenants in one process can have different settings. Without
 * `policy` the instance uses the environment, as the MCP server does. Limits
 * (timeouts, retries) are still read from the environment and apply to every
 * instance.
 *
 * What no policy can turn on: a request outside the client's fixed list of
 * writes (src/planday/client.ts, ALLOWED_WRITES). The only DELETE is of one
 * shift, which the tool sends only after reading it as a draft; there is no
 * tool that reads or changes wages, pay rates, salary codes, CPR numbers,
 * bank accounts or birth dates, or changes an employee.
 */

export type { AuditSink, InstancePolicy } from './planday/policy.js';
export type {
  PlandayChangeAction,
  PlandayChangeRecord,
  PlandayChangeSpec,
  PlandayLogField,
  PlandayLogFieldType,
} from './tools/planday.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Planday answered with,
 * and its own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Planday only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. From the tool table
   * (`broad`), false unless a tool declares it.
   */
  readonly broad: boolean;
  /**
   * True for a tool a person should confirm outside the chat before it runs.
   * False for every tool here: none moves money.
   */
  readonly requiresConfirmation: boolean;
  /**
   * Write tools only: what the change does, for a host that logs a change
   * before it is sent. `logFields` are the input fields that identify it,
   * each with the one type its value must have (Planday record ids, dates,
   * currency codes, dates, counts, flags and kinds in clear; numbers the
   * company chose only as pseudonyms; never names or free text).
   * `resolvePlandayChange` returns their values.
   */
  readonly change?: PlandayChangeSpec;
}

export interface PlandayGatewayOptions extends Omit<PlandayClientOptions, 'clientId' | 'refreshToken' | 'credentialEnv'> {
  /** The app's client id (App Id under Settings > Integrations > API Access). Required; never read from the environment. */
  clientId: string;
  /** The app's refresh token (the Token column). Required; never read from the environment. */
  refreshToken: string;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see InstancePolicy). A host
   * serving several tenants should always pass it.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const plandayGatewayTools: GatewayToolDefinition[] = PLANDAY_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition and the upstream
 * requests it may make. Generated from the same tool table as the MCP server
 * and `plandayGatewayTools`, and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const plandayToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  PLANDAY_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    requiresConfirmation: tool.requiresConfirmation === true,
    ...(tool.change
      ? { change: { ...tool.change, logFields: tool.change.logFields.map(field => ({ ...field })) } }
      : {}),
  })),
);

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface PlandayChange {
  readonly tool: string;
  readonly action: PlandayChangeAction;
  readonly record: PlandayChangeRecord;
  readonly movesMoney: false;
  readonly requiresConfirmation: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export type PlandayChangeResolution =
  | { readonly ok: true; readonly change: PlandayChange }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change before the call runs: the action, the record kind and the values of
 * the tool's `logFields`: Planday ids, dates and times in clear, never a
 * name or a comment. A field of type `pseudonym` would come back only as
 * HMAC-SHA-256 with `options.pseudonymKey` (else SHA-256). Refuses
 * read tools, unknown tools and invalid input, as callTool does.
 */
export function resolvePlandayChange(
  toolName: string,
  input: GatewayJsonObject = {},
  options: { pseudonymKey?: string | Uint8Array; redactor?: SecretRedactor } = {},
): PlandayChangeResolution {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
  if (!tool) return { ok: false, reason: 'Unsupported Planday gateway tool.' };
  if (!tool.change) return { ok: false, reason: `${stripPrefix(tool.name)} is not a write tool.` };
  const valid = validateCall(tool, input);
  if (!valid.ok) return { ok: false, reason: `Invalid input for ${stripPrefix(tool.name)}.` };
  const data = valid.data;
  const values: Record<string, string | number | boolean> = {};
  for (const field of tool.change.logFields) {
    const value = logFieldValue(field.type, data[field.name], options.pseudonymKey);
    if (value === undefined) continue;
    // A secret put in a field by mistake never reaches the host's log: with an instance's redactor, a value that
    // holds a piece of its token is left out.
    if (options.redactor && leaksSecret(String(value), options.redactor)) continue;
    values[field.name] = value;
  }
  return {
    ok: true,
    change: Object.freeze({
      tool: stripPrefix(tool.name),
      action: tool.change.action,
      record: tool.change.record,
      movesMoney: false as const,
      requiresConfirmation: tool.requiresConfirmation === true,
      values: Object.freeze(values),
    }),
  };
}

function requiredClientId(options: PlandayGatewayOptions): string {
  const value: unknown = (options as Partial<PlandayGatewayOptions> | undefined)?.clientId;
  // The client id is not a secret, but it is sent in a header: printable ASCII only.
  if (typeof value !== 'string' || !/^[!-~]{1,200}$/.test(value.trim())) {
    throw new ConfigError('createPlandayGateway requires options.clientId. Embedded instances do not read credentials from the environment.');
  }
  return value.trim();
}

function requiredCredential(options: PlandayGatewayOptions, name: 'refreshToken'): string {
  const value: unknown = (options as Partial<PlandayGatewayOptions> | undefined)?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createPlandayGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new ConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/**
 * Create one gateway instance for one Planday portal. `clientId` and
 * `refreshToken` are required and are the only credentials the instance
 * uses; a missing value fails here.
 */
export function createPlandayGateway(options: PlandayGatewayOptions) {
  let refreshToken: string | undefined;
  // The host's pseudonym key, in every form it could be written, read before anything else can fail.
  const pseudonymForms = keyForms((options as Partial<PlandayGatewayOptions> | undefined)?.policy?.pseudonymKey);
  const guard = new SecretRedactor();
  // What the host gave, admitted or not: every error is masked against it, the pseudonym key included.
  const given: unknown = (options as Partial<PlandayGatewayOptions> | undefined)?.refreshToken;
  const secrets = [...(typeof given === 'string' ? [given, given.trim()] : []), ...pseudonymForms];
  const refusal = () => keyRefusedText(refreshToken ?? '');
  try {
    // Every secret is known to the guard before any validation that can throw, and inside the try: whatever
    // happens while registering it leaves as the sealed error below.
    for (const form of pseudonymForms) guard.addSecret(form);
    // The pseudonym key is admitted like the refresh token: as text, printable and sharing no piece with any text
    // of ours, so no fixed text (a fallback, an error, the tool list) can carry a piece of it; as bytes, every
    // form of it that is printable text (the bytes read as text, hex, base64) the same way.
    const pseudonymKey: unknown = (options as Partial<PlandayGatewayOptions> | undefined)?.policy?.pseudonymKey;
    const refused =
      typeof pseudonymKey === 'string'
        ? !admitsKey(pseudonymKey)
        : pseudonymForms.some(form => /^[ -~]+$/.test(form) && !admitsKey(form));
    if (refused) throw new ConfigError(PSEUDONYM_KEY_REFUSED);
    // Admission of the refresh token, before a redactor is built from it.
    refreshToken = requiredCredential(options, 'refreshToken');
    guard.addSecret(refreshToken);
    const clientId = requiredClientId(options);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of a key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(refusal());
    }
    const gateway = buildGateway(options, clientId, refreshToken);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(refusal());
    }
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Redacted, then checked whole as the very last step: a message that still holds a piece of a key becomes the
    // fixed refusal.
    let message = guard.redact(raw);
    if (leaksSecret(message, guard)) message = refusal();
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against every key. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(refusal()), ...secrets);
    }
    throw final;
  }
}

const PSEUDONYM_KEY_REFUSED =
  'policy.pseudonymKey was refused: use at least 32 random printable characters (for example 32 random bytes as hex) or at least 32 random bytes.';

/** A key given as text or bytes, in every form it could be written: as given, or as the bytes read or encoded. */
function keyForms(key: unknown): string[] {
  if (typeof key === 'string') return key === '' ? [] : [...new Set([key, key.trim()])];
  if (key instanceof Uint8Array) {
    const bytes = Buffer.from(key);
    return [...new Set(['utf8', 'latin1', 'hex', 'base64', 'base64url'].map(form => bytes.toString(form as BufferEncoding)))];
  }
  return [];
}

/** Register a key given as text or bytes, in every form it could be written. */
function addKeyMaterial(redactor: SecretRedactor, key: string | Uint8Array): void {
  for (const form of keyForms(key)) redactor.addSecret(form);
}

function buildGateway(options: PlandayGatewayOptions, clientId: string, refreshToken: string) {
  const { policy: hostPolicy, ...clientOptions } = options;
  const policy =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, PLANDAY_TOOLS.map(tool => tool.name));
  if (policy === undefined) {
    // In a scope of its own: a gateway created from inside another instance's call (its audit sink or its fetch)
    // validates against the environment, never against that instance's policy.
    runInCallScope({}, () => validateStartupConfig());
  }
  const client = new PlandayClient({
    ...clientOptions,
    clientId,
    refreshToken,
    credentialEnv: {},
    // Under a host's policy nothing is read from the environment, this switch included.
    ...(policy ? { allowCustomBaseUrl: clientOptions.allowCustomBaseUrl ?? false } : {}),
  });
  const redactor: SecretRedactor = client.redactor;
  // The host's pseudonym key is a secret like the refresh token: kept out of results, logs and errors.
  if (policy?.pseudonymKey !== undefined) addKeyMaterial(redactor, policy.pseudonymKey);
  // Every call in a scope of its own, with or without a host policy: a call made from inside another
  // instance's call (its audit sink or its fetch) never runs under that instance's policy, sink or redactor.
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);

  return {
    /**
     * resolvePlandayChange bound to this instance: a value that holds a piece of
     * this instance's token is left out of the values.
     */
    resolveChange(toolName: string, input: GatewayJsonObject = {}, resolveOptions: { pseudonymKey?: string | Uint8Array } = {}) {
      return resolvePlandayChange(toolName, input, { ...resolveOptions, redactor });
    },
    /** Tools enabled on this instance (the policy's or PLANDAY_DISABLED_TOOLS' disabled tools are left out). */
    tools: underPolicy(() => plandayGatewayTools.filter(tool => !isToolDisabled(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted: upstream data can echo the key, and so can an error. Redacted first, as data and depth-limited, and
      // only then copied as JSON, so no key is serialised and no deep value can exhaust the stack.
      return underPolicy(() =>
        runCall(toolName, input, context).then(
          // A second pass covers what the first one inserted (the depth placeholder). Then the sink check, as the very
          // last step: a result that holds a piece of the key anywhere, outer fields included, is withheld whole.
          result => {
            // The data also goes into the text, built from this final, redacted copy, so the sink check covers it.
            const final = withDataInText(
              withFailureInForm(
                JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
              ),
            );
            return leaksSecret(final, redactor) ? withheldResult() : final;
          },
        ),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? toolName.trim() : '';
      const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        await auditRejectedCall(String(toolName), input, 'unknown_tool', context);
        return errorResult('Unsupported Planday gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool.name, input, 'invalid_input', context);
        return errorResult(redactor.redact(reason));
      }

      const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
      const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor), failureMetadata(error));
    }
  }
}

/** One gateway instance, as returned by createPlandayGateway. */
export type PlandayGateway = ReturnType<typeof createPlandayGateway>;

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

/**
 * The redacted data, also as compact JSON in the text block after the summary, as the MCP spec asks of a tool
 * that returns structured content: many clients read only the text. Built from the final, redacted copy, so the
 * text holds exactly `structuredContent` and nothing more. Error results have no data and are left as they are.
 */
function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  const summary = first?.text ?? '';
  return {
    ...result,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}
