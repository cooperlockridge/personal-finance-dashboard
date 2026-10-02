import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* The Finance Watchdog (2026-10-02).

   Laken types a change request into the app. Once a day this job, on Cooper's
   Mac, claims each new request, runs headless Claude on it and applies the
   result with nobody approving it. Everything that makes that safe lives in
   the other files here; this one only holds the numbers and the paths. */

export const MAX_REQUESTS_PER_RUN = 5
export const AGENT_MAX_SECONDS = 1800
/* A request that fails twice is not going to pass on a third morning. */
export const MAX_ATTEMPTS = 2
/* The agent gets 30 minutes and the gates a few more, so a row still claimed
   after three hours belongs to a run that died. */
export const STUCK_AFTER_MINUTES = 180
export const PROD_URL = 'https://personal-finance-dashboard-ashen.vercel.app'
export const GH_REPO = 'cooperlockridge/personal-finance-dashboard'
export const BUDGET_ID = 'lockridge'

export const DEFAULT_MAIN_REPO = '/Users/cooperlockridge/Projects/personal-finance-dashboard'
export const DEFAULT_MODEL = 'opus'
export const DEFAULT_EMAIL_FROM = 'Finance Watchdog <onboarding@resend.dev>'

/* What Laken reads when a request stops. None of them says why in detail:
   the detail goes to Cooper's email, not into the app. */
export const SUMMARY_NEEDS_COOPER = 'This one needs Cooper. He has been told.'
export const SUMMARY_FAILED_TWICE = 'This one failed twice. Cooper has been told.'
export const SUMMARY_WOULD_BREAK = "That change would break the budget, so it wasn't made."

export type Paths = {
  home: string
  /** The dedicated clone the agent edits. Never one of Cooper's worktrees. */
  repo: string
  state: string
  lock: string
  paused: string
  lastRun: string
  logs: string
  runLog: string
  runs: string
  configFile: string
  /** The checkout the Supabase CLI is linked in. Only ever passed to --workdir. */
  mainRepo: string
}

export type EnvLike = Record<string, string | undefined>

export function pathsFromEnv(env: EnvLike = process.env): Paths {
  const home = env.FINANCE_WATCHDOG_HOME?.trim() || join(homedir(), '.finance-watchdog')
  const state = join(home, 'state')
  const logs = join(home, 'logs')
  return {
    home,
    repo: join(home, 'repo'),
    state,
    lock: join(state, 'lock'),
    paused: join(state, 'paused'),
    lastRun: join(state, 'last-run.json'),
    logs,
    runLog: join(logs, 'run.log'),
    runs: join(home, 'runs'),
    configFile: join(home, 'config.json'),
    mainRepo: env.FINANCE_WATCHDOG_MAIN_REPO?.trim() || DEFAULT_MAIN_REPO,
  }
}

export type Config = {
  emailTo?: string
  resendApiKey?: string
  emailFrom?: string
  model?: string
  maxRequestsPerRun?: number
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/* Every field is optional and a wrong type is the same as a missing one, so a
   typo in config.json costs the email, never the run. */
export function parseConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const config: Config = {}
  const emailTo = text(source.emailTo)
  const resendApiKey = text(source.resendApiKey)
  const emailFrom = text(source.emailFrom)
  const model = text(source.model)
  if (emailTo) config.emailTo = emailTo
  if (resendApiKey) config.resendApiKey = resendApiKey
  if (emailFrom) config.emailFrom = emailFrom
  /* The model name becomes a command-line argument, so it is held to the
     characters a model name is made of. */
  if (model && /^[A-Za-z0-9._-]{1,64}$/.test(model)) config.model = model
  const max = source.maxRequestsPerRun
  if (typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 20) config.maxRequestsPerRun = max
  return config
}

export async function loadConfig(file: string): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    /* No file, or one that is not JSON: run with the defaults and log
       instead of sending mail. */
    return {}
  }
}
