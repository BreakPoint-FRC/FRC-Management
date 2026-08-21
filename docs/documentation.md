# Documentation rules

Documentation ships with the change, not after it. A PR that makes the README
wrong is an incomplete PR.

## What must be documented

| You changed | You must also |
| --- | --- |
| Added or changed an API route | Document method, path, request body, and the error codes it can return — in the module's own file, next to the route |
| Added an env var | Add it to [.env.example](../.env.example) with a working local default, in the same PR |
| Added a script to any `package.json` | Add a row to the Scripts table in [README.md](../README.md) |
| Changed the setup steps | Update Getting started in the README *and* Setup in [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Changed the schema | Follow [migrations.md](migrations.md); extend the seed if you added a model |
| Made a decision a reader could reverse by accident | Write down *why*, in a comment at the code or a section in the README |

That last row is the one that matters most. The README's PWA section says
offline **reads** work and writes still need the network — that is not a
description of the code, it is a deliberate choice, and without it written down
someone will "fix" the missing offline writes and break the sync story. The same
goes for comments already in the tree: why `base.json` is not named
`tsconfig.base.json`, why the error handler hides 500 details, why the service
worker only registers in production. Keep writing those.

## Where things live

| File | Holds |
| --- | --- |
| [README.md](../README.md) | What BreakPoint is, the stack, getting started, the scripts table, PWA behaviour |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to work on it: branches, commits, code layout, PR checklist |
| [docs/migrations.md](migrations.md) | Database change rules |
| [docs/documentation.md](documentation.md) | This file |
| [docs/product/](product/) | Scope, roadmap, and the meeting notes behind them — the *why* of the features |
| `packages/<name>/README.md` | Anything true only of that workspace |
| Code comments | Why a specific line is the way it is |

Do not repeat the same instructions in two files. Link to the one that owns it.
The README says how to get running; CONTRIBUTING links to the README rather than
copying the commands, and both are kept short enough that someone actually reads
them.

## When

In the same pull request as the change. If a PR changes setup steps and does not
touch `README.md`, that is a review blocker, not a follow-up ticket.

## Style

- **English**, present tense. The code, the schema, and the commit history are
  all in English; documentation matching them keeps the project usable by people
  outside the team.
- **Commands are copy-pasteable.** A fenced block someone can paste whole, with
  the working directory obvious.
- **Explain why, not what.** `// increments the counter` above `count++` is
  noise. `// counted per meeting, not per member, because a member can be in two
  groups` is documentation.
- **Link, do not duplicate.** Use relative links between docs so they survive
  being read on GitHub and in an editor.
- **No screenshots of text.** They go stale and cannot be searched or diffed.
