#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ConnectorError } from "./errors.js";
import { createLogger } from "./logger.js";

// quiet: dotenv must not print to stdout, which carries MCP JSON-RPC traffic.
loadDotenv({ quiet: true });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const { service, server } = buildApp(config, logger);

  if (config.mock) {
    logger.info("starting in MOCK mode with synthetic data; no Freshdesk requests will be made");
  } else {
    try {
      const { agentId } = await service.verifyCredentials();
      logger.info("verified Freshdesk credentials", { host: config.host, agentId });
    } catch (err) {
      const message = err instanceof ConnectorError ? err.message : "Unexpected error while verifying credentials.";
      logger.error("startup credential check failed", { host: config.host, message });
      process.exit(1);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("freshdesk MCP server running on stdio");

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
