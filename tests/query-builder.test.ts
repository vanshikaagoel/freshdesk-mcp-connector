import { describe, expect, it } from "vitest";
import { buildSearchQuery, MAX_QUERY_LENGTH } from "../src/freshdesk/query-builder.js";
import { ConnectorError } from "../src/errors.js";

describe("buildSearchQuery", () => {
  it("wraps a single clause in double quotes", () => {
    expect(buildSearchQuery({ priority: [3] })).toBe('"priority:3"');
  });

  it("ORs multiple values of the same field and ANDs different fields", () => {
    expect(buildSearchQuery({ status: [2, 3], priority: [4], groupId: 11 })).toBe(
      '"(status:2 OR status:3) AND priority:4 AND group_id:11"',
    );
  });

  it("deduplicates repeated values", () => {
    expect(buildSearchQuery({ status: [2, 2] })).toBe('"status:2"');
  });

  it("supports custom status codes", () => {
    expect(buildSearchQuery({ status: [6, 7] })).toBe('"(status:6 OR status:7)"');
  });

  it("maps unassigned to agent_id:null", () => {
    expect(buildSearchQuery({ unassigned: true, priority: [4] })).toBe('"priority:4 AND agent_id:null"');
  });

  it("single-quotes string values (tag, type)", () => {
    expect(buildSearchQuery({ type: "Problem", tag: "marketing" })).toBe("\"tag:'marketing' AND type:'Problem'\"");
  });

  it("builds inclusive date ranges with :> and :<", () => {
    expect(
      buildSearchQuery({ createdFrom: "2026-09-01", createdTo: "2026-09-30", dueTo: "2026-10-07" }),
    ).toBe("\"created_at:>'2026-09-01' AND created_at:<'2026-09-30' AND due_by:<'2026-10-07'\"");
  });

  it("supports updated_at ranges", () => {
    expect(buildSearchQuery({ updatedFrom: "2026-10-01" })).toBe("\"updated_at:>'2026-10-01'\"");
  });

  describe("validation", () => {
    const cases: Array<[string, Parameters<typeof buildSearchQuery>[0], RegExp]> = [
      ["empty criteria", {}, /at least one search filter/],
      ["agent_id and unassigned", { agentId: 5, unassigned: true }, /either agent_id or unassigned/],
      ["quote in tag", { tag: "vip' OR status:2" }, /quotes/],
      ["double quote in type", { type: 'a"b' }, /quotes/],
      ["backslash", { tag: "a\\b" }, /backslashes/],
      ["blank tag", { tag: "   " }, /must not be empty/],
      ["bad date format", { createdFrom: "01-10-2026" }, /YYYY-MM-DD/],
      ["impossible date", { createdFrom: "2026-02-30" }, /YYYY-MM-DD/],
      ["datetime instead of date", { updatedFrom: "2026-10-01T10:00:00Z" }, /YYYY-MM-DD/],
      ["reversed range", { createdFrom: "2026-10-05", createdTo: "2026-10-01" }, /on or before/],
      ["priority out of range", { priority: [5] }, /between 1/],
      ["non-positive status", { status: [0] }, /positive integer/],
      ["non-integer group", { groupId: 1.5 }, /positive integer/],
    ];
    it.each(cases)("rejects %s", (_name, criteria, message) => {
      expect(() => buildSearchQuery(criteria)).toThrow(ConnectorError);
      expect(() => buildSearchQuery(criteria)).toThrow(message);
    });

    it("rejects queries longer than the documented 512-character limit", () => {
      const tag = "x".repeat(MAX_QUERY_LENGTH);
      expect(() => buildSearchQuery({ tag })).toThrow(/max 512/);
    });

    it("errors are tagged invalid_input (never sent to Freshdesk)", () => {
      try {
        buildSearchQuery({});
      } catch (err) {
        expect((err as ConnectorError).kind).toBe("invalid_input");
      }
    });
  });
});
