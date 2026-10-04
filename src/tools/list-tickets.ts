import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "../logger.js";
import {
  LIST_FILTERS,
  LIST_MAX_PAGE,
  LIST_MAX_PER_PAGE,
  LIST_ORDER_BY,
  ORDER_TYPES,
  type TicketService,
} from "../freshdesk/ticket-service.js";
import { errorResult, okResult, READ_ONLY_ANNOTATIONS, UNTRUSTED_CONTENT_HINT } from "./common.js";

export const listTicketsInput = {
  filter: z
    .enum(LIST_FILTERS)
    .optional()
    .describe("Predefined view: 'new_and_my_open' (new tickets and open tickets assigned to the API agent) or 'watching'."),
  requester_email: z.string().optional().describe("Only tickets raised by this requester email."),
  requester_id: z.number().int().positive().optional().describe("Only tickets raised by this requester (contact) ID."),
  company_id: z.number().int().positive().optional().describe("Only tickets belonging to this company ID."),
  updated_since: z
    .string()
    .optional()
    .describe("Only tickets updated at or after this time, e.g. '2026-09-01' or '2026-09-01T09:30:00Z' (UTC if no zone). Needed to see tickets created more than 30 days ago."),
  order_by: z.enum(LIST_ORDER_BY).optional().describe("Sort field. Default: created_at."),
  order_type: z.enum(ORDER_TYPES).optional().describe("Sort direction. Default: desc."),
  page: z.number().int().min(1).max(LIST_MAX_PAGE).optional().describe("Page number, starting at 1. Default: 1."),
  per_page: z.number().int().min(1).max(LIST_MAX_PER_PAGE).optional().describe("Tickets per page (1-100). Default: 30."),
};

export const LIST_TICKETS_DESCRIPTION =
  "List Freshdesk tickets, newest first by default. Use this to browse recent tickets, or to find tickets for a specific requester (email or ID) or company. " +
  "By default Freshdesk only returns tickets CREATED IN THE LAST 30 DAYS; pass updated_since to reach older tickets. Spam and deleted tickets are excluded. " +
  "Only ONE of filter, requester_email, requester_id, company_id, updated_since may be used per call. " +
  "Returns ticket summaries (no description); call get_ticket for the full ticket. Use has_more and page to paginate. " +
  "For filtering by status, priority, assignee, group, tag, type or date ranges, use search_tickets instead." +
  UNTRUSTED_CONTENT_HINT;

export function registerListTickets(server: McpServer, service: TicketService, logger: Logger): void {
  server.registerTool(
    "list_tickets",
    {
      title: "List Freshdesk tickets",
      description: LIST_TICKETS_DESCRIPTION,
      inputSchema: listTicketsInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "List Freshdesk tickets" },
    },
    async (args) => {
      try {
        const result = await service.listTickets({
          filter: args.filter,
          requesterEmail: args.requester_email,
          requesterId: args.requester_id,
          companyId: args.company_id,
          updatedSince: args.updated_since,
          orderBy: args.order_by,
          orderType: args.order_type,
          page: args.page,
          perPage: args.per_page,
        });
        return okResult(result);
      } catch (err) {
        return errorResult(err, logger, "list_tickets");
      }
    },
  );
}
