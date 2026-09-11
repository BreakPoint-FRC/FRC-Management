# Meeting editor: unsaved changes

The plain-text editor has two independent protections. Both are required: a
native unload warning cannot protect an in-place form switch, and an application
dialog cannot intercept closing or reloading a browser tab.

The title, date, group and report are compared with a snapshot taken when the
editor opens. New-meeting defaults count as the initial snapshot. Comparisons
preserve whitespace; restoring every original value makes the form clean again.
Only a successful POST/PATCH clears protection. Failed saves keep the draft.

## Browser protection

The editor registers `beforeunload` only while dirty. Closing or reloading the
tab after interacting with the form opens the browser's own confirmation. Its
wording is controlled by the browser. Successful saves clear the live guard
before closing the form, so an immediate reload or close does not warn.

## Application protection

The dashboard provider coordinates an application-owned dialog for the editor's
Cancel button, opening another editor/new meeting, meeting detail links, sidebar
links, and sign-out. Cancelling preserves the draft and current location;
confirming discards it and executes the requested action once. Escape stays in
the editor, focus starts on the safe option, Tab stays within the dialog, and
closing the dialog restores focus to its trigger when that trigger still exists.

Saving disables the editor and blocks these departure actions until the request
finishes. Delete buttons are disabled while an editor is open so its backing
record cannot disappear during editing. Filtering the list and new-tab gestures
do not discard the current draft and do not prompt.

Future application controls that leave this editor must use `GuardedLink` or
`requestLeave`. This is opt-in protection, not a global router/history patch.
Browser Back/Forward, forced authentication redirects, attendance editing,
other forms, autosave and persistent draft storage are outside this change.

## Verification

Run from the repository root with workspace dependencies installed:

```sh
pnpm --filter @breakpoint/types build
pnpm --filter @breakpoint/web test
pnpm --filter @breakpoint/web typecheck
pnpm --filter @breakpoint/web lint
pnpm --filter @breakpoint/web exec playwright test meetings-unsaved.spec.ts
```

The E2E suite mocks API responses; it does not need a database. For Firefox,
install its Playwright browser and pass `--browser=firefox` to the test command.

Record the two acceptance groups separately when closing the issue:

| Group | Required evidence |
| --- | --- |
| Browser | Dirty reload and tab close show `beforeunload`; dismiss preserves the report; successful create/update followed immediately by reload/close shows no warning. |
| Application | Cancel, edit/new meeting, detail/sidebar navigation and sign-out show the custom dialog, with no native confirm; staying preserves the draft; leaving executes the intended action; reopening a saved form and cancelling does not warn. |

Additional tests cover every field, reverting changes, pending/failed saves,
keyboard focus, Escape, new-tab gestures, filtering, and mobile light/dark layout.
The tab-close test keeps a second blank tab open to avoid a Firefox automation
session-store race when closing its last tab after a native unload warning.
