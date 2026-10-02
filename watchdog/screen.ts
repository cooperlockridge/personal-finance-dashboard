/* The first stop. Runs on what Laken typed before Claude is ever started, and
   has no side effects. A request that trips it is closed as "needs Cooper"
   and no model reads it.

   The agent's own rules already tell it the request is data. This is the
   belt to that pair of braces: text that reads like an attempt to steer the
   agent, to reach a secret, or to aim it at the files that keep it safe never
   gets the chance. It is blunt on purpose. A fund called "Secret Santa" is
   stopped too, and costs Cooper one email. */

export type Screened = { ok: true } | { ok: false, reason: ScreenReason }

export type ScreenReason =
  | 'too_long'
  | 'invisible_characters'
  | 'fence_marker'
  | 'instruction_override'
  | 'secret_word'
  | 'protected_name'

export const MAX_REQUEST_LENGTH = 2000

/* Zero-width and direction-changing characters: text that reads one way to
   Cooper in a log and another way to a model. The isolates (2066 to 2069) and
   the control characters sit beside the ranges first asked for; a NUL in
   particular could not be written to Postgres. Tab and newline are ordinary.
   Written as code points so this file holds none of the characters itself. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
]

function hasInvisible(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)) return true
  }
  return false
}

/* The lines agent.ts wraps the request in. The real ones carry a code made
   fresh for each run, so a copy typed here could not close the fence — but
   nobody types this by accident. */
const FENCE = /<<<|>>>|REQUEST-(BEGIN|END)/i

/* \s+ rather than one space, so a line break or a doubled space between the
   words does not slip past. */
const OVERRIDES = [
  /ignore\s+(all\s+|the\s+)?(previous|above|prior)/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /disregard/i,
]

const SECRETS = [
  /\.env/i,
  /api[\s_-]*key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /ssh/i,
  /private[\s_-]*key/i,
]

/* The parts of the repository the agent must never be pointed at. */
const PROTECTED = [/watchdog/i, /migrateBudget/i, /api\//i, /supabase/i, /vercel\.json/i, /package\.json/i, /\.github/i]

export function screenRequest(text: string): Screened {
  if (text.length > MAX_REQUEST_LENGTH) return { ok: false, reason: 'too_long' }
  if (hasInvisible(text)) return { ok: false, reason: 'invisible_characters' }
  if (FENCE.test(text)) return { ok: false, reason: 'fence_marker' }
  if (OVERRIDES.some((pattern) => pattern.test(text))) return { ok: false, reason: 'instruction_override' }
  if (SECRETS.some((pattern) => pattern.test(text))) return { ok: false, reason: 'secret_word' }
  if (PROTECTED.some((pattern) => pattern.test(text))) return { ok: false, reason: 'protected_name' }
  return { ok: true }
}
