import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invalidInput } from "../errors.js";
import type { Logger } from "../logger.js";
import { PRIORITY_CODES, STATUS_CODES } from "../freshdesk/mappers.js";
import type { SearchCriteria } from "../freshdesk/query-builder.js";
import { SEARCH_MAX_PAGE, type TicketService } from "../freshdesk/ticket-service.js";
import { errorResult, okResult, READ_ONLY_ANNOTATIONS, UNTRUSTED_CONTENT_HINT } from "./common.js";

const dateField = (what: string) =>
  z.string().optional().describe(`${what} (inclusive), as YYYY-MM-DD in UTC.`);

export const searchTicketsInput = {
  status: z
    .array(z.union([z.enum(["open", "pending", "resolved", "closed"]), z.number().int().positive()]))
    .min(1)
    .max(10)
    .optional()
    .describe("Match any of these statuses. Use names ('open', 'pending', 'resolved', 'closed') or numeric codes for custom statuses (e.g. 6)."),
  priority: z
    .array(z.enum(["low", "medium", "high", "urgent"]))
    .min(1)
    .max(4)
    .optional()
    .describe("Match any of these priorities."),
  agent_id: z.number().int().positive().optional().describe("Only tickets assigned to this agent ID."),
  unassigned: z.boolean().optional().describe("Set true for tickets with no assigned agent. Cannot be combined with agent_id."),
  group_id: z.number().int().positive().optional().describe("Only tickets assigned to this group ID."),
  tag: z.string().max(100).optional().describe("Only tickets with this tag (exact match). Quotes and backslashes are not allowed."),
  type: z.string().max(100).optional().describe("Only tickets of this type, e.g. 'Question', 'Problem', 'Incident' (exact match)."),
  created_from: dateField("Created on or after this date"),
  created_to: dateField("Created on or before this date"),
  updated_from: dateField("Updated on or after this date"),
  updated_to: dateField("Updated on or before this date"),
  due_from: dateField("Resolution due on or after this date"),
  due_to: dateField("Resolution due on or before this date"),
  page: z.number().int().min(1).max(SEARCH_MAX_PAGE).optional().describe("Page number 1-10 (30 results per page). Default: 1."),
};

export const SEARCH_TICKETS_DESCRIPTION =
  "Search Freshdesk tickets by structured field filters: status, priority, assigned agent (or unassigned), group, tag, type, and created/updated/due date ranges. " +
  "All provided filters must match (AND); multiple values within status or priority match any (OR). At least one filter is required. " +
  "Limitations: this is NOT free-text search (it cannot search subject or description text); it cannot filter by requester or company (use list_tickets); dates are day-level only; " +
  "results are 30 per page, at most 10 pages (300 results), returned with a total count; archived tickets are excluded; very recent changes may take a few minutes to appear. " +
  "Returns ticket summaries; call get_ticket for full details." +
  UNTRUSTED_CONTENT_HINT;

type SearchArgs = {
  [K in keyof typeof searchTicketsInput]?: z.infer<(typeof searchTicketsInput)[K]>;
};

export function toSearchCriteria(args: SearchArgs): SearchCriteria {
  const status = args.status?.map((s) => {
    if (typeof s === "number") return s;
    const code = STATUS_CODES[s];
    if (code === undefined) throw invalidInput(`Unknown status "${s}".`);
    return code;
  });
  const priority = args.priority?.map((p) => {
    const code = PRIORITY_CODES[p];
    if (code === undefined) throw invalidInput(`Unknown priority "${p}".`);
    return code;
  });
  return {
    status,
    priority,
    agentId: args.agent_id,
    unassigned: args.unassigned || undefined,
    groupId: args.group_id,
    tag: args.tag,
    type: args.type,
    createdFrom: args.created_from,
    createdTo: args.created_to,
    updatedFrom: args.updated_from,
    updatedTo: args.updated_to,
    dueFrom: args.due_from,
    dueTo: args.due_to,
  };
}

export function registerSearchTickets(server: McpServer, service: TicketService, logger: Logger): void {
  server.registerTool(
    "search_tickets",
    {
      title: "Search Freshdesk tickets",
      description: SEARCH_TICKETS_DESCRIPTION,
      inputSchema: searchTicketsInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Search Freshdesk tickets" },
    },
    async (args) => {
      try {
        const result = await service.searchTickets(toSearchCriteria(args), args.page ?? 1);
        return okResult(result);
      } catch (err) {
        return errorResult(err, logger, "search_tickets");
      }
    },
  );
}
