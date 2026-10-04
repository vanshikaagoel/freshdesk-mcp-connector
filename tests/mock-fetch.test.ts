import { describe, expect, it } from "vitest";
import { createMockFetch } from "../src/mock/mock-fetch.js";
import { buildMockTickets, MOCK_CONTACTS } from "../src/mock/fixtures.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const BASE = "https://mock.freshdesk.com/api/v2";
const fetchMock = createMockFetch({ now: () => NOW });
const get = (path: string) => fetchMock(`${BASE}${path}`, { method: "GET" });

describe("synthetic fixtures", () => {
  it("contain no real-looking personal domains", () => {
    for (const c of MOCK_CONTACTS) expect(c.email).toMatch(/@example\.(com|org)$/);
  });

  it("include tickets older than 30 days to exercise the default window", () => {
    const old = buildMockTickets(NOW).filter((r) => Date.parse(r.ticket.created_at!) < NOW.getTime() - 30 * 86_400_000);
    expect(old.length).toBeGreaterThan(0);
  });
});

describe("mock Freshdesk API", () => {
  it("lists only tickets from the last 30 days by default, as a JSON array without descriptions", async () => {
    const res = await get("/tickets?per_page=100");
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    const cutoff = NOW.getTime() - 30 * 86_400_000;
    expect(body.every((t) => Date.parse(t.created_at as string) >= cutoff)).toBe(true);
    expect(body[0]).not.toHaveProperty("description");
    expect(res.headers.get("x-ratelimit-total")).toBe("50");
  });

  it("returns older tickets with updated_since", async () => {
    const all = (await (await get("/tickets?per_page=100&updated_since=2020-01-01")).json()) as unknown[];
    const recent = (await (await get("/tickets?per_page=100")).json()) as unknown[];
    expect(all.length).toBeGreaterThan(recent.length);
  });

  it("sets a link header when there is a next page", async () => {
    const res = await get("/tickets?per_page=5&page=1");
    expect(res.headers.get("link")).toMatch(/page=2>;rel="next"$/);
  });

  it("returns 404 for unknown tickets and embeds requester on request", async () => {
    expect((await get("/tickets/99999")).status).toBe(404);
    const t = (await (await get("/tickets/5?include=requester")).json()) as { requester?: { email: string } };
    expect(t.requester?.email).toBe("priya.sharma@example.com");
  });

  it("supports the search query subset and returns { total, results }", async () => {
    const q = encodeURIComponent('"(priority:3 OR priority:4) AND status:2"');
    const body = (await (await get(`/search/tickets?query=${q}`)).json()) as { total: number; results: Array<{ priority: number; status: number }> };
    expect(body.total).toBeGreaterThan(0);
    expect(body.results.every((t) => t.status === 2 && t.priority >= 3)).toBe(true);
  });

  it("rejects unquoted queries and page > 10 like the real API", async () => {
    expect((await get(`/search/tickets?query=${encodeURIComponent("status:2")}`)).status).toBe(400);
    expect((await get(`/search/tickets?query=${encodeURIComponent('"status:2"')}&page=11`)).status).toBe(400);
  });

  it("refuses non-GET methods", async () => {
    expect((await fetchMock(`${BASE}/tickets`, { method: "POST" })).status).toBe(405);
  });
});
