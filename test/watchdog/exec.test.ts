import { describe, expect, test } from 'bun:test'
import { realExec } from '../../watchdog/exec.ts'

/* The one real side effect under test: starting a program. Only echo, sh and
   sleep are ever started here. */

describe('realExec', () => {
  test('returns the exit code and both streams', async () => {
    expect(await realExec('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'])).toEqual({
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
      timedOut: false,
    })
  })

  test('arguments reach the program as they are, with no shell reading them', async () => {
    const hostile = `'; touch /tmp/should-not-exist; echo $(whoami) \`id\` "`
    expect((await realExec('/bin/echo', [hostile])).stdout).toBe(`${hostile}\n`)
  })

  test('env is added to the environment and cwd is honoured', async () => {
    const result = await realExec('/bin/sh', ['-c', 'echo "$WATCHDOG_TEST_VALUE"; pwd'], { env: { WATCHDOG_TEST_VALUE: 'pk_test' }, cwd: '/' })
    expect(result.stdout).toBe('pk_test\n/\n')
  })

  test('a program that is not installed is a failure, not a throw', async () => {
    const result = await realExec('/nonexistent/watchdog-test-binary', [])
    expect(result.code).toBe(127)
    expect(result.timedOut).toBe(false)
  })

  test('a program that runs past its limit is killed', async () => {
    const started = Date.now()
    const result = await realExec('/bin/sleep', ['5'], { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
