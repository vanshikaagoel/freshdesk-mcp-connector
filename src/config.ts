import { z } from "zod";
import { ConnectorError } from "./errors.js";
import type { LogLevel } from "./logger.js";

export interface AppConfig {
  mock: boolean;
  /** e.g. https://acme.freshdesk.com/api/v2 (mock mode uses a placeholder domain). */
  baseUrl: string;
  /** Hostname without scheme, e.g. acme.freshdesk.com. */
  host: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryWaitMs: number;
  logLevel: LogLevel;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MOCK_HOST = "mock.freshdesk.com";
const MOCK_API_KEY = "mock-api-key";

const booleanString = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => ["true", "false", "1", "0", "yes", "no", ""].includes(v), "must be true or false")
  .transform((v) => ["true", "1", "yes"].includes(v));

const intString = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  FRESHDESK_MOCK: booleanString.optional(),
  FRESHDESK_DOMAIN: z.string().trim().optional(),
  FRESHDESK_API_KEY: z.string().trim().optional(),
  FRESHDESK_TIMEOUT_MS: intString(1_000, 120_000).optional(),
  FRESHDESK_MAX_RETRIES: intString(0, 5).optional(),
  FRESHDESK_MAX_RETRY_WAIT_MS: intString(0, 300_000).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
});

/**
 * Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com/" and returns
 * "acme.freshdesk.com". The Freshdesk API only works on *.freshdesk.com hosts, not custom CNAMEs.
 */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (value.endsWith(".freshdesk.com")) {
    value = value.slice(0, -".freshdesk.com".length);
  }
  if (!SUBDOMAIN.test(value)) {
    throw new ConnectorError(
      "config",
      `FRESHDESK_DOMAIN "${input}" is not valid. Use your Freshdesk subdomain, e.g. "acme" or "acme.freshdesk.com". Custom domains are not supported by the Freshdesk API.`,
    );
  }
  return `${value}.freshdesk.com`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConnectorError("config", `Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const mock = argv.includes("--mock") || e.FRESHDESK_MOCK === true;

  const common = {
    timeoutMs: e.FRESHDESK_TIMEOUT_MS ?? 15_000,
    maxRetries: e.FRESHDESK_MAX_RETRIES ?? 2,
    maxRetryWaitMs: e.FRESHDESK_MAX_RETRY_WAIT_MS ?? 30_000,
    logLevel: e.LOG_LEVEL ?? "info",
  };

  if (mock) {
    return { mock, host: MOCK_HOST, baseUrl: `https://${MOCK_HOST}/api/v2`, apiKey: MOCK_API_KEY, ...common };
  }

  const missing = [
    !e.FRESHDESK_DOMAIN ? "FRESHDESK_DOMAIN" : null,
    !e.FRESHDESK_API_KEY ? "FRESHDESK_API_KEY" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConnectorError(
      "config",
      `Missing required environment variable(s): ${missing.join(", ")}. Set them in .env, or run with FRESHDESK_MOCK=true to use synthetic data.`,
    );
  }

  const host = normalizeDomain(e.FRESHDESK_DOMAIN!);
  return { mock, host, baseUrl: `https://${host}/api/v2`, apiKey: e.FRESHDESK_API_KEY!, ...common };
}
