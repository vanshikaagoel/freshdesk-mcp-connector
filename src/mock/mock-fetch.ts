import type { FetchLike } from "../freshdesk/client.js";
import type { RawTicket } from "../freshdesk/types.js";
import { buildMockTickets, MOCK_AGENT_ID, MOCK_WATCHED_TICKET_IDS, type MockTicketRecord } from "./fixtures.js";

/**
 * In-process stand-in for the Freshdesk v2 API, used in mock mode and tests.
 * It mirrors the documented response shapes (list = JSON array + `link` header,
 * search = { total, results }, rate-limit headers, 404/400 errors) over synthetic data.
 * It only understands the subset of the search language that the query builder emits.
 */

const MOCK_RATE_LIMIT_TOTAL = 50; // documented default for trial accounts
const DAY_MS = 86_400_000;
const SEARCH_PAGE_SIZE = 30;

export interface MockFetchOptions {
  now?: () => Date;
}

export function createMockFetch(options: MockFetchOptions = {}): FetchLike {
  const now = options.now ?? (() => new Date());
  let remaining = MOCK_RATE_LIMIT_TOTAL;
  let windowStart = now().getTime();

  return async (input, init) => {
    const t = now().getTime();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      remaining = MOCK_RATE_LIMIT_TOTAL;
    }
    remaining = Math.max(0, remaining - 1);
    const rl = {
      "X-Ratelimit-Total": String(MOCK_RATE_LIMIT_TOTAL),
      "X-Ratelimit-Remaining": String(remaining),
      "X-Ratelimit-Used-CurrentRequest": "1",
    };

    if ((init.method ?? "GET").toUpperCase() !== "GET") return json({ code: "method_not_allowed" }, 405, rl);

    const url = new URL(input);
    const path = url.pathname.replace(/\/+$/, "");
    const records = buildMockTickets(now());

    if (path === "/api/v2/agents/me") {
      return json({ id: MOCK_AGENT_ID, available: true, occasional: false, contact: { name: "Mock Agent", email: "agent@merchant.example.com" } }, 200, rl);
    }
    if (path === "/api/v2/tickets") return listTickets(url, records, now(), rl);
    const view = /^\/api\/v2\/tickets\/(\d+)$/.exec(path);
    if (view) return viewTicket(Number(view[1]), url, records, rl);
    if (path === "/api/v2/search/tickets") return searchTickets(url, records, rl);
    return json({}, 404, rl);
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function validationError(field: string, message: string, rl: Record<string, string>): Response {
  return json({ description: "Validation failed", errors: [{ field, message, code: "invalid_value" }] }, 400, rl);
}

/** List responses omit description fields (accounts created after 2018-11-30 must use include=description). */
function listShape(t: RawTicket): RawTicket {
  const { description: _d, description_text: _dt, attachments: _a, ...rest } = t;
  return rest;
}

/** Search results include `description` (HTML) per the documented sample, but not description_text. */
function searchShape(t: RawTicket): RawTicket {
  const { description_text: _dt, attachments: _a, ...rest } = t;
  return rest;
}

function listTickets(url: URL, records: MockTicketRecord[], now: Date, rl: Record<string, string>): Response {
  const q = url.searchParams;
  const page = Number(q.get("page") ?? "1");
  const perPage = Number(q.get("per_page") ?? "30");
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return validationError("per_page", "Has to be between 1 and 100", rl);
  if (!Number.isInteger(page) || page < 1) return validationError("page", "Has to be greater than 0", rl);

  let tickets = records.map((r) => r.ticket).filter((t) => !t.spam && !t.deleted);

  const filter = q.get("filter");
  if (filter === "new_and_my_open") {
    tickets = tickets.filter((t) => t.status === 2 && (t.responder_id === null || t.responder_id === MOCK_AGENT_ID));
  } else if (filter === "watching") {
    tickets = tickets.filter((t) => MOCK_WATCHED_TICKET_IDS.has(t.id));
  } else if (filter !== null) {
    return validationError("filter", "It should be one of these values: 'new_and_my_open,watching,spam,deleted'", rl);
  }

  const email = q.get("email");
  if (email !== null) {
    const ids = new Set(records.filter((r) => r.requester.email === email).map((r) => r.requester.id));
    tickets = tickets.filter((t) => t.requester_id !== null && t.requester_id !== undefined && ids.has(t.requester_id));
  }
  const requesterId = q.get("requester_id");
  if (requesterId !== null) tickets = tickets.filter((t) => t.requester_id === Number(requesterId));
  const companyId = q.get("company_id");
  if (companyId !== null) tickets = tickets.filter((t) => t.company_id === Number(companyId));

  const updatedSince = q.get("updated_since");
  if (updatedSince !== null) {
    const since = Date.parse(/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(updatedSince) || updatedSince.length === 10 ? updatedSince : `${updatedSince}Z`);
    if (Number.isNaN(since)) return validationError("updated_since", "It should be in the 'valid date' format", rl);
    tickets = tickets.filter((t) => Date.parse(t.updated_at!) >= since);
  } else {
    const cutoff = now.getTime() - 30 * DAY_MS;
    tickets = tickets.filter((t) => Date.parse(t.created_at!) >= cutoff);
  }

  const orderBy = (q.get("order_by") ?? "created_at") as "created_at" | "due_by" | "updated_at" | "status";
  const direction = (q.get("order_type") ?? "desc") === "asc" ? 1 : -1;
  tickets.sort((a, b) => {
    const av = orderBy === "status" ? (a.status ?? 0) : Date.parse(a[orderBy] ?? "");
    const bv = orderBy === "status" ? (b.status ?? 0) : Date.parse(b[orderBy] ?? "");
    return (av - bv) * direction || (a.id - b.id) * direction;
  });

  const start = (page - 1) * perPage;
  const slice = tickets.slice(start, start + perPage).map(listShape);
  const headers = { ...rl };
  if (start + perPage < tickets.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    Object.assign(headers, { link: `<${next.toString()}>;rel="next"` });
  }
  return json(slice, 200, headers);
}

function viewTicket(id: number, url: URL, records: MockTicketRecord[], rl: Record<string, string>): Response {
  const record = records.find((r) => r.ticket.id === id);
  if (!record) return new Response(null, { status: 404, headers: rl });
  const includes = (url.searchParams.get("include") ?? "").split(",").filter(Boolean);
  const body: RawTicket = { ...record.ticket };
  if (includes.includes("requester")) body.requester = record.requester;
  return json(body, 200, { ...rl, "X-Ratelimit-Used-CurrentRequest": String(1 + includes.length) });
}

type Atom = { field: string; op: ":" | ":>" | ":<"; value: string | number | null };

function parseAtom(text: string): Atom | null {
  const m = /^([a-z_]+)(:>|:<|:)(.+)$/.exec(text.trim());
  if (!m) return null;
  const raw = m[3]!.trim();
  let value: Atom["value"];
  if (raw === "null") value = null;
  else if (/^'.*'$/.test(raw)) value = raw.slice(1, -1);
  else if (/^\d+$/.test(raw)) value = Number(raw);
  else return null;
  return { field: m[1]!, op: m[2] as Atom["op"], value };
}

function splitTopLevel(query: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && query.startsWith(separator, i)) {
      parts.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

function matchesAtom(t: RawTicket, a: Atom): boolean {
  const dateFields: Record<string, keyof RawTicket> = { created_at: "created_at", updated_at: "updated_at", due_by: "due_by" };
  if (a.field in dateFields) {
    const day = String(t[dateFields[a.field]!] ?? "").slice(0, 10);
    const v = String(a.value);
    if (a.op === ":>") return day >= v;
    if (a.op === ":<") return day <= v;
    return day === v;
  }
  const actual: unknown =
    a.field === "agent_id" ? t.responder_id
    : a.field === "group_id" ? t.group_id
    : a.field === "status" ? t.status
    : a.field === "priority" ? t.priority
    : a.field === "type" ? t.type
    : a.field === "tag" ? t.tags
    : undefined;
  if (a.field === "tag") {
    const tags = (actual as string[] | null | undefined) ?? [];
    return a.value === null ? tags.length === 0 : tags.includes(String(a.value));
  }
  if (a.value === null) return actual === null || actual === undefined;
  if (typeof a.value === "number" && typeof actual === "number") {
    if (a.op === ":>") return actual >= a.value;
    if (a.op === ":<") return actual <= a.value;
  }
  return actual === a.value;
}

function searchTickets(url: URL, records: MockTicketRecord[], rl: Record<string, string>): Response {
  const rawQuery = url.searchParams.get("query") ?? "";
  if (!/^".*"$/.test(rawQuery) || rawQuery.length > 512) {
    return validationError("query", "Query should be enclosed in double quotes and be at most 512 characters", rl);
  }
  const page = Number(url.searchParams.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > 10) return validationError("page", "Has to be between 1 and 10", rl);

  const groups: Atom[][] = [];
  for (const clause of splitTopLevel(rawQuery.slice(1, -1), " AND ")) {
    const inner = clause.startsWith("(") && clause.endsWith(")") ? clause.slice(1, -1) : clause;
    const atoms = splitTopLevel(inner, " OR ").map(parseAtom);
    if (atoms.some((a) => a === null)) return validationError("query", "Invalid query", rl);
    groups.push(atoms as Atom[]);
  }

  const matched = records
    .map((r) => r.ticket)
    .filter((t) => !t.spam && !t.deleted)
    .filter((t) => groups.every((g) => g.some((a) => matchesAtom(t, a))))
    .sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!));

  const start = (page - 1) * SEARCH_PAGE_SIZE;
  return json({ total: matched.length, results: matched.slice(start, start + SEARCH_PAGE_SIZE).map(searchShape) }, 200, rl);
}
