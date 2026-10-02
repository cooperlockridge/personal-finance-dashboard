import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth, useClerk } from '@clerk/clerk-react'
import type { TokenGetter } from './budgetApi'
import { createDeviceApi, type RememberedUser } from './deviceSession'

export type Session = {
  /** `loading` until either Clerk or the device cookie has answered. */
  status: 'loading' | 'signedIn' | 'signedOut'
  userId: string | null
  /** The member's name from the device cookie, for the greeting when Clerk has no user loaded. */
  name: string | null
  getToken: TokenGetter
  signOut(): Promise<void>
}

const deviceApi = createDeviceApi({ fetch: (input, init) => fetch(input, init) })

/**
 * Who is using the app (Oct 2, 2026). Signed in means Clerk says so *or*
 * this device is remembered — see deviceSession for why Clerk alone had
 * Laken signing in on every visit.
 *
 * Clerk going signed-out on its own is deliberately not a sign-out here: a
 * tab left open past Clerk's week-long session would otherwise forget the
 * device, which is the very case this exists for. Only the Sign out button
 * forgets it.
 */
export function useSession(): Session {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth()
  const clerk = useClerk()
  /* Clerk may hand back a new getToken on any render; effects read it
     through a ref so they re-run for a new user, not a new function. */
  const tokenRef = useRef(getToken)
  useEffect(() => {
    tokenRef.current = getToken
  }, [getToken])
  /* undefined while the first check is out. */
  const [remembered, setRemembered] = useState<RememberedUser | null | undefined>(undefined)

  useEffect(() => {
    let current = true
    void deviceApi.check().then((user) => {
      /* A sign-in that finished first already knows better. */
      if (current) setRemembered((known) => known ?? user)
    })
    return () => {
      current = false
    }
  }, [])

  /* Every Clerk sign-in (re)issues the cookie, so the year restarts. */
  useEffect(() => {
    if (!isSignedIn) return
    let current = true
    void (async () => {
      let token: string | null = null
      try {
        token = await tokenRef.current()
      } catch {
        /* No token, no cookie this time; the next load tries again. */
      }
      const user = token ? await deviceApi.remember(token) : null
      if (current && user) setRemembered(user)
    })()
    return () => {
      current = false
    }
  }, [isSignedIn, userId])

  /* Before Clerk loads, its getToken waits for a script that may never
     arrive; answering null at once lets the device cookie carry the request. */
  const sessionToken = useCallback<TokenGetter>(
    async (options) => (isLoaded && isSignedIn ? tokenRef.current(options) : null),
    [isLoaded, isSignedIn],
  )

  const signOut = useCallback(async () => {
    /* The cookie first: if it survived, she would still be signed in. */
    if (!(await deviceApi.forget())) return
    setRemembered(null)
    if (clerk.loaded) await clerk.signOut()
  }, [clerk])

  const signedIn = isSignedIn === true || Boolean(remembered)
  const settled = isLoaded && remembered !== undefined
  return {
    status: signedIn ? 'signedIn' : settled ? 'signedOut' : 'loading',
    userId: (isSignedIn ? userId : null) ?? remembered?.userId ?? null,
    name: remembered?.name ?? null,
    getToken: sessionToken,
    signOut,
  }
}
