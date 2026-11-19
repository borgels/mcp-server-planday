import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlandayClient, type PlandayClientOptions } from './planday/client.js';
import { registerTools } from './tools/planday.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: PlandayClient;
  clientOptions?: PlandayClientOptions;
}

let defaultClient: PlandayClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): PlandayClient {
  defaultClient ??= new PlandayClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'planday',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new PlandayClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
