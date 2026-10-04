import { describe, expect, it } from "vitest";
import { FreshdeskClient, parseNextLink, parseRetryAfter, type FetchLike } from "../src/freshdesk/client.js";
import { ConnectorError } from "../src/errors.js";
import { jsonResponse, noSleep, scriptedFetch, type Responder } from "./helpers.js";

const API_KEY = "test-key-123";

function makeClient(responders: Responder[], overrides: { maxRetries?: number; maxRetryWaitMs?: number } = {}) {
  const { fetch, calls } = scriptedFetch(responders);
  const { sleep, waits } = noSleep();
  const client = new FreshdeskClient({
    baseUrl: "https://acme.freshdesk.com/api/v2/",
    apiKey: API_KEY,
    timeoutMs: 1000,
    maxRetries: overrides.maxRetries ?? 2,
    maxRetryWaitMs: overrides.maxRetryWaitMs ?? 30_000,
    fetchImpl: fetch,
    sleep,
    random: () => 0,
  });
  return { client, calls, waits };
}

async function expectConnectorError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    return err as ConnectorError;
  }
  throw new Error("expected promise to reject");
}

describe("FreshdeskClient.get", () => {
  it("sends Basic auth (apikey:X), Accept header and encoded query params", async () => {
    const { client, calls } = makeClient([jsonResponse([])]);
    await client.get("/tickets", { email: "bat+man@example.com", page: 2, skipped: undefined });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://acme.freshdesk.com/api/v2/tickets?email=bat%2Bman%40example.com&page=2");
    expect(call.init.method).toBe("GET");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${API_KEY}:X`).toString("base64")}`);
    expect(headers.Accept).toBe("application/json");
  });

  it("returns data, rate-limit info and next-page link", async () => {
    const { client } = makeClient([
      jsonResponse([{ id: 1 }], 200, {
        "X-Ratelimit-Total": "700.0",
        "X-Ratelimit-Remaining": "426.0",
        "X-Ratelimit-Used-CurrentRequest": "1",
        link: '<https://acme.freshdesk.com/api/v2/tickets?page=2>;rel="next"',
      }),
    ]);
    const res = await client.get<Array<{ id: number }>>("/tickets");
    expect(res.data).toEqual([{ id: 1 }]);
    expect(res.rateLimit).toEqual({ total: 700, remaining: 426, usedCurrentRequest: 1 });
    expect(res.nextPageUrl).toBe("https://acme.freshdesk.com/api/v2/tickets?page=2");
  });

  it("only ever issues GET requests (no other HTTP methods are exposed)", () => {
    const { client } = makeClient([]);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
    expect(proto.filter((n) => ["post", "put", "patch", "delete", "request"].includes(n.toLowerCase()))).toEqual([]);
  });

  it("waits for Retry-After on 429 and then succeeds", async () => {
    const { client, calls, waits } = makeClient([
      jsonResponse({}, 429, { "Retry-After": "3" }),
      jsonResponse({ id: 7 }),
    ]);
    const res = await client.get<{ id: number }>("/tickets/7");
    expect(res.data.id).toBe(7);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([3000]);
  });

  it("gives up after maxRetries on repeated 429 and reports retry-after", async () => {
    const { client, calls } = makeClient([
      jsonResponse({}, 429, { "Retry-After": "1" }),
      jsonResponse({}, 429, { "Retry-After": "1" }),
      jsonResponse({}, 429, { "Retry-After": "5" }),
    ]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(5);
    expect(err.message).toContain("Retry after 5 seconds");
    expect(calls).toHaveLength(3);
  });

  it("does not wait longer than maxRetryWaitMs; fails fast with retry-after instead", async () => {
    const { client, calls, waits } = makeClient([jsonResponse({}, 429, { "Retry-After": "60" })], {
      maxRetryWaitMs: 30_000,
    });
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(60);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    const { client, waits } = makeClient([jsonResponse({}, 503), jsonResponse({}, 502), jsonResponse({ ok: true })]);
    const res = await client.get<{ ok: boolean }>("/tickets");
    expect(res.data.ok).toBe(true);
    expect(waits).toEqual([500, 1000]);
  });

  it("maps persistent 5xx to an upstream error", async () => {
    const { client } = makeClient([jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse({}, 500)]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("upstream");
    expect(err.status).toBe(500);
  });

  it("retries network errors and maps timeouts", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { client, calls } = makeClient([new TypeError("fetch failed"), timeout, timeout]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("timeout");
    expect(calls).toHaveLength(3);
  });

  it("does not retry 4xx client errors", async () => {
    const { client, calls } = makeClient([jsonResponse({ description: "Validation failed", errors: [] }, 400)]);
    await expectConnectorError(client.get("/tickets"));
    expect(calls).toHaveLength(1);
  });

  it("maps 400 with Freshdesk field errors", async () => {
    const { client } = makeClient([
      jsonResponse(
        {
          description: "Validation failed",
          errors: [{ field: "updated_since", message: "It should be in the 'valid date' format", code: "invalid_value" }],
        },
        400,
      ),
    ]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("validation");
    expect(err.code).toBe("invalid_value");
    expect(err.message).toContain("updated_since: It should be in the 'valid date' format");
  });

  it("maps 401 without leaking the API key", async () => {
    const { client } = makeClient([
      jsonResponse({ code: "invalid_credentials", message: "You have to be logged in to perform this action." }, 401),
    ]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain(Buffer.from(`${API_KEY}:X`).toString("base64"));
  });

  it("maps 403 using the Freshdesk error code", async () => {
    const { client } = makeClient([
      jsonResponse({ errors: [{ code: "require_feature", message: "Feature disabled" }] }, 403),
    ]);
    const err = await expectConnectorError(client.get("/tickets"));
    expect(err.kind).toBe("forbidden");
    expect(err.code).toBe("require_feature");
    expect(err.message).toMatch(/feature/i);
  });

  it("maps 404 and tolerates an empty body", async () => {
    const { client } = makeClient([new Response(null, { status: 404 })]);
    const err = await expectConnectorError(client.get("/tickets/999"));
    expect(err.kind).toBe("not_found");
  });

  it("passes an abort signal so requests can time out", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse([]);
    };
    const client = new FreshdeskClient({
      baseUrl: "https://acme.freshdesk.com/api/v2",
      apiKey: API_KEY,
      timeoutMs: 1000,
      maxRetries: 0,
      maxRetryWaitMs: 0,
      fetchImpl,
    });
    await client.get("/tickets");
  });
});

describe("header parsers", () => {
  it("parses next link", () => {
    expect(parseNextLink('<https://d.freshdesk.com/api/v2/tickets?filter=all_tickets&page=2>;rel="next"')).toBe(
      "https://d.freshdesk.com/api/v2/tickets?filter=all_tickets&page=2",
    );
    expect(parseNextLink("< https://d/x?page=3 >; rel=next")).toBe("https://d/x?page=3");
    expect(parseNextLink(null)).toBeUndefined();
    expect(parseNextLink('<https://d/x?page=1>;rel="prev"')).toBeUndefined();
  });

  it("parses Retry-After seconds", () => {
    expect(parseRetryAfter("34")).toBe(34);
    expect(parseRetryAfter("1.2")).toBe(2);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
