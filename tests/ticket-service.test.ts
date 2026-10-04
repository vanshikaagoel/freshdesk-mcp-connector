import { describe, expect, it } from "vitest";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { TicketService } from "../src/freshdesk/ticket-service.js";
import { ConnectorError } from "../src/errors.js";
import { jsonResponse, noSleep, scriptedFetch, type Responder } from "./helpers.js";

function makeService(responders: Responder[]) {
  const { fetch, calls } = scriptedFetch(responders);
  const client = new FreshdeskClient({
    baseUrl: "https://acme.freshdesk.com/api/v2",
    apiKey: "k",
    timeoutMs: 1000,
    maxRetries: 0,
    maxRetryWaitMs: 0,
    fetchImpl: fetch,
    sleep: noSleep().sleep,
  });
  return { service: new TicketService(client), calls };
}

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

const ticket = (id: number, extra: Record<string, unknown> = {}) => ({ id, subject: `T${id}`, status: 2, priority: 1, source: 1, ...extra });

describe("TicketService.listTickets", () => {
  it("calls GET /tickets with defaults and reports the 30-day window", async () => {
    const { service, calls } = makeService([jsonResponse([ticket(1), ticket(2)])]);
    const res = await service.listTickets();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v2/tickets");
    expect(Object.fromEntries(query(calls[0]!.url))).toEqual({ page: "1", per_page: "30" });
    expect(res.tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(res.has_more).toBe(false);
    expect(res.notes.join(" ")).toMatch(/last 30 days/);
  });

  it("maps parameters to documented query names", async () => {
    const { service, calls } = makeService([jsonResponse([])]);
    await service.listTickets({ requesterEmail: "a+b@x.com", orderBy: "updated_at", orderType: "asc", page: 2, perPage: 100 });
    expect(Object.fromEntries(query(calls[0]!.url))).toEqual({
      email: "a+b@x.com",
      order_by: "updated_at",
      order_type: "asc",
      page: "2",
      per_page: "100",
    });
  });

  it("sets has_more from the link header", async () => {
    const { service } = makeService([
      jsonResponse([ticket(1)], 200, { link: '<https://acme.freshdesk.com/api/v2/tickets?page=2>;rel="next"' }),
    ]);
    expect((await service.listTickets()).has_more).toBe(true);
  });

  it("omits the 30-day note when updated_since is given", async () => {
    const { service, calls } = makeService([jsonResponse([])]);
    const res = await service.listTickets({ updatedSince: "2026-01-01" });
    expect(query(calls[0]!.url).get("updated_since")).toBe("2026-01-01");
    expect(res.notes).toEqual([]);
  });

  it.each([
    [{ requesterEmail: "a@x.com", companyId: 3 }, /Use only one/],
    [{ perPage: 101 }, /per_page/],
    [{ page: 0 }, /page/],
    [{ page: 301 }, /page/],
    [{ requesterEmail: "not-an-email" }, /valid email/],
    [{ updatedSince: "last week" }, /updated_since/],
    [{ updatedSince: "2026-13-45" }, /updated_since/],
    [{ filter: "deleted" as never }, /filter must be one of/],
  ])("rejects invalid input %j without calling Freshdesk", async (params, message) => {
    const { service, calls } = makeService([]);
    await expect(service.listTickets(params)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });
});

describe("TicketService.getTicket", () => {
  it("does not request embeds by default (1 API credit)", async () => {
    const { service, calls } = makeService([jsonResponse(ticket(20, { description_text: "Hello" }))]);
    const t = await service.getTicket(20);
    expect(calls[0]!.url).toBe("https://acme.freshdesk.com/api/v2/tickets/20");
    expect(t.description_text).toBe("Hello");
    expect(t.requester).toBeUndefined();
  });

  it("embeds requester only when asked", async () => {
    const { service, calls } = makeService([
      jsonResponse(ticket(20, { requester: { id: 1, name: "Rachel", email: "r@example.com", phone: null, mobile: null } })),
    ]);
    const t = await service.getTicket(20, { includeRequester: true });
    expect(query(calls[0]!.url).get("include")).toBe("requester");
    expect(t.requester?.name).toBe("Rachel");
  });

  it("propagates 404 as not_found", async () => {
    const { service } = makeService([new Response(null, { status: 404 })]);
    await expect(service.getTicket(999)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects invalid ids locally", async () => {
    const { service, calls } = makeService([]);
    await expect(service.getTicket(0)).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });
});

describe("TicketService.searchTickets", () => {
  it("sends the built query and computes pagination from total", async () => {
    const { service, calls } = makeService([
      jsonResponse({ total: 49, results: Array.from({ length: 30 }, (_, i) => ticket(i + 1)) }),
    ]);
    const res = await service.searchTickets({ status: [2], priority: [3, 4] });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v2/search/tickets");
    expect(query(calls[0]!.url).get("query")).toBe('"status:2 AND (priority:3 OR priority:4)"');
    expect(query(calls[0]!.url).get("page")).toBe("1");
    expect(res).toMatchObject({ total: 49, page: 1, per_page: 30, has_more: true });
    expect(res.tickets).toHaveLength(30);
  });

  it("has_more is false on the last page and never beyond page 10", async () => {
    const { service } = makeService([
      jsonResponse({ total: 49, results: [] }),
      jsonResponse({ total: 1000, results: [] }),
    ]);
    expect((await service.searchTickets({ status: [2] }, 2)).has_more).toBe(false);
    expect((await service.searchTickets({ status: [2] }, 10)).has_more).toBe(false);
  });

  it("rejects page > 10 and empty criteria before calling Freshdesk", async () => {
    const { service, calls } = makeService([]);
    await expect(service.searchTickets({ status: [2] }, 11)).rejects.toThrow(/page/);
    await expect(service.searchTickets({})).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });
});

describe("TicketService.verifyCredentials", () => {
  it("calls /agents/me", async () => {
    const { service, calls } = makeService([jsonResponse({ id: 42 })]);
    expect(await service.verifyCredentials()).toEqual({ agentId: 42 });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v2/agents/me");
  });
});
