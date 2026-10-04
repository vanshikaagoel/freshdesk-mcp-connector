import type { AppConfig } from "./config.js";
import { FreshdeskClient, type FetchLike } from "./freshdesk/client.js";
import { TicketService } from "./freshdesk/ticket-service.js";
import type { Logger } from "./logger.js";
import { createMockFetch } from "./mock/mock-fetch.js";
import { createServer } from "./server.js";

/** Wires config -> HTTP client -> ticket service -> MCP server. Mock mode swaps only the fetch implementation. */
export function buildApp(config: AppConfig, logger: Logger, fetchImpl?: FetchLike) {
  const client = new FreshdeskClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxRetryWaitMs: config.maxRetryWaitMs,
    fetchImpl: fetchImpl ?? (config.mock ? createMockFetch() : undefined),
    logger,
  });
  const service = new TicketService(client);
  const server = createServer(service, logger);
  return { client, service, server };
}
