# Finance Watchdog

Laken types a change request into the app. Once a day, at 6:30, a job on
Cooper's Mac picks up each new request, runs headless Claude on it, and applies
the result. Nobody approves it first. This folder is that job.

The build spec is in `SPEC.md`.

## What happens to a request

Each request ends one of four ways.

| Outcome | When | What the watchdog does |
|---|---|---|
| **Data** | The request changes her numbers. | Applies a short list of patch operations to the budget row, once, after a snapshot. No code change, no deploy. She gets an Undo. |
| **Code** | The request needs new UI or logic. | Checks the agent's edits, runs the gates, commits, pushes straight to `main`, checks the live site, and reverts if it is not healthy. |
| **Question** | The request has two readings. | Shows Laken one question. Her answer puts the request back in the queue. |
| **Decline** | Not a request, unsound, or too big. | Marks it blocked with a plain note she can read. |

Cooper gets one email per run that did anything.

## The stops

A request is stopped, and nothing is changed, when any of these is true.

**Before Claude starts** (`screen.ts`)
- The text is over 2000 characters, or holds invisible or direction-changing characters.
- It reads like an instruction to the agent, asks about secrets, or names the
  protected parts of the repository.

**Data lane** (`patch.ts`, `db.ts`)
- The patched budget is not a valid budget, holds a number that is not finite,
  or repeats an id.
- Percent-of-net envelopes add up to more than 100.
- A past paycheck or extra saving was changed or removed.
- More than 25 operations, or a budget of 256 KB or more.
- The budget's version moved while the agent worked. The request waits and is
  tried again.

**Code lane** (`gates.ts`)
- A file changed outside `src/`, `test/client/`, `public/` and `index.html`.
- A sign-in or sync file changed, or `migrateBudget` differs by one byte.
- More than 600 changed lines or more than 12 files.
- `tsc -b`, `bun test`, `oxlint` or `vite build` fails, and one repair round
  does not fix it.
- The push is refused. The request waits for the next run.
- The deploy fails, times out, or the live site does not answer correctly.
  The commit is reverted, the code lane is **paused**, and Cooper is emailed.

**Always**
- Anything under `.git` or `node_modules` changed while the agent ran. The
  clone is moved aside (`repo.quarantined-*`) and the watchdog is paused. Run
  `install.sh` for a new clone after you have looked.
- A request that fails twice is blocked.

A paused watchdog still makes data changes. A request that needs code waits
until `unpause.sh` is run.

## Install

```
watchdog/bin/install.sh     # home folder, clone, launchd job. Safe to run again.
watchdog/bin/doctor.sh      # checks everything a run needs
```

Then put `emailTo` and `resendApiKey` in `~/.finance-watchdog/config.json`.
Without them, a run writes to the log and sends no email.

The watchdog runs the code that is on `main`. Until this folder is merged
there, the 6:30 job has nothing to run.

Other commands:

```
watchdog/bin/pause.sh "why"   # stop the code lane
watchdog/bin/unpause.sh       # let it push again
watchdog/bin/uninstall.sh     # remove the launchd job; the home folder stays
```

## Where things are

Everything lives in `~/.finance-watchdog/` (`FINANCE_WATCHDOG_HOME` overrides it).

| Path | What it is |
|---|---|
| `config.json` | Email settings, model, requests per run. All optional. |
| `repo/` | A plain clone the agent edits. Reset to `origin/main` before every request. |
| `state/lock` | The pid of the run in progress. |
| `state/paused` | Present when the code lane is paused. Holds the reason. |
| `state/last-run.json` | When the last run finished, and its counts. |
| `logs/run.log` | One entry per run that had anything to say. |
| `logs/launchd.log` | Whatever the job printed. Look here if a run never started. |
| `runs/<id>-<time>/` | One folder per request worked. |

## Reading a run folder

| File | What it holds |
|---|---|
| `prompt-first.txt` | The exact prompt Claude got. Her request is at the bottom, inside the fence. |
| `agent-output-first.txt` | Claude's exit code, stdout and stderr. |
| `result-first.json` | The outcome the agent chose. |
| `gate-first-tsc.log`, `-bun-test`, `-oxlint`, `-vite-build` | Full output of each gate (code lane only). |
| `*-repair.*` | The same files for the one repair round, when there was one. |

Run folders hold what Laken typed. They stay on this Mac.

## Tests

```
bun test test/watchdog
```

No test starts `claude`, `supabase`, `git`, `gh` or `vercel`, or sends mail.
Each takes those as a fake.
