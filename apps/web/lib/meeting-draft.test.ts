import { describe, expect, it } from "vitest";
import { isMeetingDraftDirty, type MeetingDraft } from "./meeting-draft";

const baseline: MeetingDraft = {
  title: "Planning", meetingDate: "2026-09-12", groupId: "group", body: "Saved report",
};

describe("meeting draft changes", () => {
  it("starts clean, including defaults in a new meeting", () => {
    expect(isMeetingDraftDirty({ ...baseline }, baseline)).toBe(false);
    const newMeeting = { title: "", body: "", groupId: "group", meetingDate: "2026-09-12" };
    expect(isMeetingDraftDirty({ ...newMeeting }, newMeeting)).toBe(false);
  });

  for (const field of Object.keys(baseline) as Array<keyof MeetingDraft>) {
    it(`detects and clears a change to ${field}`, () => {
      const draft = { ...baseline, [field]: baseline[field] + "changed" };
      expect(isMeetingDraftDirty(draft, baseline)).toBe(true);
      draft[field] = baseline[field];
      expect(isMeetingDraftDirty(draft, baseline)).toBe(false);
    });
  }

  it("preserves whitespace differences and detects clearing a report", () => {
    expect(isMeetingDraftDirty({ ...baseline, body: baseline.body + " " }, baseline)).toBe(true);
    expect(isMeetingDraftDirty({ ...baseline, body: "" }, baseline)).toBe(true);
  });
});
