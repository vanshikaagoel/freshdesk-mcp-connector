import { invalidInput } from "../errors.js";
import type { FreshdeskClient } from "./client.js";
import { toTicketDetail, toTicketSummary, type TicketDetail, type TicketSummary } from "./mappers.js";
import { buildSearchQuery, type SearchCriteria } from "./query-builder.js";
import type { RawAgentMe, RawSearchResponse, RawTicket } from "./types.js";

export const LIST_FILTERS = ["new_and_my_open", "watching"] as const;
export const LIST_ORDER_BY = ["created_at", "due_by", "updated_at", "status"] as const;
export const ORDER_TYPES = ["asc", "desc"] as const;

/** Documented limits. */
export const LIST_MAX_PER_PAGE = 100;
export const LIST_MAX_PAGE = 300;
export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_MAX_PAGE = 10;

export interface ListTicketsParams {
  filter?: (typeof LIST_FILTERS)[number];
  requesterEmail?: string;
  requesterId?: number;
  companyId?: number;
  updatedSince?: string;
  orderBy?: (typeof LIST_ORDER_BY)[number];
  orderType?: (typeof ORDER_TYPES)[number];
  page?: number;
  perPage?: number;
}

export interface ListTicketsResult {
  tickets: TicketSummary[];
  page: number;
  per_page: number;
  has_more: boolean;
  notes: string[];
}

export interface SearchTicketsResult {
  tickets: TicketSummary[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
  notes: string[];
}

export interface GetTicketOptions {
  includeRequester?: boolean;
}

/** Date input formats listed in the Freshdesk API reference ("Schema > Date Fields"). */
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

const LIST_WINDOW_NOTE =
  "Without updated_since, Freshdesk only returns tickets created in the last 30 days. Spam and deleted tickets are excluded.";
const SEARCH_NOTES = [
  "Search results exclude archived tickets.",
  "Recently changed tickets can take a few minutes to appear in search results.",
  `Search returns at most ${SEARCH_PAGE_SIZE * SEARCH_MAX_PAGE} results (${SEARCH_MAX_PAGE} pages of ${SEARCH_PAGE_SIZE}).`,
];

function checkRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidInput(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

export class TicketService {
  constructor(private readonly client: FreshdeskClient) {}

  /** Cheap authenticated call used as a startup credential check. */
  async verifyCredentials(): Promise<{ agentId: number }> {
    const res = await this.client.get<RawAgentMe>("/agents/me");
    return { agentId: res.data.id };
  }

  async listTickets(params: ListTicketsParams = {}): Promise<ListTicketsResult> {
    const page = checkRange("page", params.page ?? 1, 1, LIST_MAX_PAGE);
    const perPage = checkRange("per_page", params.perPage ?? 30, 1, LIST_MAX_PER_PAGE);

    // The docs do not state whether these filters can be combined, so only one is allowed at a time.
    const selectors = {
      filter: params.filter,
      requester_email: params.requesterEmail,
      requester_id: params.requesterId,
      company_id: params.companyId,
      updated_since: params.updatedSince,
    };
    const used = Object.entries(selectors).filter(([, v]) => v !== undefined).map(([k]) => k);
    if (used.length > 1) {
      throw invalidInput(`Use only one of filter, requester_email, requester_id, company_id, updated_since (got: ${used.join(", ")}).`);
    }
    if (params.filter !== undefined && !LIST_FILTERS.includes(params.filter)) {
      throw invalidInput(`filter must be one of: ${LIST_FILTERS.join(", ")}.`);
    }
    if (params.requesterId !== undefined) checkRange("requester_id", params.requesterId, 1, Number.MAX_SAFE_INTEGER);
    if (params.companyId !== undefined) checkRange("company_id", params.companyId, 1, Number.MAX_SAFE_INTEGER);
    if (params.requesterEmail !== undefined && !/^[^\s@]+@[^\s@]+$/.test(params.requesterEmail)) {
      throw invalidInput("requester_email must be a valid email address.");
    }
    if (params.updatedSince !== undefined && (!DATE_INPUT.test(params.updatedSince) || Number.isNaN(Date.parse(params.updatedSince)))) {
      throw invalidInput("updated_since must be a date like 2026-10-01 or 2026-10-01T09:30:00Z.");
    }

    const res = await this.client.get<RawTicket[]>("/tickets", {
      filter: params.filter,
      email: params.requesterEmail,
      requester_id: params.requesterId,
      company_id: params.companyId,
      updated_since: params.updatedSince,
      order_by: params.orderBy,
      order_type: params.orderType,
      page,
      per_page: perPage,
    });

    const raw = Array.isArray(res.data) ? res.data : [];
    return {
      tickets: raw.map(toTicketSummary),
      page,
      per_page: perPage,
      has_more: res.nextPageUrl !== undefined && page < LIST_MAX_PAGE,
      notes: params.updatedSince === undefined ? [LIST_WINDOW_NOTE] : [],
    };
  }

  async getTicket(ticketId: number, options: GetTicketOptions = {}): Promise<TicketDetail> {
    checkRange("ticket_id", ticketId, 1, Number.MAX_SAFE_INTEGER);
    const res = await this.client.get<RawTicket>(`/tickets/${ticketId}`, {
      include: options.includeRequester ? "requester" : undefined,
    });
    return toTicketDetail(res.data);
  }

  async searchTickets(criteria: SearchCriteria, pageInput = 1): Promise<SearchTicketsResult> {
    const page = checkRange("page", pageInput, 1, SEARCH_MAX_PAGE);
    const query = buildSearchQuery(criteria);
    const res = await this.client.get<RawSearchResponse>("/search/tickets", { query, page });
    const total = typeof res.data?.total === "number" ? res.data.total : 0;
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    return {
      tickets: results.map(toTicketSummary),
      total,
      page,
      per_page: SEARCH_PAGE_SIZE,
      has_more: page < SEARCH_MAX_PAGE && page * SEARCH_PAGE_SIZE < total,
      notes: SEARCH_NOTES,
    };
  }
}
