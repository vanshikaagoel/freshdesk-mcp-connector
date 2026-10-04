import { ConnectorError, type FreshdeskFieldError } from "../errors.js";
import { silentLogger, type Logger } from "../logger.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | undefined;

export interface RateLimitInfo {
  total?: number;
  remaining?: number;
  usedCurrentRequest?: number;
}

export interface FreshdeskResponse<T> {
  data: T;
  status: number;
  rateLimit: RateLimitInfo;
  /** Absolute URL of the next page, from the `link` header (list endpoints only). */
  nextPageUrl?: string;
}

export interface FreshdeskClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  /** Upper bound on total time spent waiting between retries for a single call. */
  maxRetryWaitMs: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Logger;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const BASE_BACKOFF_MS = 500;

/**
 * Minimal Freshdesk v2 REST client. It deliberately exposes only `get`: Freshdesk API keys
 * carry the full permissions of their agent, so read-only behaviour is enforced here.
 */
export class FreshdeskClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly opts: Required<Omit<FreshdeskClientOptions, "baseUrl" | "apiKey">>;

  constructor(options: FreshdeskClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${options.apiKey}:X`).toString("base64")}`;
    this.opts = {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      maxRetryWaitMs: options.maxRetryWaitMs,
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      logger: options.logger ?? silentLogger,
    };
  }

  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<FreshdeskResponse<T>> {
    const url = this.buildUrl(path, query);
    const logPath = path;
    let waitedMs = 0;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.opts.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: this.authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        const failure = isTimeout
          ? new ConnectorError("timeout", `Freshdesk did not respond within ${this.opts.timeoutMs} ms.`, { cause: err })
          : new ConnectorError("network", "Could not reach Freshdesk. Check network connectivity and FRESHDESK_DOMAIN.", {
              cause: err,
            });
        const delay = this.backoffMs(attempt);
        if (attempt < this.opts.maxRetries && waitedMs + delay <= this.opts.maxRetryWaitMs) {
          this.opts.logger.warn("freshdesk request failed, retrying", { path: logPath, kind: failure.kind, attempt, delayMs: delay });
          waitedMs += delay;
          await this.opts.sleep(delay);
          continue;
        }
        throw failure;
      }

      const rateLimit = parseRateLimit(response.headers);
      this.logRateLimit(logPath, response.status, rateLimit);

      if (response.ok) {
        const data = (await response.json()) as T;
        return {
          data,
          status: response.status,
          rateLimit,
          nextPageUrl: parseNextLink(response.headers.get("link")),
        };
      }

      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const delay = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : this.backoffMs(attempt);
        if (attempt < this.opts.maxRetries && waitedMs + delay <= this.opts.maxRetryWaitMs) {
          this.opts.logger.warn("freshdesk rate limit hit, waiting before retry", { path: logPath, attempt, delayMs: delay });
          waitedMs += delay;
          await this.opts.sleep(delay);
          continue;
        }
        await discardBody(response);
        throw new ConnectorError(
          "rate_limited",
          retryAfterSeconds !== undefined
            ? `Freshdesk API rate limit reached. Retry after ${retryAfterSeconds} seconds.`
            : "Freshdesk API rate limit reached. Retry later.",
          { status: 429, retryAfterSeconds },
        );
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        const delay = this.backoffMs(attempt);
        if (attempt < this.opts.maxRetries && waitedMs + delay <= this.opts.maxRetryWaitMs) {
          this.opts.logger.warn("freshdesk server error, retrying", { path: logPath, status: response.status, attempt, delayMs: delay });
          await discardBody(response);
          waitedMs += delay;
          await this.opts.sleep(delay);
          continue;
        }
      }

      throw await toConnectorError(response);
    }
  }

  private buildUrl(path: string, query: Record<string, QueryValue>): string {
    if (!path.startsWith("/")) throw new Error(`path must start with "/": ${path}`);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private backoffMs(attempt: number): number {
    const base = BASE_BACKOFF_MS * 2 ** attempt;
    return Math.round(base + this.opts.random() * base * 0.5);
  }

  private logRateLimit(path: string, status: number, rl: RateLimitInfo): void {
    const meta = { path, status, ...rl };
    if (rl.total !== undefined && rl.remaining !== undefined && rl.remaining <= Math.max(1, rl.total * 0.1)) {
      this.opts.logger.warn("freshdesk rate limit nearly exhausted", meta);
    } else {
      this.opts.logger.debug("freshdesk response", meta);
    }
  }
}

function toNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  return {
    total: toNumber(headers.get("x-ratelimit-total")),
    remaining: toNumber(headers.get("x-ratelimit-remaining")),
    usedCurrentRequest: toNumber(headers.get("x-ratelimit-used-currentrequest")),
  };
}

export function parseRetryAfter(value: string | null): number | undefined {
  const n = toNumber(value);
  return n !== undefined && n >= 0 ? Math.ceil(n) : undefined;
}

/** Extracts the rel="next" URL from a `link` header such as `<https://x/api/v2/tickets?page=2>;rel="next"`. */
export function parseNextLink(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(",")) {
    const match = part.match(/<\s*([^>]+?)\s*>\s*;\s*rel\s*=\s*"?next"?/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

interface FreshdeskErrorBody {
  description?: string;
  errors?: FreshdeskFieldError[];
}

async function readErrorBody(response: Response): Promise<FreshdeskErrorBody> {
  try {
    const text = await response.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FreshdeskErrorBody) : {};
  } catch {
    return {};
  }
}

const FORBIDDEN_MESSAGES: Record<string, string> = {
  access_denied: "The Freshdesk agent behind this API key is not allowed to perform this action.",
  require_feature: "This action requires a Freshdesk feature that is not enabled on this account.",
  account_suspended: "The Freshdesk account is suspended.",
  password_lockout: "The Freshdesk agent has reached the maximum number of failed login attempts.",
  password_expired: "The Freshdesk agent's password has expired.",
  max_agents_reached: "The Freshdesk account has reached its maximum number of agents.",
};

export async function toConnectorError(response: Response): Promise<ConnectorError> {
  const body = await readErrorBody(response);
  const fieldErrors = Array.isArray(body.errors) ? body.errors : undefined;
  const code = fieldErrors?.find((e) => e.code)?.code;
  const status = response.status;

  switch (status) {
    case 400: {
      const details = (fieldErrors ?? [])
        .map((e) => [e.field, e.message].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ");
      return new ConnectorError(
        "validation",
        `Freshdesk rejected the request as invalid${details ? `: ${details}` : body.description ? `: ${body.description}` : "."}`,
        { status, code, fieldErrors },
      );
    }
    case 401:
      return new ConnectorError(
        "auth",
        "Freshdesk authentication failed. Check that FRESHDESK_API_KEY is correct and belongs to an active agent.",
        { status, code },
      );
    case 403:
      return new ConnectorError(
        "forbidden",
        (code && FORBIDDEN_MESSAGES[code]) ?? "Access denied by Freshdesk for this API key.",
        { status, code },
      );
    case 404:
      return new ConnectorError(
        "not_found",
        "Freshdesk returned 404 Not Found: the requested resource does not exist (or FRESHDESK_DOMAIN is wrong).",
        { status, code },
      );
    default:
      return new ConnectorError(
        "upstream",
        status >= 500
          ? `Freshdesk is currently unavailable (HTTP ${status}). Try again later.`
          : `Unexpected response from Freshdesk (HTTP ${status}).`,
        { status, code },
      );
  }
}
