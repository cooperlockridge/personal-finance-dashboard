import { DEFAULT_EMAIL_FROM, type Config } from './config.ts'
import type { FetchLike } from './gates.ts'

/* Cooper's one view of an unattended job: an email per run that did
   anything. With no email settings in config.json the same text goes to
   run.log instead, so a fresh install works before Resend is set up. */

export type Message = { subject: string, lines: string[] }
export type Notify = (message: Message) => Promise<{ sent: boolean }>

const RESEND_URL = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 15_000

export function createNotifier(deps: {
  fetch: FetchLike
  config: Config
  /** Appends one entry to logs/run.log. */
  log: (line: string) => Promise<void> | void
}): Notify {
  return async ({ subject, lines }) => {
    const text = lines.join('\n')
    const { emailTo, resendApiKey, emailFrom } = deps.config
    try {
      if (!emailTo || !resendApiKey) {
        await deps.log(`[not emailed] ${subject}\n${text}`)
        return { sent: false }
      }
      const response = await deps.fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: emailFrom ?? DEFAULT_EMAIL_FROM, to: [emailTo], subject, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (response.ok) return { sent: true }
      /* The status only. Resend's error body can echo the request, and the
         request carries the key. */
      await deps.log(`[email failed: ${response.status}] ${subject}\n${text}`)
      return { sent: false }
    } catch {
      /* Mail is the last thing a run does, often while reporting another
         failure. It must not become the failure. */
      try {
        await deps.log(`[email failed] ${subject}\n${text}`)
      } catch {
        /* Nowhere left to say it. */
      }
      return { sent: false }
    }
  }
}
