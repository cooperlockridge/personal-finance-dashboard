import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BudgetData } from './finance'
import { createBudgetApi, type TokenGetter } from './budgetApi'
import { createSyncEngine, type StorageLike, type SyncView } from './sync'

export type BudgetSync = SyncView & {
  update(change: (data: BudgetData) => BudgetData): void
  /** Re-read the cloud now. For when something other than this device changed the budget (Oct 2, 2026: undoing a request). */
  refresh(): void
  dismissNotice(): void
}

/* Some privacy modes throw on the localStorage getter itself. */
function browserStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The shared budget for whoever is signed in. Renders from this device's
 * cache on the first frame and syncs in the background (Sep 14, 2026); see
 * createSyncEngine for the rules. Signed out, nothing is fetched. Who is
 * signed in comes from useSession, so a remembered device syncs the same way
 * a Clerk session does.
 */
export function useBudgetSync({
  signedIn,
  userId,
  getToken,
}: {
  signedIn: boolean
  userId: string | null
  getToken: TokenGetter
}): BudgetSync {
  /* The engine outlives renders, but the session may hand back a new
     getToken; reading it through a ref keeps the engine on the current one. */
  const tokenRef = useRef(getToken)
  useEffect(() => {
    tokenRef.current = getToken
  }, [getToken])

  const [engine] = useState(() =>
    createSyncEngine({
      api: createBudgetApi({
        fetch: (input, init) => fetch(input, init),
        getToken: (options) => tokenRef.current(options),
      }),
      storage: browserStorage(),
    }),
  )
  const view = useSyncExternalStore(engine.subscribe, engine.getView)

  useEffect(() => {
    if (!signedIn) return
    engine.start()
    const onFocus = () => engine.refresh()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') engine.refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      engine.stop()
    }
  }, [engine, signedIn, userId])

  return { ...view, update: engine.update, refresh: engine.refresh, dismissNotice: engine.dismissNotice }
}
