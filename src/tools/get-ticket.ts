import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { TicketService } from "../freshdesk/ticket-service.js";
import { errorResult, okResult, READ_ONLY_ANNOTATIONS, UNTRUSTED_CONTENT_HINT } from "./common.js";

export const getTicketInput = {
  ticket_id: z.number().int().positive().describe("The Freshdesk ticket ID (the number shown as #123 in Freshdesk)."),
  include_requester: z
    .boolean()
    .optional()
    .describe("Also return the requester's name, email, phone and mobile. Costs one extra Freshdesk API call; only set when needed. Default: false."),
};

export const GET_TICKET_DESCRIPTION =
  "Get one Freshdesk ticket by ID with full details: subject, plain-text description, status, priority, source, type, tags, assignee/group IDs, due dates, escalation flags, custom fields, CC/To emails and attachment metadata (names and sizes only). " +
  "Set include_requester=true to also get the requester's contact details. " +
  "Does not return the conversation thread (replies and notes). Archived tickets (closed and inactive for a long time) are not available and return not_found." +
  UNTRUSTED_CONTENT_HINT;

export function registerGetTicket(server: McpServer, service: TicketService, logger: Logger): void {
  server.registerTool(
    "get_ticket",
    {
      title: "Get a Freshdesk ticket",
      description: GET_TICKET_DESCRIPTION,
      inputSchema: getTicketInput,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Get a Freshdesk ticket" },
    },
    async (args) => {
      try {
        const ticket = await service.getTicket(args.ticket_id, { includeRequester: args.include_requester ?? false });
        return okResult({ ticket });
      } catch (err) {
        return errorResult(err, logger, "get_ticket");
      }
    },
  );
}
