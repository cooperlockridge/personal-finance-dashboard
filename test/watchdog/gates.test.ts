import { beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRun } from '../../watchdog/agent.ts'
import type { ExecOptions, ExecResult } from '../../watchdog/exec.ts'
import {
  changedFiles,
  deployProblem,
  migrateBudgetSource,
  pathViolations,
  resetClone,
  runCodeLane,
  type GateDeps,
} from '../../watchdog/gates.ts'

/* The code lane with nothing real behind it: git, gh, the four gates, the
   live site, the clock and the disk are all a script the test writes. What
   is asserted is the order of commands — above all, that nothing is pushed
   once a rule has been broken, and that a bad deploy is taken back out. */

const REPO = '/home/repo'
const PAUSED = '/home/state/paused'
const RUN_DIR = '/home/runs/7-test'
const SHA = 'a'.repeat(40)
const PROD = 'https://personal-finance-dashboard-ashen.vercel.app'

const FINANCE = [
  'export const A = 1',
  '',
  'export function migrateBudget(data: BudgetData): BudgetData {',
  '  if (data.envelopes.length === 0) return data',
  '  return { ...data }',
  '}',
  '',
  'export function other() {',
  '  return 1',
  '}',
  '',
].join('\n')

type World = {
  /* What `git status --porcelain -z` prints. */
  status: string
  numstat: string
  financeOnMain: string
  financeNow: string
  /* Exit codes for each gate, one entry per round. */
  gateCodes: Record<string, number[]>
  pushCodes: number[]
  ghStates: string[]
  revertCode: number
  home: { status: number, body: string }
  device: { status: number, body: string }
}

let world: World
let calls: string[]
let execOptions: { command: string, options?: ExecOptions }[]
let files: Map<string, string>
let slept: number
let fetched: { url: string, init?: RequestInit }[]
let deps: GateDeps

function ok(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

beforeEach(() => {
  world = {
    status: ' M src/App.tsx\0?? src/lib/monthly.ts\0?? test/client/monthly.test.ts\0',
    numstat: '10\t2\tsrc/App.tsx\n30\t0\tsrc/lib/monthly.ts\n25\t0\ttest/client/monthly.test.ts\n',
    financeOnMain: FINANCE,
    financeNow: FINANCE,
    gateCodes: {},
    pushCodes: [],
    ghStates: ['pending', 'success'],
    revertCode: 0,
    home: { status: 200, body: '<html><body><div id="root"></div></body></html>' },
    device: { status: 401, body: '{"error":"unauthorized"}' },
  }
  calls = []
  execOptions = []
  files = new Map()
  slept = 0
  fetched = []

  deps = {
    repo: REPO,
    pausedFile: PAUSED,
    now: () => new Date('2026-10-02T10:30:00.000Z'),
    sleep: async (ms) => {
      slept += ms
    },
    readFile: async (path) => {
      if (path === join(REPO, 'src/lib/finance.ts')) return world.financeNow
      throw new Error(`no such file: ${path}`)
    },
    writeFile: async (path, text) => {
      files.set(path, text)
    },
    fetch: async (url, init) => {
      fetched.push({ url, init })
      const answer = url === `${PROD}/` ? world.home : world.device
      return new Response(answer.body, { status: answer.status })
    },
    exec: async (command, args, options) => {
      execOptions.push({ command, options })
      if (command === 'git') {
        /* Every git call must switch hooks and fsmonitor off. */
        expect(args.slice(0, 4)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
        expect(options?.cwd).toBe(REPO)
        const rest = args.slice(4)
        calls.push(`git ${rest.join(' ')}`)
        const sub = rest.find((arg, i) => arg !== '-c' && rest[i - 1] !== '-c')
        if (sub === 'status') return ok(world.status)
        if (sub === 'show') return ok(world.financeOnMain)
        if (sub === 'diff') return ok(world.numstat)
        if (sub === 'rev-parse') return ok(`${SHA}\n`)
        if (sub === 'push') return { ...ok(), code: world.pushCodes.shift() ?? 0, stderr: '! [rejected] HEAD -> main (fetch first)' }
        if (sub === 'revert') return { ...ok(), code: world.revertCode }
        return ok()
      }
      if (command === 'gh') {
        calls.push(`gh ${args.join(' ')}`)
        return ok(`${world.ghStates.length > 1 ? world.ghStates.shift() : world.ghStates[0]}\n`)
      }
      const name = command === 'bun' ? 'bun' : command.slice(command.lastIndexOf('/') + 1)
      calls.push(`gate ${name} ${args.join(' ')}`.trim())
      const code = world.gateCodes[name]?.shift() ?? 0
      return { code, stdout: `${name} output`, stderr: code === 0 ? '' : `${name} FAILED: something is wrong`, timedOut: false }
    },
  }
})

const noRepair = async (): Promise<AgentRun> => {
  throw new Error('the repair round should not have run')
}

const job = (repair: (output: string) => Promise<AgentRun> = noRepair) => ({ requestId: 7, runDir: RUN_DIR, repair })

const RESET = ['git reset -q --hard origin/main', 'git clean -fdq']
const CHECKS = [
  'git status --porcelain -z --untracked-files=all',
  'git show HEAD:src/lib/finance.ts',
  'git add -A -- . :(exclude).watchdog',
  'git diff --cached --numstat HEAD',
]
const GATES = ['gate tsc -b', 'gate bun test', 'gate oxlint', 'gate vite build']
const COMMIT = 'git -c user.name=Watchdog -c user.email=watchdog@localhost commit -q --no-verify -m Watchdog: request #7'
const PUSH = 'git push origin HEAD:main'
const STATUS_POLL = `gh api repos/cooperlockridge/personal-finance-dashboard/commits/${SHA}/status -q .state`

function neverShipped() {
  expect(calls.some((call) => call.includes('commit'))).toBe(false)
  expect(calls.some((call) => call.includes('push'))).toBe(false)
  expect(calls.some((call) => call.startsWith('gh'))).toBe(false)
  expect(fetched).toHaveLength(0)
}

describe('changedFiles', () => {
  test('lists every path, both names of a rename, and never the agent folder', async () => {
    world.status = [' M src/App.tsx', '?? public/new icon.svg', 'R  src/lib/new.ts', 'src/lib/old.ts', '?? .watchdog/result.json', 'D  api/budget.ts', ''].join('\0')
    expect(await changedFiles(deps)).toEqual(['api/budget.ts', 'public/new icon.svg', 'src/App.tsx', 'src/lib/new.ts', 'src/lib/old.ts'])
  })

  test('a clean clone has none', async () => {
    world.status = ''
    expect(await changedFiles(deps)).toEqual([])
    world.status = '?? .watchdog/budget.json\0?? .watchdog/result.json\0'
    expect(await changedFiles(deps)).toEqual([])
  })

  test('a non-code outcome that left edits behind is seen', async () => {
    world.status = ' M src/App.tsx\0?? .watchdog/result.json\0'
    expect(await changedFiles(deps)).toEqual(['src/App.tsx'])
  })
})

describe('pathViolations', () => {
  test('the allow-list: src, test/client, public and index.html', () => {
    expect(pathViolations(['src/App.tsx', 'src/lib/finance.ts', 'src/lib/new/deep.ts', 'test/client/x.test.ts', 'public/icon.svg', 'index.html'])).toEqual([])
  })

  test('everything else is refused', () => {
    for (const file of [
      'api/budget.ts',
      'api/_lib/device.ts',
      'watchdog/gates.ts',
      'watchdog/prompt.md',
      'test/api/budget.test.ts',
      'test/watchdog/gates.test.ts',
      'supabase/migrations/20261003_x.sql',
      'package.json',
      'package-lock.json',
      'vercel.json',
      'vite.config.ts',
      'tsconfig.json',
      'README.md',
      'srcs/x.ts',
      'src',
      'index.html.bak',
      'docs/index.html',
    ]) {
      expect(pathViolations([file])).toHaveLength(1)
    }
  })

  test('the deny-list inside src, in any letter case', () => {
    for (const file of [
      'src/lib/sync.ts',
      'src/lib/budgetApi.ts',
      'src/lib/deviceSession.ts',
      'src/lib/useSession.ts',
      'src/lib/useBudgetSync.ts',
      'src/lib/requestsApi.ts',
      'src/main.tsx',
      'src/lib/Sync.ts',
      'src/MAIN.TSX',
    ]) {
      expect(pathViolations([file])).toEqual([`${file}: sign-in and sync files are off limits`])
    }
  })

  test('dot-files, traversal and odd paths are refused even under an allowed folder', () => {
    for (const file of ['.github/workflows/ci.yml', '.gitignore', '.env', 'src/.gitattributes', 'src/.env.local', 'public/.well-known/x', 'src/../api/budget.ts', '../outside.ts', '/etc/passwd', 'src//x.ts', 'src\\lib\\sync.ts', 'src/nested-repo/']) {
      expect(pathViolations([file])).toHaveLength(1)
    }
  })

  test('one bad file among good ones is still reported', () => {
    expect(pathViolations(['src/App.tsx', 'api/budget.ts', 'index.html'])).toEqual(['api/budget.ts: outside src/, test/client/, public/ and index.html'])
  })
})

describe('migrateBudgetSource', () => {
  test('is the function, from its export line to its closing brace', () => {
    expect(migrateBudgetSource(FINANCE)).toBe(
      'export function migrateBudget(data: BudgetData): BudgetData {\n  if (data.envelopes.length === 0) return data\n  return { ...data }\n}\n',
    )
  })

  test('finds the real one in src/lib/finance.ts', async () => {
    const source = migrateBudgetSource(await readFile(join(import.meta.dir, '../../src/lib/finance.ts'), 'utf8'))
    expect(source?.startsWith('export function migrateBudget(data: BudgetData): BudgetData {')).toBe(true)
    expect(source?.endsWith("return { ...data, envelopes: next, funds: nextFunds }\n}\n")).toBe(true)
    expect(source).not.toContain('grossForCheck')
  })

  test('is null when the function is gone, renamed or doubled', () => {
    expect(migrateBudgetSource('export const x = 1\n')).toBeNull()
    expect(migrateBudgetSource(FINANCE.replace('migrateBudget(', 'migrateBudgetOld('))).toBeNull()
    expect(migrateBudgetSource(`${FINANCE}\nfunction migrateBudget() {}\n`)).toBeNull()
  })
})

describe('runCodeLane', () => {
  test('a clean change is checked, gated, committed, pushed and verified live — in that order', async () => {
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'done', commitSha: SHA, summary: undefined })
    expect(calls).toEqual([...CHECKS, ...GATES, COMMIT, 'git rev-parse HEAD', PUSH, STATUS_POLL, STATUS_POLL])
    expect(slept).toBe(15_000)
    expect(fetched.map((f) => f.url)).toEqual([`${PROD}/`, `${PROD}/api/device`])
    expect(new Headers(fetched[1].init?.headers).get('accept')).toBe('application/json')
    expect(files.has(PAUSED)).toBe(false)
  })

  test("each gate's full output is saved, and vite builds with the check-only Clerk key", async () => {
    await runCodeLane(deps, job())
    for (const name of ['tsc', 'bun-test', 'oxlint', 'vite-build']) {
      expect(files.get(join(RUN_DIR, `gate-first-${name}.log`))).toContain('exit 0')
    }
    expect(files.get(join(RUN_DIR, 'gate-first-tsc.log'))).toContain('tsc output')
    const gateRuns = execOptions.filter((run) => run.command !== 'git' && run.command !== 'gh')
    expect(gateRuns.map((run) => run.command)).toEqual([
      `${REPO}/node_modules/.bin/tsc`,
      'bun',
      `${REPO}/node_modules/.bin/oxlint`,
      `${REPO}/node_modules/.bin/vite`,
    ])
    expect(gateRuns[3].options?.env).toEqual({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_build_check' })
    expect(gateRuns.every((run) => run.options?.cwd === REPO)).toBe(true)
  })

  test('the commit carries the request number and nothing of the request', async () => {
    await runCodeLane(deps, { ...job(), requestId: 31 })
    const commit = calls.find((call) => call.includes(' commit '))
    expect(commit).toBe('git -c user.name=Watchdog -c user.email=watchdog@localhost commit -q --no-verify -m Watchdog: request #31')
    await expect(runCodeLane(deps, { ...job(), requestId: Number.NaN })).rejects.toThrow()
  })

  test('a file outside the allow-list blocks the change before anything is staged', async () => {
    world.status = ' M src/App.tsx\0 M api/budget.ts\0'
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'blocked', reason: 'api/budget.ts: outside src/, test/client/, public/ and index.html' })
    expect(calls).toEqual([CHECKS[0], ...RESET])
    neverShipped()
  })

  test('a deny-listed file blocks the change', async () => {
    world.status = ' M src/lib/sync.ts\0'
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'blocked', reason: 'src/lib/sync.ts: sign-in and sync files are off limits' })
    expect(calls).toEqual([CHECKS[0], ...RESET])
    neverShipped()
  })

  test('a one-character change to migrateBudget blocks the change', async () => {
    world.status = ' M src/lib/finance.ts\0'
    world.financeNow = FINANCE.replace('return { ...data }', 'return { ...data  }')
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'blocked', reason: 'src/lib/finance.ts: migrateBudget was changed' })
    expect(calls).toEqual([CHECKS[0], CHECKS[1], ...RESET])
    neverShipped()
  })

  test('a new step in migrateBudget, a second migrateBudget, or a deleted one all block', async () => {
    world.status = ' M src/lib/finance.ts\0'
    for (const edited of [
      FINANCE.replace('  return { ...data }', "  data.funds = []\n  return { ...data }"),
      `${FINANCE}\nexport function migrateBudget2() {}\nfunction migrateBudget() {}\n`,
      FINANCE.replace(/export function migrateBudget[\s\S]*?\n}\n/, ''),
    ]) {
      world.financeNow = edited
      calls = []
      expect((await runCodeLane(deps, job())).kind).toBe('blocked')
      neverShipped()
    }
  })

  test('finance.ts may change elsewhere as long as migrateBudget is byte-identical', async () => {
    world.status = ' M src/lib/finance.ts\0'
    world.numstat = '3\t1\tsrc/lib/finance.ts\n'
    world.financeNow = FINANCE.replace('return 1', 'return 2').replace('export const A = 1', 'export const A = 1\nexport const B = 2')
    expect((await runCodeLane(deps, job())).kind).toBe('done')
  })

  test('more than 600 changed lines blocks; exactly 600 does not', async () => {
    world.numstat = '400\t200\tsrc/App.tsx\n'
    expect((await runCodeLane(deps, job())).kind).toBe('done')

    calls = []
    fetched = []
    world.ghStates = ['success']
    world.numstat = '400\t201\tsrc/App.tsx\n'
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'blocked', reason: '601 lines changed, over the limit of 600' })
    expect(calls).toEqual([...CHECKS, ...RESET])
    neverShipped()
  })

  test('more than 12 files blocks; exactly 12 does not', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => `1\t0\tsrc/lib/file${i}.ts`).join('\n')
    world.numstat = rows(12)
    expect((await runCodeLane(deps, job())).kind).toBe('done')

    calls = []
    fetched = []
    world.ghStates = ['success']
    world.numstat = rows(13)
    expect(await runCodeLane(deps, job())).toEqual({ kind: 'blocked', reason: '13 files changed, over the limit of 12' })
    neverShipped()
  })

  test('a binary file blocks', async () => {
    world.numstat = '-\t-\tpublic/photo.png\n'
    expect(await runCodeLane(deps, job())).toEqual({ kind: 'blocked', reason: 'public/photo.png: a binary file' })
    neverShipped()
  })

  test('choosing the code lane and changing nothing blocks', async () => {
    world.status = '?? .watchdog/result.json\0'
    expect((await runCodeLane(deps, job())).kind).toBe('blocked')
    neverShipped()
  })

  test('a failed gate gets one repair round, told what failed, then every rule and gate again', async () => {
    world.gateCodes = { tsc: [1, 0], bun: [1, 0] }
    const repairs: string[] = []
    const result = await runCodeLane(
      deps,
      job(async (output) => {
        repairs.push(output)
        return { kind: 'ok', result: { outcome: 'code', summary: 'Fixed and added.' } }
      }),
    )
    expect(result).toEqual({ kind: 'done', commitSha: SHA, summary: 'Fixed and added.' })
    expect(repairs).toHaveLength(1)
    expect(repairs[0]).toContain('tsc FAILED: something is wrong')
    expect(repairs[0]).toContain('bun FAILED: something is wrong')
    expect(repairs[0]).not.toContain('oxlint')
    /* All four gates ran even though the first failed. */
    expect(calls).toEqual([...CHECKS, ...GATES, ...CHECKS, ...GATES, COMMIT, 'git rev-parse HEAD', PUSH, STATUS_POLL, STATUS_POLL])
    expect(files.get(join(RUN_DIR, 'gate-first-tsc.log'))).toContain('exit 1')
    expect(files.get(join(RUN_DIR, 'gate-repair-tsc.log'))).toContain('exit 0')
  })

  test('gates still failing after the repair round blocks, with no second repair', async () => {
    world.gateCodes = { oxlint: [1, 1, 1] }
    let repairs = 0
    const result = await runCodeLane(
      deps,
      job(async () => {
        repairs += 1
        return { kind: 'ok', result: { outcome: 'code', summary: 'Tried.' } }
      }),
    )
    expect(result).toEqual({ kind: 'blocked', reason: 'The checks still failed after the repair round' })
    expect(repairs).toBe(1)
    expect(calls.slice(-2)).toEqual(RESET)
    neverShipped()
  })

  test('a repair round that breaks a rule blocks before the gates run again', async () => {
    world.gateCodes = { tsc: [1] }
    const result = await runCodeLane(
      deps,
      job(async () => {
        world.status = ' M src/App.tsx\0 M package.json\0'
        return { kind: 'ok', result: { outcome: 'code', summary: 'Added a dependency.' } }
      }),
    )
    expect(result).toEqual({ kind: 'blocked', reason: 'package.json: outside src/, test/client/, public/ and index.html' })
    expect(calls).toEqual([...CHECKS, ...GATES, CHECKS[0], ...RESET])
    neverShipped()
  })

  test('a repair round that fails or changes its mind blocks', async () => {
    for (const again of [
      { kind: 'failed', reason: 'claude exited 1' },
      { kind: 'ok', result: { outcome: 'decline', summary: 'Too hard.' } },
      { kind: 'ok', result: { outcome: 'question', question: 'Which?' } },
    ] as AgentRun[]) {
      world.gateCodes = { tsc: [1] }
      calls = []
      const result = await runCodeLane(deps, job(async () => again))
      expect(result.kind).toBe('blocked')
      expect(calls.slice(-2)).toEqual(RESET)
      neverShipped()
    }
  })

  test('a tampered repair run is handed back with no git command run after it', async () => {
    world.gateCodes = { tsc: [1] }
    const tampered: AgentRun = { kind: 'tampered', reason: 'Files under .git changed' }
    const result = await runCodeLane(deps, job(async () => tampered))
    expect(result).toEqual({ kind: 'agent', run: tampered })
    expect(calls).toEqual([...CHECKS, ...GATES])
  })

  test('a rejected push is a requeue: the clone is reset and nothing is forced', async () => {
    world.pushCodes = [1]
    const result = await runCodeLane(deps, job())
    expect(result.kind).toBe('requeue')
    expect(calls).toEqual([...CHECKS, ...GATES, COMMIT, 'git rev-parse HEAD', PUSH, ...RESET])
    expect(calls.some((call) => call.includes('--force') || call.includes(' -f ') || call.includes('+HEAD'))).toBe(false)
    expect(calls.some((call) => call.startsWith('gh'))).toBe(false)
    expect(fetched).toHaveLength(0)
    expect(files.has(PAUSED)).toBe(false)
  })

  const REVERT = `git -c user.name=Watchdog -c user.email=watchdog@localhost revert --no-edit ${SHA}`

  test('a deploy that reports failure is reverted, pushed, and the lane paused', async () => {
    world.ghStates = ['pending', 'failure']
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'reverted', commitSha: SHA, reason: 'The deploy reported failure', revertPushed: true })
    expect(calls.slice(-2)).toEqual([REVERT, PUSH])
    expect(files.get(PAUSED)).toBe(`2026-10-02T10:30:00.000Z\nCommit ${SHA}: The deploy reported failure\nThe commit was reverted on main.\n`)
    expect(fetched).toHaveLength(0)
  })

  test('a deploy still pending after 10 minutes is reverted', async () => {
    world.ghStates = ['pending']
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'reverted', commitSha: SHA, reason: 'The deploy did not finish within 10 minutes', revertPushed: true })
    expect(calls.filter((call) => call === STATUS_POLL)).toHaveLength(40)
    expect(slept).toBe(40 * 15_000)
    expect(files.has(PAUSED)).toBe(true)
  })

  test('a green deploy with a broken home page is reverted', async () => {
    world.ghStates = ['success']
    for (const home of [{ status: 500, body: 'error' }, { status: 200, body: '<html>blank</html>' }]) {
      world.home = home
      calls = []
      files.clear()
      const result = await runCodeLane(deps, job())
      expect(result.kind).toBe('reverted')
      expect(calls.slice(-2)).toEqual([REVERT, PUSH])
      expect(files.has(PAUSED)).toBe(true)
    }
  })

  test('a green deploy whose API stopped refusing strangers is reverted', async () => {
    world.ghStates = ['success']
    for (const device of [
      { status: 200, body: '{"userId":"user_laken"}' },
      { status: 500, body: 'FUNCTION_INVOCATION_FAILED' },
      { status: 401, body: '{"error":"something_else"}' },
    ]) {
      world.device = device
      calls = []
      files.clear()
      expect((await runCodeLane(deps, job())).kind).toBe('reverted')
      expect(calls.slice(-2)).toEqual([REVERT, PUSH])
    }
  })

  test('when the revert cannot be pushed the lane is still paused, and says so loudly', async () => {
    world.ghStates = ['error']
    world.pushCodes = [0, 1]
    const result = await runCodeLane(deps, job())
    expect(result).toEqual({ kind: 'reverted', commitSha: SHA, reason: 'The deploy reported error', revertPushed: false })
    expect(files.get(PAUSED)).toContain('THE REVERT DID NOT REACH MAIN')
  })
})

describe('deployProblem', () => {
  test('a site that comes good on a later try is healthy', async () => {
    world.ghStates = ['success']
    let asked = 0
    const inner = deps.fetch
    deps.fetch = async (url, init) => {
      asked += 1
      if (asked === 1) return new Response('old build', { status: 503 })
      return inner(url, init)
    }
    expect(await deployProblem(deps, SHA)).toBeNull()
  })

  test('a site that cannot be reached is a problem, not a crash', async () => {
    world.ghStates = ['success']
    deps.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await deployProblem(deps, SHA)).toContain('could not be reached')
  })

  test('a failing gh call counts as no news and the wait goes on', async () => {
    let polls = 0
    const inner = deps.exec
    deps.exec = async (command, args, options) => {
      if (command === 'gh' && (polls += 1) < 3) return { code: 1, stdout: '', stderr: 'HTTP 502', timedOut: false }
      world.ghStates = ['success']
      return inner(command, args, options)
    }
    expect(await deployProblem(deps, SHA)).toBeNull()
    expect(polls).toBe(3)
  })
})

describe('resetClone', () => {
  test('fetches when asked, then discards everything that is not on main', async () => {
    await resetClone(deps, { fetch: true })
    expect(calls).toEqual(['git fetch -q origin', ...RESET])
    calls = []
    await resetClone(deps, { fetch: false })
    expect(calls).toEqual(RESET)
  })

  test('a failing git command throws rather than carrying on', async () => {
    deps.exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false })
    await expect(resetClone(deps, { fetch: true })).rejects.toThrow('git fetch failed')
  })
})
