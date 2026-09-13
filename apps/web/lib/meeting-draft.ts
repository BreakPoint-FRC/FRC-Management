export interface MeetingDraft {
  title: string;
  meetingDate: string;
  groupId: string;
  body: string;
}

export function isMeetingDraftDirty(draft: MeetingDraft, baseline: MeetingDraft): boolean {
  return draft.title !== baseline.title || draft.meetingDate !== baseline.meetingDate ||
    draft.groupId !== baseline.groupId || draft.body !== baseline.body;
}
