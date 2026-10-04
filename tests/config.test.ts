import { describe, expect, it } from "vitest";
import { loadConfig, normalizeDomain } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";

describe("normalizeDomain", () => {
  it.each([
    ["acme", "acme.freshdesk.com"],
    ["ACME.freshdesk.com", "acme.freshdesk.com"],
    ["https://acme.freshdesk.com/", "acme.freshdesk.com"],
    ["my-team-1", "my-team-1.freshdesk.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(["support.acme.com", "acme.freshdesk.com/api", "-bad", "a b", "", "evil.com#.freshdesk.com"])(
    "rejects %s",
    (input) => {
      expect(() => normalizeDomain(input)).toThrow(ConnectorError);
    },
  );
});

describe("loadConfig", () => {
  it("builds live config with defaults", () => {
    const cfg = loadConfig({ FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k" });
    expect(cfg).toMatchObject({
      mock: false,
      host: "acme.freshdesk.com",
      baseUrl: "https://acme.freshdesk.com/api/v2",
      apiKey: "k",
      timeoutMs: 15000,
      maxRetries: 2,
      maxRetryWaitMs: 30000,
      logLevel: "info",
    });
  });

  it("requires domain and API key outside mock mode", () => {
    expect(() => loadConfig({})).toThrow(/FRESHDESK_DOMAIN, FRESHDESK_API_KEY/);
  });

  it("does not require credentials in mock mode (env or --mock flag)", () => {
    expect(loadConfig({ FRESHDESK_MOCK: "true" }).mock).toBe(true);
    expect(loadConfig({}, ["--mock"]).mock).toBe(true);
  });

  it("rejects invalid numeric settings", () => {
    expect(() =>
      loadConfig({ FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k", FRESHDESK_MAX_RETRIES: "abc" }),
    ).toThrow(/FRESHDESK_MAX_RETRIES/);
    expect(() =>
      loadConfig({ FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k", FRESHDESK_TIMEOUT_MS: "10" }),
    ).toThrow(/FRESHDESK_TIMEOUT_MS/);
  });

  it("never includes the API key in error messages", () => {
    try {
      loadConfig({ FRESHDESK_DOMAIN: "not a domain", FRESHDESK_API_KEY: "super-secret-key" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-key");
    }
  });
});
