import { useState } from 'react'
import { SignInButton } from '@clerk/clerk-react'
import { useSession } from './lib/useSession'

/* The approval screen for Claude's connector (Oct 19, 2026). Claude sends
   her to /oauth/authorize, which bounces to /?connect=<signed request>. This
   screen shows what is asking, and Allow posts back with the same proof of
   who she is that every budget call uses. The server answers with where to
   send the browser next: Claude's callback, carrying the code or the denial. */

type Pending = { name: string; host: string }

/* Only for showing what is asking. The server re-checks the signature, so a
   tampered link fails there no matter what this reads. */
function describe(request: string): Pending | null {
  try {
    const payload = request.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(payload)) as Record<string, unknown>
    const host = new URL(String(claims.ru)).host
    return { name: typeof claims.name === 'string' ? claims.name : 'Claude', host }
  } catch {
    return null
  }
}

const buttonClass =
  'min-h-11 rounded-apple px-6 text-[15px] font-medium sm:min-h-0 sm:py-2 sm:text-[14px] disabled:cursor-not-allowed disabled:opacity-50'

export function ConnectClaude({ request }: { request: string }) {
  const session = useSession()
  const pending = describe(request)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function decide(decision: 'allow' | 'deny') {
    setBusy(true)
    setError('')
    let token: string | null = null
    try {
      token = await session.getToken()
    } catch {
      /* The device cookie carries the request instead. */
    }
    try {
      const response = await fetch('/api/oauth?step=authorize', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ request, decision }),
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (response.ok && typeof body.redirect === 'string') {
        window.location.assign(body.redirect)
        return
      }
      setError(
        body.error === 'request_expired'
          ? 'This link expired. Go back to Claude and connect again.'
          : body.error === 'not_member'
            ? "This login isn't on the budget yet, so Claude can't be connected to it."
            : response.status === 401
              ? 'Sign in again, then tap Allow.'
              : "Couldn't connect. Try again.",
      )
    } catch {
      setError("Couldn't reach the server. Check the connection and try again.")
    }
    setBusy(false)
  }

  return (
    <div className="min-h-dvh bg-surface-base text-ink-body">
      <header className="border-b border-border-default">
        <div className="mx-auto max-w-[1200px] px-4 py-3 sm:px-6">
          <h1 className="text-[16px] font-semibold text-ink-heading">Laken's Finance</h1>
        </div>
      </header>
      <main className="mx-auto max-w-md px-4 py-12 sm:py-20">
        <section className="rounded-apple border border-border-default bg-surface-tint p-6">
          {!pending ? (
            <>
              <p className="text-[17px] font-semibold text-ink-heading">This link isn't valid</p>
              <p className="mt-2 text-[14px] text-pretty text-ink-caption">
                Go back to Claude and start connecting again.
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] text-ink-rose">Connect to Claude 🌸</p>
              <p className="mt-1 text-[19px] font-semibold text-pretty text-ink-heading">
                Let {pending.name} use your budget?
              </p>
              <p className="mt-3 text-[14px] text-pretty text-ink-body">
                Claude will be able to see everything on the dashboard and make changes for you: log
                paychecks, edit envelopes and sinking funds, move money, add random savings, and change
                settings. Changes show up here right away.
              </p>
              <p className="mt-2 text-[12px] text-ink-caption">Returns to {pending.host}</p>

              {session.status === 'loading' && (
                <p className="mt-5 text-[13px] text-ink-caption">Checking who's signed in…</p>
              )}
              {session.status === 'signedOut' && (
                <div className="mt-5">
                  <p className="text-[13px] text-pretty text-ink-caption">Sign in first so Claude connects to your budget.</p>
                  {/* A Google sign-in leaves the page; without these Clerk lands on /
                      and the ?connect= link is lost (found testing, Oct 19, 2026). */}
                  <SignInButton
                    mode="modal"
                    forceRedirectUrl={window.location.href}
                    signUpForceRedirectUrl={window.location.href}
                  >
                    <button type="button" className={`${buttonClass} mt-3 bg-pink text-ink-heading hover:bg-pink-hover`}>
                      Sign in
                    </button>
                  </SignInButton>
                </div>
              )}
              {session.status === 'signedIn' && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide('allow')}
                    className={`${buttonClass} bg-pink text-ink-heading hover:bg-pink-hover`}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide('deny')}
                    className={`${buttonClass} text-ink-caption hover:text-ink-heading`}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {error && <p className="mt-3 text-[13px] text-accent">{error}</p>}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
