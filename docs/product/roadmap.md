# Roadmap

Scope split agreed before development started. V1 is what the current codebase
targets.

## V1

1. Roll call for meetings
2. Report storage and editor for meetings
3. Task management among groups
4. Task management in groups
5. Finance tracker (sponsorships, income (from who/where), spendings (to who/where), balance)

Meetings are one model regardless of scope: a `null` `groupId` is a team-wide
meeting, a set one is a group meeting, and both run the exact same roll-call +
report flow. So "roll call for team meetings" and "report storage for group
meetings" were never separate features to build — items 1 and 2 above already
cover every meeting, team-wide or per-group. The two V2 line items that used
to name them were removed for that reason; see [decisions.md](decisions.md)
for the other two scope questions settled at the same time.

## V2

1. Polls and opinions
2. Schedule arrangement — **shipped early**, as `/calendar`

Schedule arrangement came forward because it cost almost nothing: meetings and
tasks already carried the dates, so the calendar is a read-only view over them
rather than a feature with records of its own. It stays in this list so the
scope split still reads as it was agreed.

## V3

1. Polishing
