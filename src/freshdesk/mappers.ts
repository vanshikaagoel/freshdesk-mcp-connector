import type { RawAttachment, RawRequester, RawTicket } from "./types.js";

/** Documented default values (Freshdesk API reference, "Ticket Properties"). */
export const STATUS_LABELS: Record<number, string> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };
export const PRIORITY_LABELS: Record<number, string> = { 1: "low", 2: "medium", 3: "high", 4: "urgent" };
export const SOURCE_LABELS: Record<number, string> = {
  1: "email",
  2: "portal",
  3: "phone",
  7: "chat",
  9: "feedback_widget",
  10: "outbound_email",
};

export const STATUS_CODES: Record<string, number> = invert(STATUS_LABELS);
export const PRIORITY_CODES: Record<string, number> = invert(PRIORITY_LABELS);

/** Generous cap so the agent sees the full message in almost all cases, while bounding pathological payloads. */
export const MAX_DESCRIPTION_CHARS = 20_000;

function invert(map: Record<number, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).map(([code, label]) => [label, Number(code)]));
}

export interface CodedValue {
  code: number | null;
  label: string | null;
}

export interface TicketSummary {
  id: number;
  subject: string | null;
  status: CodedValue;
  priority: CodedValue;
  source: CodedValue;
  type: string | null;
  tags: string[];
  requester_id: number | null;
  responder_id: number | null;
  group_id: number | null;
  company_id: number | null;
  product_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  due_by: string | null;
  fr_due_by: string | null;
  is_escalated: boolean | null;
  fr_escalated: boolean | null;
  custom_fields: Record<string, unknown>;
}

export interface AttachmentInfo {
  id: number | null;
  name: string | null;
  content_type: string | null;
  file_size: number | null;
}

export interface RequesterInfo {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface TicketDetail extends TicketSummary {
  description_text: string | null;
  description_truncated: boolean;
  description_length: number;
  cc_emails: string[];
  to_emails: string[];
  spam: boolean | null;
  attachments: AttachmentInfo[];
  /** Present only when requested (costs one extra Freshdesk API credit). */
  requester?: RequesterInfo;
}

function coded(code: number | null | undefined, labels: Record<number, string>, fallback: (c: number) => string): CodedValue {
  if (code === null || code === undefined) return { code: null, label: null };
  return { code, label: labels[code] ?? fallback(code) };
}

export function statusValue(code: number | null | undefined): CodedValue {
  return coded(code, STATUS_LABELS, (c) => `custom_status_${c}`);
}

export function priorityValue(code: number | null | undefined): CodedValue {
  return coded(code, PRIORITY_LABELS, () => "unknown");
}

export function sourceValue(code: number | null | undefined): CodedValue {
  return coded(code, SOURCE_LABELS, () => "other");
}

export function toTicketSummary(t: RawTicket): TicketSummary {
  return {
    id: t.id,
    subject: t.subject ?? null,
    status: statusValue(t.status),
    priority: priorityValue(t.priority),
    source: sourceValue(t.source),
    type: t.type ?? null,
    tags: t.tags ?? [],
    requester_id: t.requester_id ?? null,
    responder_id: t.responder_id ?? null,
    group_id: t.group_id ?? null,
    company_id: t.company_id ?? null,
    product_id: t.product_id ?? null,
    created_at: t.created_at ?? null,
    updated_at: t.updated_at ?? null,
    due_by: t.due_by ?? null,
    fr_due_by: t.fr_due_by ?? null,
    is_escalated: t.is_escalated ?? null,
    fr_escalated: t.fr_escalated ?? null,
    custom_fields: t.custom_fields ?? {},
  };
}

function toAttachment(a: RawAttachment): AttachmentInfo {
  // attachment_url is intentionally omitted: it is a direct download link to file content.
  return {
    id: a.id ?? null,
    name: a.name ?? null,
    content_type: a.content_type ?? null,
    file_size: a.file_size ?? null,
  };
}

function toRequester(r: RawRequester): RequesterInfo {
  return { id: r.id, name: r.name ?? null, email: r.email ?? null, phone: r.phone ?? null, mobile: r.mobile ?? null };
}

export function toTicketDetail(t: RawTicket, maxChars = MAX_DESCRIPTION_CHARS): TicketDetail {
  const fullText = t.description_text ?? (t.description ? htmlToText(t.description) : null);
  const length = fullText?.length ?? 0;
  const truncated = length > maxChars;
  const detail: TicketDetail = {
    ...toTicketSummary(t),
    description_text: fullText === null ? null : truncated ? fullText.slice(0, maxChars) : fullText,
    description_truncated: truncated,
    description_length: length,
    cc_emails: t.cc_emails ?? [],
    to_emails: t.to_emails ?? [],
    spam: t.spam ?? null,
    attachments: (t.attachments ?? []).map(toAttachment),
  };
  if (t.requester) detail.requester = toRequester(t.requester);
  return detail;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Fallback used only when Freshdesk does not provide description_text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
