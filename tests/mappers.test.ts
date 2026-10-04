import { describe, expect, it } from "vitest";
import {
  htmlToText,
  priorityValue,
  sourceValue,
  statusValue,
  toTicketDetail,
  toTicketSummary,
} from "../src/freshdesk/mappers.js";
import type { RawTicket } from "../src/freshdesk/types.js";

/** Shape taken from the "View a Ticket" sample response in the Freshdesk API reference. */
const docSample: RawTicket = {
  cc_emails: ["user@cc.com"],
  fwd_emails: [],
  reply_cc_emails: ["user@cc.com"],
  email_config_id: null,
  fr_escalated: false,
  group_id: null,
  priority: 1,
  requester_id: 1,
  responder_id: null,
  source: 2,
  spam: false,
  status: 2,
  subject: "",
  company_id: 1,
  id: 20,
  type: null,
  to_emails: null,
  product_id: null,
  created_at: "2015-08-24T11:56:51Z",
  updated_at: "2015-08-24T11:59:05Z",
  due_by: "2015-08-27T11:30:00Z",
  fr_due_by: "2015-08-25T11:30:00Z",
  is_escalated: false,
  description_text: "Not given.",
  description: "<div>Not given.</div>",
  custom_fields: { category: "Primary" },
  tags: [],
  attachments: [],
};

describe("coded values", () => {
  it("labels documented status, priority and source codes", () => {
    expect(statusValue(2)).toEqual({ code: 2, label: "open" });
    expect(statusValue(5)).toEqual({ code: 5, label: "closed" });
    expect(priorityValue(4)).toEqual({ code: 4, label: "urgent" });
    expect(sourceValue(7)).toEqual({ code: 7, label: "chat" });
  });

  it("preserves unknown/custom codes instead of dropping them", () => {
    expect(statusValue(6)).toEqual({ code: 6, label: "custom_status_6" });
    expect(sourceValue(5)).toEqual({ code: 5, label: "other" });
    expect(priorityValue(9)).toEqual({ code: 9, label: "unknown" });
  });

  it("handles null", () => {
    expect(statusValue(null)).toEqual({ code: null, label: null });
  });
});

describe("toTicketSummary", () => {
  it("normalizes the documented sample", () => {
    expect(toTicketSummary(docSample)).toEqual({
      id: 20,
      subject: "",
      status: { code: 2, label: "open" },
      priority: { code: 1, label: "low" },
      source: { code: 2, label: "portal" },
      type: null,
      tags: [],
      requester_id: 1,
      responder_id: null,
      group_id: null,
      company_id: 1,
      product_id: null,
      created_at: "2015-08-24T11:56:51Z",
      updated_at: "2015-08-24T11:59:05Z",
      due_by: "2015-08-27T11:30:00Z",
      fr_due_by: "2015-08-25T11:30:00Z",
      is_escalated: false,
      fr_escalated: false,
      custom_fields: { category: "Primary" },
    });
  });

  it("does not include description in summaries", () => {
    expect(toTicketSummary(docSample)).not.toHaveProperty("description_text");
  });

  it("fills safe defaults for missing fields", () => {
    const s = toTicketSummary({ id: 1 });
    expect(s.tags).toEqual([]);
    expect(s.custom_fields).toEqual({});
    expect(s.subject).toBeNull();
  });
});

describe("toTicketDetail", () => {
  it("prefers Freshdesk's description_text", () => {
    const d = toTicketDetail(docSample);
    expect(d.description_text).toBe("Not given.");
    expect(d.description_truncated).toBe(false);
    expect(d.description_length).toBe(10);
    expect(d.cc_emails).toEqual(["user@cc.com"]);
    expect(d.to_emails).toEqual([]);
    expect(d).not.toHaveProperty("requester");
    expect(d).not.toHaveProperty("description");
  });

  it("falls back to stripping HTML when description_text is missing", () => {
    const d = toTicketDetail({ id: 1, description: "<div>Hello<br>World &amp; co</div>" });
    expect(d.description_text).toBe("Hello\nWorld & co");
  });

  it("only truncates very long descriptions and reports it", () => {
    const d = toTicketDetail({ id: 1, description_text: "a".repeat(25) }, 10);
    expect(d.description_text).toBe("a".repeat(10));
    expect(d.description_truncated).toBe(true);
    expect(d.description_length).toBe(25);
  });

  it("includes requester details only when embedded", () => {
    const d = toTicketDetail({
      ...docSample,
      requester: { email: "test@test.com", id: 1, mobile: null, name: "Rachel", phone: null },
    });
    expect(d.requester).toEqual({ id: 1, name: "Rachel", email: "test@test.com", phone: null, mobile: null });
  });

  it("keeps attachment metadata but drops the download URL", () => {
    const d = toTicketDetail({
      id: 1,
      attachments: [
        {
          id: 4004881085,
          content_type: "image/jpeg",
          file_size: 44115,
          name: "attachment1.jpg",
          attachment_url: "https://cdn.example/attachment.jpg",
        },
      ],
    });
    expect(d.attachments).toEqual([
      { id: 4004881085, name: "attachment1.jpg", content_type: "image/jpeg", file_size: 44115 },
    ]);
    expect(JSON.stringify(d)).not.toContain("cdn.example");
  });
});

describe("htmlToText", () => {
  it("strips tags, scripts and decodes entities", () => {
    expect(htmlToText("<p>Hi&nbsp;there</p><script>alert(1)</script><p>&lt;ok&gt; &#39;x&#39; &#x41;</p>")).toBe(
      "Hi there\n<ok> 'x' A",
    );
  });
});
