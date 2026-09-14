import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '@clerk/clerk-react'
import type { BudgetData } from './finance'
import { createBudgetApi } from './budgetApi'
import { createSyncEngine, type StorageLike, type SyncView } from './sync'

export type BudgetSync = SyncView & {
  update(change: (data: BudgetData) => BudgetData): void
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
 * createSyncEngine for the rules. Signed out, nothing is fetched.
 */
export function useBudgetSync(): BudgetSync {
  const { isSignedIn, userId, getToken } = useAuth()
  /* The engine outlives renders, but Clerk may hand back a new getToken;
     reading it through a ref keeps the engine on the current one. */
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
    if (!isSignedIn) return
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
  }, [engine, isSignedIn, userId])

  return { ...view, update: engine.update, dismissNotice: engine.dismissNotice }
}
