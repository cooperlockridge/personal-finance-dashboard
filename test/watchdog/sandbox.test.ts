import { describe, expect, test } from 'bun:test'
import { runGates, type GateDeps } from '../../watchdog/gates.ts'
import { SANDBOX_EXEC, sandboxed, sandboxProfile } from '../../watchdog/sandbox.ts'

/* The profile is text handed to macOS, so what can be tested here is the
   text: that the home folder is closed before anything is opened, that the
   network and the keychain are closed, and that a path cannot write rules of
   its own. That the profile really holds was checked by hand (see sandbox.ts). */

const PATHS = {
  home: '/Users/cooper',
  repo: '/Users/cooper/.finance-watchdog/repo',
  nodeModules: '/Users/cooper/Projects/app/node_modules',
  bun: '/Users/cooper/.bun',
}

describe('sandbox profile', () => {
  const profile = sandboxProfile(PATHS)

  test('closes the network and the keychain', () => {
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny mach-lookup (global-name "com.apple.SecurityServer")')
  })

  test('closes the home folder before it opens the clone, node_modules and bun', () => {
    const denyRead = profile.indexOf('(deny file-read* (subpath "/Users/cooper"))')
    const allowRead = profile.indexOf(
      '(allow file-read* (subpath "/Users/cooper/.finance-watchdog/repo") (subpath "/Users/cooper/Projects/app/node_modules") (subpath "/Users/cooper/.bun"))',
    )
    expect(denyRead).toBeGreaterThan(-1)
    expect(allowRead).toBeGreaterThan(denyRead)
  })

  test('writes reach only the clone and the three build caches', () => {
    const denyWrite = profile.indexOf('(deny file-write* (subpath "/Users/cooper"))')
    const allowWrite = profile.slice(profile.indexOf('(allow file-write*'))
    expect(denyWrite).toBeGreaterThan(-1)
    expect(profile.indexOf('(allow file-write*')).toBeGreaterThan(denyWrite)
    expect(allowWrite).toBe(
      '(allow file-write* (subpath "/Users/cooper/.finance-watchdog/repo") (subpath "/Users/cooper/Projects/app/node_modules/.tmp") (subpath "/Users/cooper/Projects/app/node_modules/.vite") (subpath "/Users/cooper/Projects/app/node_modules/.vite-temp"))',
    )
  })

  test('a path that could close the quoted string is refused', () => {
    for (const bad of ['/Users/co"oper', '/Users/co\\oper', '/Users/co\noper', 'relative/path', '']) {
      expect(() => sandboxProfile({ ...PATHS, repo: bad })).toThrow()
      expect(() => sandboxProfile({ ...PATHS, home: bad })).toThrow()
    }
  })
})

describe('gates inside the sandbox', () => {
  test('every gate is started through sandbox-exec, with its own command after the profile', async () => {
    const started: { command: string, args: string[] }[] = []
    const deps: GateDeps = {
      exec: async (command, args) => {
        started.push({ command, args })
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
      fetch: async () => new Response(''),
      sleep: async () => {},
      readFile: async () => '',
      writeFile: async () => {},
      repo: PATHS.repo,
      pausedFile: '/tmp/paused',
      sandbox: sandboxed(PATHS),
    }
    expect((await runGates(deps, '/tmp/run', 'first')).ok).toBe(true)
    expect(started).toHaveLength(4)
    for (const run of started) {
      expect(run.command).toBe(SANDBOX_EXEC)
      expect(run.args.slice(0, 2)).toEqual(['-p', sandboxProfile(PATHS)])
    }
    expect(started.map((run) => run.args[2])).toEqual([
      `${PATHS.repo}/node_modules/.bin/tsc`,
      'bun',
      `${PATHS.repo}/node_modules/.bin/oxlint`,
      `${PATHS.repo}/node_modules/.bin/vite`,
    ])
  })
})
