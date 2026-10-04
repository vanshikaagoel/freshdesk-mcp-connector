import { invalidInput } from "../errors.js";

/**
 * Structured search criteria. Translated into Freshdesk's Filter Tickets query language
 * (GET /api/v2/search/tickets?query="..."). The agent never sees the query syntax.
 */
export interface SearchCriteria {
  status?: number[];
  priority?: number[];
  agentId?: number;
  unassigned?: boolean;
  groupId?: number;
  tag?: string;
  type?: string;
  /** Inclusive date bounds, YYYY-MM-DD (UTC). */
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  dueFrom?: string;
  dueTo?: string;
}

/** Documented limit for the query string, which must be wrapped in double quotes. */
export const MAX_QUERY_LENGTH = 512;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Quote/escape rules for string values are not documented, so characters that could break quoting are rejected. */
const UNSAFE_STRING = /['"\\]/;

function isRealDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw invalidInput(`${name} must be a positive integer.`);
  return value;
}

function quotedString(name: string, value: string): string {
  const v = value.trim();
  if (!v) throw invalidInput(`${name} must not be empty.`);
  if (UNSAFE_STRING.test(v)) throw invalidInput(`${name} must not contain quotes or backslashes.`);
  return `'${v}'`;
}

function anyOf(field: string, values: number[]): string {
  const unique = [...new Set(values.map((v) => positiveInt(field, v)))];
  const clauses = unique.map((v) => `${field}:${v}`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
}

function dateRange(field: string, label: string, from?: string, to?: string): string[] {
  for (const [name, v] of [
    [`${label}_from`, from],
    [`${label}_to`, to],
  ] as const) {
    if (v !== undefined && !isRealDate(v)) throw invalidInput(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  if (from && to && from > to) throw invalidInput(`${label}_from must be on or before ${label}_to.`);
  const out: string[] = [];
  if (from) out.push(`${field}:>'${from}'`);
  if (to) out.push(`${field}:<'${to}'`);
  return out;
}

/**
 * Returns the full query parameter value, including the surrounding double quotes,
 * e.g. `"(status:2 OR status:3) AND priority:4"`.
 */
export function buildSearchQuery(c: SearchCriteria): string {
  const clauses: string[] = [];

  if (c.status?.length) clauses.push(anyOf("status", c.status));
  if (c.priority?.length) {
    for (const p of c.priority) {
      if (!Number.isInteger(p) || p < 1 || p > 4) throw invalidInput("priority must be between 1 (low) and 4 (urgent).");
    }
    clauses.push(anyOf("priority", c.priority));
  }

  if (c.unassigned && c.agentId !== undefined) {
    throw invalidInput("Use either agent_id or unassigned, not both.");
  }
  if (c.unassigned) clauses.push("agent_id:null");
  if (c.agentId !== undefined) clauses.push(`agent_id:${positiveInt("agent_id", c.agentId)}`);
  if (c.groupId !== undefined) clauses.push(`group_id:${positiveInt("group_id", c.groupId)}`);
  if (c.tag !== undefined) clauses.push(`tag:${quotedString("tag", c.tag)}`);
  if (c.type !== undefined) clauses.push(`type:${quotedString("type", c.type)}`);

  clauses.push(...dateRange("created_at", "created", c.createdFrom, c.createdTo));
  clauses.push(...dateRange("updated_at", "updated", c.updatedFrom, c.updatedTo));
  clauses.push(...dateRange("due_by", "due", c.dueFrom, c.dueTo));

  if (clauses.length === 0) {
    throw invalidInput("Provide at least one search filter (e.g. status, priority, agent_id, tag, or a date range).");
  }

  const query = `"${clauses.join(" AND ")}"`;
  if (query.length > MAX_QUERY_LENGTH) {
    throw invalidInput(`Search is too complex: the Freshdesk query would be ${query.length} characters (max ${MAX_QUERY_LENGTH}). Use fewer filters.`);
  }
  return query;
}
