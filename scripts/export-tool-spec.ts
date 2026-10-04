import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createMockFetch } from "../src/mock/mock-fetch.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/server.js";
import { errorSchema, exampleRequests, outputSchemas, staticExamples } from "./tool-spec-extras.js";

/**
 * Writes docs/tool-spec.json from the live tool registrations (names, descriptions, input schemas,
 * annotations), merged with documented output schemas and examples generated against mock mode.
 */
const EXAMPLE_CLOCK = new Date("2026-10-04T12:00:00Z");

const { server } = buildApp(
  loadConfig({ FRESHDESK_MOCK: "true" }),
  silentLogger,
  createMockFetch({ now: () => EXAMPLE_CLOCK }),
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "spec-exporter", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
const documented = [];
for (const tool of tools) {
  const examples = [];
  for (const req of exampleRequests[tool.name] ?? []) {
    const res = (await client.callTool({ name: tool.name, arguments: req.arguments })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    examples.push({
      title: req.title,
      arguments: req.arguments,
      isError: res.isError ?? false,
      response: JSON.parse(res.content[0]!.text) as unknown,
    });
  }
  examples.push(...(staticExamples[tool.name] ?? []));
  documented.push({ ...tool, outputSchema: outputSchemas[tool.name], errorSchema, examples });
}

const spec = {
  server: { name: SERVER_NAME, version: SERVER_VERSION, transport: "stdio" },
  instructions: client.getInstructions(),
  responseFormat:
    "Each tool returns one text content item containing a JSON object. On success it matches the tool's outputSchema; on failure isError=true and it matches errorSchema. outputSchema is documentation: the server does not emit MCP structuredContent.",
  examplesNote: `Examples are generated from mock mode (synthetic data) with the clock fixed at ${EXAMPLE_CLOCK.toISOString()}.`,
  tools: documented,
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "tool-spec.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
await client.close();
await server.close();
process.stdout.write(`Wrote ${tools.length} tool definitions to ${out}\n`);
