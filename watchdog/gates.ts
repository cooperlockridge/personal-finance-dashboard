import { join } from 'node:path'
import type { AgentRun } from './agent.ts'
import { GH_REPO, PROD_URL } from './config.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { Wrap } from './sandbox.ts'

/* The code lane. The agent has edited files in the clone; this decides
   whether those edits may reach `main`, pushes them with no pull request, and
   takes them back out if the live site is not healthy afterwards. Every step
   that can refuse does so before the push, and git, gh, the network and the
   clock all come in as parameters. */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GateDeps = {
  exec: Exec
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  /** The clone. */
  repo: string
  /** state/paused. Written when a deploy had to be reverted. */
  pausedFile: string
  /** Puts a gate inside the sandbox; see sandbox.ts. The real run always sets it. */
  sandbox?: Wrap
  now?: () => Date
}

export type CodeJob = {
  requestId: number
  runDir: string
  /** Runs the agent once more with the failed checks' output. */
  repair: (output: string) => Promise<AgentRun>
}

export type CodeLaneResult =
  | { kind: 'done', commitSha: string, summary?: string }
  /* The change broke a rule or could not pass the checks. Nothing was pushed. */
  | { kind: 'blocked', reason: string }
  /* The push was refused. Nothing changed; a later run starts from the new main. */
  | { kind: 'requeue', reason: string }
  /* It shipped, the live site was not healthy, and it was taken back out. */
  | { kind: 'reverted', commitSha: string, reason: string, revertPushed: boolean }
  /* The repair run could not be trusted or could not start; run.ts decides. */
  | { kind: 'agent', run: AgentRun }

/* The whole of what an agent may change. Anything else — api/, the watchdog
   itself, migrations, CI, package.json, the build config — is out of reach
   however reasonable the edit looks. */
const ALLOWED_PREFIXES = ['src/', 'test/client/', 'public/']
const ALLOWED_FILES = ['index.html']

/* Inside src/, the files that decide who is signed in and what gets saved to
   the shared budget. A bug there loses Laken's numbers on every device. */
const DENIED_FILES = [
  'src/lib/sync.ts',
  'src/lib/budgetapi.ts',
  'src/lib/devicesession.ts',
  'src/lib/usesession.ts',
  'src/lib/usebudgetsync.ts',
  'src/lib/requestsapi.ts',
  'src/main.tsx',
]

export const MAX_CHANGED_LINES = 600
export const MAX_CHANGED_FILES = 12

const FINANCE_FILE = 'src/lib/finance.ts'
const WORK_PREFIX = '.watchdog/'
const GIT_TIMEOUT_MS = 120_000
const GATE_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 15_000
const DEPLOY_POLLS = 40
const SITE_TRIES = 3

/* The author on every watchdog commit. Nothing about the request goes into
   the commit: the repository is public and her words are not. */
const IDENTITY = ['-c', 'user.name=Watchdog', '-c', 'user.email=watchdog@localhost']

/* Every git command in the clone ignores hooks and the fsmonitor setting.
   The agent has no way to run a program, and these two are how a written
   file could become one. */
function git(deps: GateDeps, args: string[]): Promise<ExecResult> {
  return deps.exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: deps.repo,
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

/* A git command that has no business failing. */
async function mustGit(deps: GateDeps, args: string[]): Promise<string> {
  const result = await git(deps, args)
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(-300)}`)
  }
  return result.stdout
}

/* Throws away everything in the clone that is not on main: edits, new files,
   and a commit that did not ship. `fetch` first picks up what main is now. */
export async function resetClone(deps: GateDeps, options: { fetch: boolean }): Promise<void> {
  if (options.fetch) await mustGit(deps, ['fetch', '-q', 'origin'])
  await mustGit(deps, ['reset', '-q', '--hard', 'origin/main'])
  await mustGit(deps, ['clean', '-fdq'])
}

/* Step 1. Every path that differs from main, new files listed one by one.
   -z gives the names as they are, with no quoting to undo; a rename reports
   both its names, and both count. */
export async function changedFiles(deps: GateDeps): Promise<string[]> {
  const output = await mustGit(deps, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const tokens = output.split('\0')
  const files = new Set<string>()
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    files.add(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      i += 1
      if (tokens[i]) files.add(tokens[i])
    }
  }
  return [...files].filter((file) => !file.startsWith(WORK_PREFIX)).sort()
}

/* Step 2, the paths. Returns one line per file that may not be touched. */
export function pathViolations(files: string[]): string[] {
  const problems: string[] = []
  for (const file of files) {
    const segments = file.split('/')
    const lower = file.toLowerCase()
    if (file.startsWith('/') || file.includes('\\') || segments.includes('..') || segments.includes('')) {
      problems.push(`${file}: not a plain path inside the repository`)
    } else if (segments.some((segment) => segment.startsWith('.'))) {
      /* .gitattributes, .env, .npmrc: files that change how tools behave. */
      problems.push(`${file}: dot-files are off limits`)
    } else if (!ALLOWED_FILES.includes(file) && !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      problems.push(`${file}: outside src/, test/client/, public/ and index.html`)
    } else if (DENIED_FILES.includes(lower)) {
      /* Compared in lower case: the Mac's disk does not tell Sync.ts from sync.ts. */
      problems.push(`${file}: sign-in and sync files are off limits`)
    }
  }
  return problems
}

/**
 * The text of `migrateBudget`, from its `export function` line to the closing
 * brace in column one. Null when the file does not hold exactly one such
 * function — which is itself a violation.
 *
 * migrateBudget runs on every device against every copy of the budget, and
 * its steps are one-time by design. A new step written by an agent would
 * rewrite Laken's real numbers everywhere with no snapshot and no Undo.
 */
export function migrateBudgetSource(text: string): string | null {
  const start = text.indexOf('export function migrateBudget(')
  if (start === -1) return null
  if (text.split('function migrateBudget').length !== 2) return null
  const end = text.indexOf('\n}\n', start)
  return end === -1 ? null : text.slice(start, end + 3)
}

async function migrateBudgetViolations(deps: GateDeps): Promise<string[]> {
  const before = migrateBudgetSource(await mustGit(deps, ['show', `HEAD:${FINANCE_FILE}`]))
  let after: string | null
  try {
    after = migrateBudgetSource(await deps.readFile(join(deps.repo, FINANCE_FILE)))
  } catch {
    after = null
  }
  if (before === null) return [`${FINANCE_FILE}: migrateBudget could not be found on main`]
  /* A string comparison: one changed space counts. */
  return after === before ? [] : [`${FINANCE_FILE}: migrateBudget was changed`]
}

/* Step 3. Stages the change and measures it. A request that needs more than
   this is a project, and a project gets Cooper. */
async function sizeViolations(deps: GateDeps): Promise<string[]> {
  await mustGit(deps, ['add', '-A', '--', '.', ':(exclude).watchdog'])
  const output = await mustGit(deps, ['diff', '--cached', '--numstat', 'HEAD'])
  const rows = output.split('\n').filter((line) => line.trim() !== '')
  const problems: string[] = []
  let lines = 0
  for (const row of rows) {
    const [added, deleted, ...name] = row.split('\t')
    /* numstat prints "-" for a file it cannot count: a binary. The agent
       writes text, and a binary nobody can read does not ship unseen. */
    if (added === '-' || deleted === '-') problems.push(`${name.join('\t')}: a binary file`)
    else lines += Number(added) + Number(deleted)
  }
  if (rows.length > MAX_CHANGED_FILES) problems.push(`${rows.length} files changed, over the limit of ${MAX_CHANGED_FILES}`)
  if (lines > MAX_CHANGED_LINES) problems.push(`${lines} lines changed, over the limit of ${MAX_CHANGED_LINES}`)
  return problems
}

/* Steps 1 to 3 for a code outcome. An empty list means the change may go on
   to the gates. The order matters: nothing is staged until the paths pass. */
export async function codeViolations(deps: GateDeps): Promise<string[]> {
  const files = await changedFiles(deps)
  if (files.length === 0) return ['The agent chose the code lane and changed no file']
  const paths = pathViolations(files)
  if (paths.length > 0) return paths
  const migrate = await migrateBudgetViolations(deps)
  if (migrate.length > 0) return migrate
  return sizeViolations(deps)
}

type Gate = { name: string, command: string, args: string[], env?: Record<string, string> }

function gateList(repo: string): Gate[] {
  const bin = (name: string) => join(repo, 'node_modules', '.bin', name)
  return [
    { name: 'tsc', command: bin('tsc'), args: ['-b'] },
    { name: 'bun-test', command: 'bun', args: ['test'] },
    { name: 'oxlint', command: bin('oxlint'), args: [] },
    /* Vite needs a Clerk key to build; this one opens nothing. */
    { name: 'vite-build', command: bin('vite'), args: ['build'], env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_build_check' } },
  ]
}

/* Step 4. All four run even after one fails, so the repair round is told
   everything that is wrong at once. Each gate's full output is kept in the
   run folder whether it passed or not. */
export async function runGates(
  deps: GateDeps,
  runDir: string,
  round: 'first' | 'repair',
): Promise<{ ok: boolean, output: string }> {
  const failures: string[] = []
  for (const gate of gateList(deps.repo)) {
    /* This is agent-written code running on Cooper's Mac, so it runs boxed in. */
    const run = deps.sandbox ? deps.sandbox(gate.command, gate.args) : gate
    const result = await deps.exec(run.command, run.args, { cwd: deps.repo, env: gate.env, timeoutMs: GATE_TIMEOUT_MS })
    const passed = result.code === 0 && !result.timedOut
    const output = `$ ${gate.name} ${gate.args.join(' ')}\nexit ${result.code}${result.timedOut ? ' (timed out)' : ''}\n\n${result.stdout}\n${result.stderr}\n`
    await deps.writeFile(join(runDir, `gate-${round}-${gate.name}.log`), output)
    if (!passed) failures.push(output)
  }
  return { ok: failures.length === 0, output: failures.join('\n') }
}

async function siteHealthy(deps: GateDeps): Promise<string | null> {
  try {
    const page = await deps.fetch(`${PROD_URL}/`, { signal: AbortSignal.timeout(POLL_MS) })
    if (page.status !== 200) return `The home page answered ${page.status}`
    if (!(await page.text()).includes('<div id="root">')) return 'The home page has no app root'
    /* With no cookie and no token the API must say exactly this. A 500 means
       the functions did not build; a 200 means sign-in is broken open. */
    const api = await deps.fetch(`${PROD_URL}/api/device`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(POLL_MS),
    })
    if (api.status !== 401) return `/api/device answered ${api.status}, not 401`
    if ((await api.text()).trim() !== '{"error":"unauthorized"}') return '/api/device did not answer with the unauthorized error'
    return null
  } catch (error) {
    return `The live site could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`
  }
}

/**
 * Step 6. Waits for Vercel to report on the commit, then looks at the live
 * site. Null means healthy; otherwise the reason it is not.
 *
 * A `gh` call that fails counts as "no news yet" and the wait goes on. The
 * site is asked up to three times, 15 seconds apart, because the production
 * alias can trail the "success" status by a few seconds and a false alarm
 * here reverts good work and pauses the lane.
 */
export async function deployProblem(deps: GateDeps, sha: string): Promise<string | null> {
  let state = 'pending'
  for (let poll = 0; poll < DEPLOY_POLLS; poll += 1) {
    const result = await deps.exec('gh', ['api', `repos/${GH_REPO}/commits/${sha}/status`, '-q', '.state'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (result.code === 0) state = result.stdout.trim()
    if (state === 'success') break
    if (state === 'failure' || state === 'error') return `The deploy reported ${state}`
    await deps.sleep(POLL_MS)
  }
  if (state !== 'success') return 'The deploy did not finish within 10 minutes'

  let problem: string | null = null
  for (let attempt = 0; attempt < SITE_TRIES; attempt += 1) {
    if (attempt > 0) await deps.sleep(POLL_MS)
    problem = await siteHealthy(deps)
    if (problem === null) return null
  }
  return problem
}

/* Step 7. Takes the commit back out of main and stops the code lane until
   Cooper has looked. The pause is written whether or not the revert reached
   GitHub: if it did not, that is one more reason not to push again. */
async function revertAndPause(deps: GateDeps, sha: string, reason: string): Promise<boolean> {
  let pushed = false
  try {
    const reverted = await git(deps, [...IDENTITY, 'revert', '--no-edit', sha])
    if (reverted.code === 0) pushed = (await git(deps, ['push', 'origin', 'HEAD:main'])).code === 0
  } finally {
    const at = (deps.now?.() ?? new Date()).toISOString()
    const note = pushed ? 'The commit was reverted on main.' : 'THE REVERT DID NOT REACH MAIN. Revert it by hand.'
    await deps.writeFile(deps.pausedFile, `${at}\nCommit ${sha}: ${reason}\n${note}\n`)
  }
  return pushed
}

/**
 * Steps 1 to 7 for one request whose agent chose `code`. Whatever the result,
 * the clone is left matching main — except after a tampered repair run, when
 * no git command is run in it at all.
 */
export async function runCodeLane(deps: GateDeps, job: CodeJob): Promise<CodeLaneResult> {
  if (!Number.isSafeInteger(job.requestId)) throw new Error('The request id is not an integer')

  async function blocked(reason: string): Promise<CodeLaneResult> {
    await resetClone(deps, { fetch: false })
    return { kind: 'blocked', reason }
  }

  let summary: string | undefined
  let problems = await codeViolations(deps)
  if (problems.length > 0) return blocked(problems.join('; '))

  let gates = await runGates(deps, job.runDir, 'first')
  if (!gates.ok) {
    const again = await job.repair(gates.output)
    if (again.kind === 'tampered' || again.kind === 'unavailable') return { kind: 'agent', run: again }
    if (again.kind !== 'ok' || again.result.outcome !== 'code') {
      return blocked('The checks failed and the repair round did not produce a code change')
    }
    summary = again.result.summary
    /* The repair run had the same freedom as the first, so it gets the same
       rules from the top. */
    problems = await codeViolations(deps)
    if (problems.length > 0) return blocked(problems.join('; '))
    gates = await runGates(deps, job.runDir, 'repair')
    if (!gates.ok) return blocked('The checks still failed after the repair round')
  }

  /* Step 5. */
  await mustGit(deps, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', `Watchdog: request #${job.requestId}`])
  const sha = (await mustGit(deps, ['rev-parse', 'HEAD'])).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('git rev-parse did not print a commit id')

  /* A plain push. If main moved since the clone was reset, git refuses, and
     that refusal is the answer: nothing is forced, and nothing is merged by
     a job nobody is watching. */
  const push = await git(deps, ['push', 'origin', `HEAD:main`])
  if (push.code !== 0 || push.timedOut) {
    await resetClone(deps, { fetch: false })
    return { kind: 'requeue', reason: `The push was refused: ${push.stderr.trim().slice(-200)}` }
  }

  const problem = await deployProblem(deps, sha)
  if (problem === null) return { kind: 'done', commitSha: sha, summary }

  const revertPushed = await revertAndPause(deps, sha, problem)
  return { kind: 'reverted', commitSha: sha, reason: problem, revertPushed }
}
