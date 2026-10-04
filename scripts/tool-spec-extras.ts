/**
 * Documentation-only additions merged into docs/tool-spec.json by export-tool-spec.ts.
 * `outputSchema` describes the JSON object the server serializes into `content[0].text`
 * (the server does not emit MCP `structuredContent`).
 */

const nullableInt = { type: ["integer", "null"] };
const nullableString = { type: ["string", "null"] };
const nullableBool = { type: ["boolean", "null"] };
const timestamp = { type: ["string", "null"], description: "UTC, YYYY-MM-DDTHH:MM:SSZ" };

const codedValue = (labels: string) => ({
  type: "object",
  description: `Numeric Freshdesk code plus label. ${labels}`,
  properties: { code: nullableInt, label: nullableString },
  required: ["code", "label"],
});

const ticketSummaryProperties = {
  id: { type: "integer" },
  subject: nullableString,
  status: codedValue("Labels: open, pending, resolved, closed; other codes -> custom_status_<code>."),
  priority: codedValue("Labels: low, medium, high, urgent; other codes -> unknown."),
  source: codedValue("Labels: email, portal, phone, chat, feedback_widget, outbound_email; other codes -> other."),
  type: nullableString,
  tags: { type: "array", items: { type: "string" } },
  requester_id: nullableInt,
  responder_id: { ...nullableInt, description: "Assigned agent ID (null = unassigned)." },
  group_id: nullableInt,
  company_id: nullableInt,
  product_id: nullableInt,
  created_at: timestamp,
  updated_at: timestamp,
  due_by: timestamp,
  fr_due_by: { ...timestamp, description: "First-response due time (UTC)." },
  is_escalated: nullableBool,
  fr_escalated: nullableBool,
  custom_fields: { type: "object", additionalProperties: true },
};

const ticketSummary = {
  type: "object",
  properties: ticketSummaryProperties,
  required: Object.keys(ticketSummaryProperties),
};

const ticketDetailProperties = {
  ...ticketSummaryProperties,
  description_text: { ...nullableString, description: "Plain-text description, cut only beyond 20,000 characters." },
  description_truncated: { type: "boolean" },
  description_length: { type: "integer", description: "Length of the full description before any truncation." },
  cc_emails: { type: "array", items: { type: "string" } },
  to_emails: { type: "array", items: { type: "string" } },
  spam: nullableBool,
  attachments: {
    type: "array",
    description: "Metadata only; download URLs are omitted.",
    items: {
      type: "object",
      properties: { id: nullableInt, name: nullableString, content_type: nullableString, file_size: nullableInt },
      required: ["id", "name", "content_type", "file_size"],
    },
  },
  requester: {
    type: "object",
    description: "Present only when include_requester=true.",
    properties: { id: { type: "integer" }, name: nullableString, email: nullableString, phone: nullableString, mobile: nullableString },
    required: ["id", "name", "email", "phone", "mobile"],
  },
};

const contentNotice = {
  type: "string",
  description: "Reminder that ticket content is untrusted customer input. Present on every successful response.",
};
const notes = { type: "array", items: { type: "string" }, description: "Caveats about the result set (e.g. the 30-day list window)." };

export const errorSchema = {
  type: "object",
  description: "Returned with isError=true.",
  properties: {
    error: {
      type: "string",
      enum: ["invalid_input", "validation", "auth", "forbidden", "not_found", "rate_limited", "upstream", "timeout", "network", "internal"],
    },
    message: { type: "string", description: "Human-readable explanation; never contains credentials." },
    retry_after_seconds: { type: "integer", description: "Only for rate_limited: wait this long before retrying." },
  },
  required: ["error", "message"],
};

export const outputSchemas: Record<string, object> = {
  list_tickets: {
    type: "object",
    properties: {
      content_notice: contentNotice,
      tickets: { type: "array", items: ticketSummary },
      page: { type: "integer" },
      per_page: { type: "integer" },
      has_more: { type: "boolean", description: "True when Freshdesk returned a rel=\"next\" link header." },
      notes,
    },
    required: ["content_notice", "tickets", "page", "per_page", "has_more", "notes"],
  },
  get_ticket: {
    type: "object",
    properties: {
      content_notice: contentNotice,
      ticket: { type: "object", properties: ticketDetailProperties, required: Object.keys(ticketDetailProperties).filter((k) => k !== "requester") },
    },
    required: ["content_notice", "ticket"],
  },
  search_tickets: {
    type: "object",
    properties: {
      content_notice: contentNotice,
      tickets: { type: "array", items: ticketSummary },
      total: { type: "integer", description: "Total matches reported by Freshdesk (results beyond 300 are not reachable)." },
      page: { type: "integer" },
      per_page: { type: "integer", const: 30 },
      has_more: { type: "boolean" },
      notes,
    },
    required: ["content_notice", "tickets", "total", "page", "per_page", "has_more", "notes"],
  },
};

/** Requests used to generate example responses against mock mode (synthetic data, fixed clock). */
export const exampleRequests: Record<string, Array<{ title: string; arguments: Record<string, unknown> }>> = {
  list_tickets: [{ title: "Two most recent tickets", arguments: { per_page: 2 } }],
  get_ticket: [
    { title: "Ticket with requester details", arguments: { ticket_id: 5, include_requester: true } },
    { title: "Unknown ticket (error)", arguments: { ticket_id: 99999 } },
  ],
  search_tickets: [
    { title: "Urgent open tickets", arguments: { status: ["open"], priority: ["urgent"] } },
    { title: "Unsafe tag value (error, rejected locally)", arguments: { tag: "vip' OR status:2" } },
  ],
};

/** Static example for an error that mock mode cannot produce. */
export const staticExamples: Record<string, Array<{ title: string; arguments: Record<string, unknown>; isError: boolean; response: object }>> = {
  list_tickets: [
    {
      title: "Freshdesk rate limit reached and Retry-After exceeds the retry budget (error)",
      arguments: {},
      isError: true,
      response: { error: "rate_limited", message: "Freshdesk API rate limit reached. Retry after 42 seconds.", retry_after_seconds: 42 },
    },
  ],
};
