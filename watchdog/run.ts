import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { protectedFingerprint, runAgent, type AgentJob, type AgentRun } from './agent.ts'
import {
  loadConfig,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_RUN,
  pathsFromEnv,
  SUMMARY_FAILED_TWICE,
  SUMMARY_NEEDS_COOPER,
  SUMMARY_WOULD_BREAK,
  type Config,
  type Paths,
} from './config.ts'
import { createDb, supabaseRunSql, type Db, type RequestRow } from './db.ts'
import { realExec } from './exec.ts'
import { changedFiles, resetClone, runCodeLane, type CodeJob, type CodeLaneResult, type GateDeps } from './gates.ts'
import { createNotifier, type Notify } from './notify.ts'
import { applyOps, PatchError, validateBudget } from './patch.ts'
import { sandboxed } from './sandbox.ts'
import { screenRequest } from './screen.ts'

/* The entry point: one morning's run, start to finish. Everything it does to
   the world goes through `RunDeps`, so the tests drive the whole of it with
   fakes; only the lock and the state files touch a (temporary) disk. */

export type RunDeps = {
  paths: Paths
  config: Config
  db: Db
  notify: Notify
  log: (line: string) => Promise<void>
  now: () => Date
  pid: number
  isAlive: (pid: number) => boolean
  /** Why the run cannot start, or null. Checked before any request is claimed. */
  preflight: () => Promise<string | null>
  resetClone: (options: { fetch: boolean }) => Promise<void>
  changedFiles: () => Promise<string[]>
  runAgent: (job: AgentJob) => Promise<AgentRun>
  runCodeLane: (job: CodeJob) => Promise<CodeLaneResult>
  /** Moves the clone out of the way after a tampered run. */
  quarantineClone: () => Promise<void>
}

export type LastRun = { at: string, claimed: number, done: number, questions: number, blocked: number, failed: number }

type Report = {
  counts: Omit<LastRun, 'at'>
  /** One line per request for Cooper. Never holds what Laken typed. */
  lines: string[]
  /** Set when the run could not begin, or stopped on an error. */
  trouble: string | null
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
/* Five requests at the agent's full time limit, twice each, fit well inside
   this. A lock older than that was left by a run that is gone, even if its
   pid has since been handed to some other program. */
const LOCK_STALE_MS = 12 * 60 * 60 * 1000

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/* Step 1. A pid file, created with the "fail if it exists" flag so two runs
   starting together cannot both think they made it. Returns false when a
   live run holds it. */
export async function takeLock(deps: Pick<RunDeps, 'paths' | 'pid' | 'isAlive' | 'now'>): Promise<boolean> {
  await mkdir(deps.paths.state, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(deps.paths.lock, `${deps.pid}\n`, { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = Number((await readText(deps.paths.lock))?.trim())
    const age = deps.now().getTime() - (await stat(deps.paths.lock).then((s) => s.mtimeMs, () => 0))
    const live = Number.isInteger(holder) && holder > 0 && holder !== deps.pid && deps.isAlive(holder)
    if (live && age < LOCK_STALE_MS) return false
    /* The holder is dead: take over. */
    await rm(deps.paths.lock, { force: true })
  }
  return false
}

export async function releaseLock(deps: Pick<RunDeps, 'paths' | 'pid'>): Promise<void> {
  const holder = Number((await readText(deps.paths.lock))?.trim())
  if (holder === deps.pid) await rm(deps.paths.lock, { force: true })
}

async function readLastRun(file: string): Promise<LastRun | null> {
  try {
    const parsed: unknown = JSON.parse((await readText(file)) ?? '')
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as LastRun).at === 'string'
      ? (parsed as LastRun)
      : null
  } catch {
    return null
  }
}

/* What Cooper is told about a pause: the reason, on one line. */
async function pauseReason(deps: RunDeps): Promise<string | null> {
  const text = await readText(deps.paths.paused)
  return text === null ? null : text.trim().split('\n').join(' ') || 'no reason given'
}

async function writePause(deps: RunDeps, reason: string): Promise<void> {
  await mkdir(deps.paths.state, { recursive: true })
  await writeFile(deps.paths.paused, `${deps.now().toISOString()}\n${reason}\n`)
}

/* Steps 2 and 3. Returns when the queue is empty, the run's share is used
   up, or something stops the run for everyone. */
async function work(deps: RunDeps, report: Report): Promise<void> {
  const { db } = deps
  const cannot = await deps.preflight()
  if (cannot !== null) {
    report.trouble = `The run could not start: ${cannot}`
    return
  }

  let released: Awaited<ReturnType<Db['releaseStuck']>>
  try {
    released = await db.releaseStuck()
  } catch (error) {
    report.trouble = `The run could not start: Supabase could not be reached (${messageOf(error)})`
    return
  }
  for (const id of released.requeued) report.lines.push(`#${id} was left half-done by an earlier run and is back in the queue.`)
  for (const id of released.blocked) {
    report.counts.blocked += 1
    report.lines.push(`#${id} blocked: left half-done twice. Laken was told it failed twice.`)
  }

  /* Requests this run has put back. Without it the oldest waiting request
     would be claimed again on the very next turn. */
  const skip = new Set<number>()
  /* Requests whose data patch has already lost one version race this run. */
  const raced = new Set<number>()
  const limit = deps.config.maxRequestsPerRun ?? MAX_REQUESTS_PER_RUN

  for (let turn = 0; turn < limit; turn += 1) {
    const row = await db.claimNext([...skip])
    if (row === null) break
    report.counts.claimed += 1
    let go: 'on' | 'stop'
    try {
      go = await handle(deps, report, row, skip, raced)
    } catch (error) {
      /* Not knowing what state the clone or the database is in, the run does
         not go on to the next request. This one counts as a failed try. */
      report.lines.push(`#${row.id} error: ${messageOf(error)}`)
      await deps.log(`request ${row.id} threw: ${messageOf(error)}`)
      await agentFailed(deps, report, row, skip, null)
      go = 'stop'
    }
    if (go === 'stop') break
  }
}

/* A try that produced nothing usable. One more morning, or — if this was
   the second — the end of the road, in words Laken can read. */
async function agentFailed(
  deps: RunDeps,
  report: Report,
  row: RequestRow,
  skip: Set<number>,
  reason: string | null,
): Promise<void> {
  report.counts.failed += 1
  if (row.attempts < MAX_ATTEMPTS) {
    await deps.db.requeue(row.id)
    skip.add(row.id)
    if (reason !== null) report.lines.push(`#${row.id} failed, will retry on the next run: ${reason}`)
  } else {
    await deps.db.finish(row.id, { status: 'blocked', summary: SUMMARY_FAILED_TWICE })
    report.counts.blocked += 1
    if (reason !== null) report.lines.push(`#${row.id} blocked after ${row.attempts} tries: ${reason}`)
  }
}

/* An agent run that says the clone, or Claude itself, cannot be used. Both
   end the run for every request. */
async function agentUnusable(
  deps: RunDeps,
  report: Report,
  row: RequestRow,
  run: Extract<AgentRun, { kind: 'tampered' | 'unavailable' }>,
): Promise<'stop'> {
  if (run.kind === 'unavailable') {
    await deps.db.requeue(row.id, { refundAttempt: true })
    report.trouble = `The run stopped: ${run.reason}. #${row.id} is back in the queue.`
    return 'stop'
  }
  /* No git command is run in a clone whose .git may have been rewritten —
     that includes tomorrow's bootstrap, so the clone is moved away and the
     code lane is paused. install.sh makes a clean one. */
  await deps.quarantineClone()
  await writePause(deps, `Request ${row.id}: ${run.reason}. The clone was moved aside; run install.sh for a new one.`)
  await deps.db.finish(row.id, { status: 'blocked', summary: SUMMARY_NEEDS_COOPER })
  report.counts.blocked += 1
  report.lines.push(
    `#${row.id} blocked: ${run.reason}. The clone was moved aside and the watchdog is paused. Check the main checkout's node_modules too.`,
  )
  return 'stop'
}

async function handle(
  deps: RunDeps,
  report: Report,
  row: RequestRow,
  skip: Set<number>,
  raced: Set<number>,
): Promise<'on' | 'stop'> {
  const { db } = deps
  const id = row.id

  /* Her answer to an earlier question goes to the model too, so it is
     screened the same way. */
  for (const text of [row.body, row.answer ?? '']) {
    const screened = screenRequest(text)
    if (!screened.ok) {
      await db.finish(id, { status: 'blocked', summary: SUMMARY_NEEDS_COOPER })
      report.counts.blocked += 1
      /* The reason code only. Text that tripped the screen is not passed on. */
      report.lines.push(`#${id} blocked by the screen before any agent ran (${screened.reason}). Read it in the app.`)
      return 'on'
    }
  }

  const budget = await db.readBudget()
  await deps.resetClone({ fetch: true })

  const request = { id, body: row.body, question: row.question, answer: row.answer }
  const runDir = join(deps.paths.runs, `${id}-${deps.now().toISOString().replace(/[:.]/g, '-')}`)
  const run = await deps.runAgent({ request, budget: budget.data, runDir })

  if (run.kind === 'tampered' || run.kind === 'unavailable') return agentUnusable(deps, report, row, run)
  if (run.kind === 'failed') {
    await deps.resetClone({ fetch: false })
    await agentFailed(deps, report, row, skip, run.reason)
    return 'on'
  }
  const { result } = run

  if (result.outcome !== 'code') {
    /* Only the code lane may leave files changed. An edit alongside any
       other outcome means the agent did not do what it said it did. */
    const edited = await deps.changedFiles()
    if (edited.length > 0) {
      await deps.resetClone({ fetch: false })
      await agentFailed(deps, report, row, skip, `outcome "${result.outcome}" came with ${edited.length} edited file(s)`)
      return 'on'
    }
  }

  switch (result.outcome) {
    case 'question':
      await db.finish(id, { status: 'needs_answer', question: result.question })
      report.counts.questions += 1
      report.lines.push(`#${id} question: ${result.question}`)
      return 'on'

    case 'decline':
      await db.finish(id, { status: 'blocked', summary: result.summary })
      report.counts.blocked += 1
      report.lines.push(`#${id} declined: ${result.summary}`)
      return 'on'

    case 'data': {
      let patched: ReturnType<typeof applyOps>
      try {
        patched = applyOps(budget.data, result.ops)
      } catch (error) {
        if (!(error instanceof PatchError)) throw error
        await agentFailed(deps, report, row, skip, `the operations did not fit the budget (${error.message})`)
        return 'on'
      }
      const problems = validateBudget(patched.budget, budget.data, result.ops.length)
      if (problems.length > 0) {
        await db.finish(id, { status: 'blocked', summary: SUMMARY_WOULD_BREAK })
        report.counts.blocked += 1
        report.lines.push(`#${id} blocked, the change would break the budget: ${problems.join('; ')}`)
        return 'on'
      }
      /* The version is the one read before the agent started. If Laken saved
         anything since, the patch was worked out against numbers that are no
         longer hers, and it is not applied. */
      const outcome = await db.applyDataPatch({
        requestId: id,
        expectedVersion: budget.version,
        newData: patched.budget,
        userId: row.userId,
        summary: result.summary,
        changes: patched.changes,
      })
      if (outcome.applied) {
        report.counts.done += 1
        report.lines.push(`#${id} data, done: ${result.summary}`)
        return 'on'
      }
      await db.requeue(id, { refundAttempt: true })
      if (raced.has(id)) {
        skip.add(id)
        report.lines.push(`#${id} left waiting: the budget changed twice while it was being worked on.`)
      } else {
        raced.add(id)
      }
      return 'on'
    }

    case 'code': {
      const paused = await pauseReason(deps)
      if (paused !== null) {
        await deps.resetClone({ fetch: false })
        await db.requeue(id, { refundAttempt: true })
        skip.add(id)
        report.lines.push(`#${id} left waiting: it needs a code change and the code lane is paused (${paused}). Run unpause.sh when ready.`)
        return 'on'
      }
      const lane = await deps.runCodeLane({
        requestId: id,
        runDir,
        repair: (output) => deps.runAgent({ request, budget: budget.data, runDir, repair: output }),
      })
      switch (lane.kind) {
        case 'done':
          await db.finish(id, { status: 'done', lane: 'code', summary: lane.summary ?? result.summary, commitSha: lane.commitSha })
          report.counts.done += 1
          report.lines.push(`#${id} code, done (${lane.commitSha.slice(0, 7)}): ${lane.summary ?? result.summary}`)
          return 'on'
        case 'blocked':
          await db.finish(id, { status: 'blocked', lane: 'code', summary: SUMMARY_NEEDS_COOPER })
          report.counts.blocked += 1
          report.lines.push(`#${id} code, blocked: ${lane.reason}`)
          return 'on'
        case 'requeue':
          await db.requeue(id, { refundAttempt: true })
          skip.add(id)
          report.counts.failed += 1
          report.lines.push(`#${id} code, will retry on the next run: ${lane.reason}`)
          return 'on'
        case 'reverted':
          await db.finish(id, { status: 'blocked', lane: 'code', summary: SUMMARY_NEEDS_COOPER, commitSha: lane.commitSha })
          report.counts.blocked += 1
          report.lines.push(
            `#${id} code, REVERTED (${lane.commitSha.slice(0, 7)}): ${lane.reason}. ` +
              (lane.revertPushed ? 'The revert is on main.' : 'THE REVERT DID NOT REACH MAIN: revert it by hand.') +
              ' The code lane is paused until unpause.sh is run.',
          )
          return 'on'
        case 'agent':
          if (lane.run.kind === 'tampered' || lane.run.kind === 'unavailable') return agentUnusable(deps, report, row, lane.run)
          throw new Error('The code lane returned an agent run it should have handled')
      }
    }
  }
}

function subjectOf(report: Report): string {
  const { done, questions, blocked, failed } = report.counts
  if (report.trouble !== null) return 'Finance Watchdog: needs a look'
  const parts = [
    done > 0 ? `${done} done` : '',
    questions > 0 ? `${questions} question${questions === 1 ? '' : 's'}` : '',
    blocked > 0 ? `${blocked} blocked` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean)
  return `Finance Watchdog: ${parts.join(', ') || 'run finished'}`
}

/**
 * One run. Returns the process exit code: 0 for a run that finished (or
 * found another run already going), 1 for one that stopped on an error.
 *
 * Nothing thrown below gets past this function. Whatever happens, the lock
 * is released and — if there is anything to say — exactly one email goes out.
 */
export async function main(deps: RunDeps): Promise<number> {
  const report: Report = {
    counts: { claimed: 0, done: 0, questions: 0, blocked: 0, failed: 0 },
    lines: [],
    trouble: null,
  }
  let held = false
  let code = 0
  try {
    held = await takeLock(deps)
    /* Another run is still going. Not news. */
    if (!held) return 0

    const previous = await readLastRun(deps.paths.lastRun)
    try {
      await work(deps, report)
    } catch (error) {
      report.trouble = `The run stopped on an error: ${messageOf(error)}`
      code = 1
    }

    const started = report.trouble === null || report.counts.claimed > 0
    if (started) {
      /* Step 4. Only a run that got going counts as a run. */
      const at = deps.now()
      if (previous !== null && at.getTime() - new Date(previous.at).getTime() > THREE_DAYS_MS) {
        report.lines.unshift(`No run had finished since ${previous.at}. Check that the Mac was awake at 6:30.`)
      }
      await writeFile(deps.paths.lastRun, `${JSON.stringify({ at: at.toISOString(), ...report.counts }, null, 2)}\n`)
    }

    /* Step 5. A quiet run says nothing. */
    const lines = report.trouble === null ? report.lines : [report.trouble, ...report.lines]
    if (lines.length > 0) {
      await deps.log(lines.join('\n')).catch(() => {})
      await deps.notify({ subject: subjectOf(report), lines })
    }
    return code
  } catch (error) {
    /* The lock, the state files or the log itself failed. */
    await deps.log(`run failed: ${messageOf(error)}`).catch(() => {})
    await deps
      .notify({ subject: 'Finance Watchdog: needs a look', lines: [`The run stopped on an error: ${messageOf(error)}`] })
      .catch(() => {})
    return 1
  } finally {
    if (held) await releaseLock(deps).catch(() => {})
  }
}

/* The real thing, wired up. prompt.md is read once, here, before any agent
   has run: the clone is where this program lives, and an agent could edit
   the copy on disk. Edits to these .ts files cannot reach a process that has
   already loaded them, and the next run starts from main again. */
export async function realDeps(): Promise<RunDeps> {
  const paths = pathsFromEnv()
  const config = await loadConfig(paths.configFile)
  const template = await readFile(join(import.meta.dirname, 'prompt.md'), 'utf8')

  async function log(line: string): Promise<void> {
    await mkdir(paths.logs, { recursive: true })
    await appendFile(paths.runLog, `${new Date().toISOString()} ${line}\n`)
  }

  /* Real paths: the sandbox matches on where a file is, not on the symlink
     that led there. A missing clone is preflight's to report, so the paths
     fall back to the plain ones and the run stops there instead. */
  const real = (path: string) => realpath(path).catch(() => path)
  const gates: GateDeps = {
    sandbox: sandboxed({
      home: await real(homedir()),
      repo: await real(paths.repo),
      nodeModules: await real(join(paths.repo, 'node_modules')),
      bun: await real(join(homedir(), '.bun')),
    }),
    exec: realExec,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    repo: paths.repo,
    pausedFile: paths.paused,
  }

  return {
    paths,
    config,
    db: createDb(supabaseRunSql(realExec, paths.mainRepo)),
    notify: createNotifier({ fetch: gates.fetch, config, log }),
    log,
    now: () => new Date(),
    pid: process.pid,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        /* EPERM: the process exists and belongs to someone else. */
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    preflight: async () => {
      const clone = await stat(join(paths.repo, '.git')).then(() => true, () => false)
      if (!clone) return `the clone at ${paths.repo} is missing. Run watchdog/bin/install.sh.`
      const claude = await realExec('claude', ['--version'], { timeoutMs: 30_000 })
      if (claude.code !== 0) return 'the claude command is not on the PATH or will not start.'
      return null
    },
    resetClone: (options) => resetClone(gates, options),
    changedFiles: () => changedFiles(gates),
    runAgent: (job) =>
      runAgent({ exec: realExec, repo: paths.repo, template, model: config.model, fingerprint: protectedFingerprint(paths.repo) }, job),
    runCodeLane: (job) => runCodeLane(gates, job),
    quarantineClone: () => rename(paths.repo, join(paths.home, `repo.quarantined-${Date.now()}`)),
  }
}

if (import.meta.main) {
  process.exit(await main(await realDeps()))
}
