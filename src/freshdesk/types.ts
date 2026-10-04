/** Raw Freshdesk v2 shapes, limited to fields documented in the API reference. Blank fields arrive as null. */

export interface RawAttachment {
  id?: number;
  name?: string | null;
  content_type?: string | null;
  file_size?: number | null;
  attachment_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Returned by `include=requester`. */
export interface RawRequester {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

export interface RawTicket {
  id: number;
  subject?: string | null;
  status?: number | null;
  priority?: number | null;
  source?: number | null;
  type?: string | null;
  tags?: string[] | null;
  requester_id?: number | null;
  responder_id?: number | null;
  group_id?: number | null;
  company_id?: number | null;
  product_id?: number | null;
  email_config_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  due_by?: string | null;
  fr_due_by?: string | null;
  is_escalated?: boolean | null;
  fr_escalated?: boolean | null;
  spam?: boolean | null;
  deleted?: boolean | null;
  cc_emails?: string[] | null;
  fwd_emails?: string[] | null;
  reply_cc_emails?: string[] | null;
  to_emails?: string[] | null;
  description?: string | null;
  description_text?: string | null;
  custom_fields?: Record<string, unknown> | null;
  attachments?: RawAttachment[] | null;
  requester?: RawRequester | null;
}

/** GET /api/v2/search/tickets response body. */
export interface RawSearchResponse {
  total: number;
  results: RawTicket[];
}

/** GET /api/v2/agents/me (only the fields we read). */
export interface RawAgentMe {
  id: number;
}
