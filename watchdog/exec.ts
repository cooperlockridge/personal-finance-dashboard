import { spawn } from 'node:child_process'

/* Every program the watchdog starts — git, claude, supabase, gh, the gates —
   goes through one function of this shape. The modules take it as a
   parameter, so the tests hand them a script of answers and nothing real is
   ever started. */

export type ExecOptions = {
  cwd?: string
  /** Added to the watchdog's own environment for this one command. */
  env?: Record<string, string>
  timeoutMs?: number
}

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

/* Enough for a full test run's output; past it the tail is what matters. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/* Arguments go to the program as an array. No shell reads them, so nothing in
   a request, a path or a model's answer can be taken for shell syntax. */
export const realExec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    function finish(code: number) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    /* SIGKILL, not SIGTERM: the limit is a hard stop, and a program that is
       stuck is not one to ask politely. */
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : null

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    /* A program that is not installed fails here rather than exiting. */
    child.on('error', (error) => {
      stderr += String(error)
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
