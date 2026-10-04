import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createMockFetch } from "../src/mock/mock-fetch.js";
import type { FetchLike } from "../src/freshdesk/client.js";
import { jsonResponse } from "./helpers.js";

const NOW = new Date("2026-10-04T12:00:00Z");

async function connect(fetchImpl: FetchLike) {
  const config = { ...loadConfig({ FRESHDESK_MOCK: "true" }), maxRetries: 0 };
  const { server } = buildApp(config, silentLogger, fetchImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: res.isError ?? false, body: JSON.parse(res.content[0]!.text) as Record<string, any> };
}

describe("MCP server (mock Freshdesk)", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const c = await connect(createMockFetch({ now: () => NOW }));
    client = c.client;
    close = async () => {
      await c.client.close();
      await c.server.close();
    };
  });
  afterEach(async () => close());

  it("exposes exactly the three read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_ticket", "list_tickets", "search_tickets"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description).toMatch(/untrusted/i);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("list_tickets returns normalized summaries, pagination and the 30-day note", async () => {
    const { isError, body } = await call(client, "list_tickets", { per_page: 5 });
    expect(isError).toBe(false);
    expect(body.content_notice).toMatch(/untrusted/i);
    expect(body.tickets).toHaveLength(5);
    expect(body.has_more).toBe(true);
    expect(body.notes[0]).toMatch(/30 days/);
    const t = body.tickets[0];
    expect(t.status).toHaveProperty("label");
    expect(t).not.toHaveProperty("description_text");
  });

  it("list_tickets filters by requester email", async () => {
    const { body } = await call(client, "list_tickets", { requester_email: "priya.sharma@example.com" });
    expect(body.tickets.length).toBeGreaterThan(0);
    expect(body.tickets.every((t: any) => t.requester_id === 5001)).toBe(true);
  });

  it("list_tickets rejects combined selectors with a clear error", async () => {
    const { isError, body } = await call(client, "list_tickets", { requester_id: 5001, company_id: 3001 });
    expect(isError).toBe(true);
    expect(body.error).toBe("invalid_input");
  });

  it("get_ticket returns details; requester only when requested", async () => {
    const plain = await call(client, "get_ticket", { ticket_id: 5 });
    expect(plain.isError).toBe(false);
    expect(plain.body.ticket.description_text).toMatch(/charged/);
    expect(plain.body.ticket.requester).toBeUndefined();
    expect(plain.body.ticket.attachments[0]).toEqual({
      id: expect.any(Number),
      name: "bank-statement.pdf",
      content_type: "application/pdf",
      file_size: 182044,
    });

    const withRequester = await call(client, "get_ticket", { ticket_id: 5, include_requester: true });
    expect(withRequester.body.ticket.requester.name).toBe("Priya Sharma");
  });

  it("get_ticket maps 404 to not_found", async () => {
    const { isError, body } = await call(client, "get_ticket", { ticket_id: 99999 });
    expect(isError).toBe(true);
    expect(body.error).toBe("not_found");
  });

  it("search_tickets translates structured filters", async () => {
    const { isError, body } = await call(client, "search_tickets", { status: ["open"], priority: ["urgent", "high"] });
    expect(isError).toBe(false);
    expect(body.total).toBeGreaterThan(0);
    expect(body.tickets.every((t: any) => t.status.label === "open" && ["urgent", "high"].includes(t.priority.label))).toBe(true);
    expect(body.per_page).toBe(30);
  });

  it("search_tickets supports unassigned, tag and custom status codes", async () => {
    const unassigned = await call(client, "search_tickets", { unassigned: true });
    expect(unassigned.body.tickets.every((t: any) => t.responder_id === null)).toBe(true);

    const vip = await call(client, "search_tickets", { tag: "vip" });
    expect(vip.body.tickets.every((t: any) => t.tags.includes("vip"))).toBe(true);

    const custom = await call(client, "search_tickets", { status: [6] });
    expect(custom.body.tickets.length).toBeGreaterThan(0);
    expect(custom.body.tickets.every((t: any) => t.status.label === "custom_status_6")).toBe(true);
  });

  it("search_tickets supports date ranges", async () => {
    const { body } = await call(client, "search_tickets", { created_from: "2026-10-01", created_to: "2026-10-04" });
    expect(body.tickets.length).toBeGreaterThan(0);
    expect(body.tickets.every((t: any) => t.created_at.slice(0, 10) >= "2026-10-01")).toBe(true);
  });

  it("search_tickets rejects empty or unsafe input without hitting Freshdesk", async () => {
    expect((await call(client, "search_tickets", {})).body.error).toBe("invalid_input");
    expect((await call(client, "search_tickets", { tag: "x' OR status:2" })).body.error).toBe("invalid_input");
  });

  it("rejects schema-invalid arguments", async () => {
    const res = (await client.callTool({ name: "get_ticket", arguments: { ticket_id: "abc" } })) as ToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("MCP server error surfacing", () => {
  it("returns a rate_limited error with retry_after_seconds", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 429, { "Retry-After": "42" });
    const { client, server } = await connect(fetchImpl);
    const { isError, body } = await call(client, "get_ticket", { ticket_id: 1 });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: "rate_limited", retry_after_seconds: 42 });
    await client.close();
    await server.close();
  });

  it("returns an auth error without leaking credentials", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ code: "invalid_credentials" }, 401);
    const { client, server } = await connect(fetchImpl);
    const res = (await client.callTool({ name: "list_tickets", arguments: {} })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('"auth"');
    expect(res.content[0]!.text).not.toContain("mock-api-key");
    await client.close();
    await server.close();
  });
});
