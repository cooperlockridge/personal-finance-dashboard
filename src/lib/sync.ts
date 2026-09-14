import { DEFAULT_BUDGET, isBudgetData, migrateBudget, type BudgetData } from './finance'
import type { ApiResult, BudgetApi, CloudState, Failure, SnapshotReason } from './budgetApi'

/* Sep 14, 2026: every browser used to keep its own copy of the budget in
   localStorage, so Laken's phone and laptop drifted apart. Now one budget
   lives in Supabase behind /api/budget and this device's copy is a cache of
   it. Everything in this file is plain TypeScript — storage, the API, and
   timers all come in as parameters — so every decision below is tested in
   bun without a browser. useBudgetSync wires it to React. */

export const CACHE_KEY = 'pfd3:budget'

/* The per-slice keys from before sync. Read once to seed the cache when it
   doesn't exist yet, and never deleted: they stay behind as a backup. */
export const LEGACY_KEYS = {
  profile: 'pfd2:profile',
  envelopes: 'pfd2:envelopes',
  funds: 'pfd2:funds',
  paychecks: 'pfd2:paychecks',
  extras: 'pfd2:extras',
  rollRange: 'pfd2:rollRange',
} as const

export const SAVE_DEBOUNCE_MS = 800
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000]
export const CONFLICT_NOTICE = 'Updated with changes from another device.'
/* A pass pushes, gets a 409, re-decides, maybe pushes again. Three rounds is
   already a race nobody wins by typing; stop and let the backoff retry. */
const MAX_PUSHES_PER_PASS = 3

/** This device's copy. `syncedVersion` is the cloud version it last matched; null if it never has. */
export type LocalCache = { data: BudgetData; syncedVersion: number | null; dirty: boolean }

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type SyncStatus = 'saved' | 'saving' | 'offline' | 'error'

export type SyncView = {
  data: BudgetData
  status: SyncStatus
  /** One dismissible line, set when cloud changes replaced edits made here. */
  notice: string | null
  /** Set when the server says this login isn't on the budget; nothing is sent after that. */
  notMemberUserId: string | null
}

export type Decision =
  | { kind: 'none' }
  | { kind: 'push'; baseVersion: number; firstPush: boolean }
  | { kind: 'adopt'; snapshot: SnapshotReason | null }

export type Scheduler = {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(storage: StorageLike | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function legacyBudget(storage: StorageLike | null): BudgetData {
  function slice<K extends keyof BudgetData>(key: K, valid: (value: unknown) => boolean): BudgetData[K] {
    const value = readJson(storage, LEGACY_KEYS[key])
    return valid(value) ? (value as BudgetData[K]) : DEFAULT_BUDGET[key]
  }
  return {
    profile: slice('profile', isRecord),
    envelopes: slice('envelopes', Array.isArray),
    funds: slice('funds', Array.isArray),
    paychecks: slice('paychecks', Array.isArray),
    extras: slice('extras', Array.isArray),
    rollRange: slice(
      'rollRange',
      (value) => isRecord(value) && typeof value.min === 'number' && typeof value.max === 'number',
    ),
  }
}

/**
 * The cache, or — on a device's first load since sync shipped — a cache
 * built from the old per-slice keys, each falling back to its default the
 * way `usePersistentState` did. A cache built that way has never synced.
 */
export function readCache(storage: StorageLike | null): LocalCache {
  const saved = readJson(storage, CACHE_KEY)
  if (isRecord(saved) && isBudgetData(saved.data) && typeof saved.dirty === 'boolean') {
    const syncedVersion = saved.syncedVersion
    if (syncedVersion === null || typeof syncedVersion === 'number') {
      return { data: saved.data, syncedVersion, dirty: saved.dirty }
    }
  }
  return { data: legacyBudget(storage), syncedVersion: null, dirty: false }
}

export function writeCache(storage: StorageLike | null, cache: LocalCache): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* Private mode or a full disk. The budget still lives in memory and, once saved, in the cloud. */
  }
}

/**
 * Equality the way JSON sees it. Postgres jsonb hands object keys back in
 * its own order, so comparing JSON.stringify strings would call two
 * identical budgets different and snapshot every device on its first sync.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    )
  }
  if (!isRecord(a) || !isRecord(b)) return false
  /* JSON drops undefined-valued keys, so they don't count here either. */
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined)
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined)
  return aKeys.length === bKeys.length && aKeys.every((key) => b[key] !== undefined && jsonEqual(a[key], b[key]))
}

/**
 * What to do with a fresh GET, given this device's copy. Steps 3–4 of the
 * sync spec (Sep 14, 2026). Nothing a device held is ever thrown away: any
 * time cloud data replaces local data that differs, a snapshot goes first.
 */
export function decideOnLoad(local: LocalCache, cloud: CloudState): Decision {
  /* Step 3: nobody has synced yet, so this device's copy becomes the budget —
     unless it is still the untouched seed data. A new phone, or Cooper
     opening a preview tab, must not claim the shared budget ahead of the
     device holding Laken's real numbers. An untouched device waits, and
     claims the budget only once someone actually edits something on it. */
  if (cloud.data === null) {
    if (!local.dirty && jsonEqual(local.data, DEFAULT_BUDGET)) return { kind: 'none' }
    return { kind: 'push', baseVersion: cloud.version, firstPush: true }
  }
  /* Step 4, never synced: keep this device's copy aside if it differs, then
     take the cloud's. A cloud version below the one this device last saw
     means the server was reset or restored; this device's lineage is
     unknown, so it gets the same treatment as a device that never synced. */
  if (local.syncedVersion === null || cloud.version < local.syncedVersion) {
    return { kind: 'adopt', snapshot: jsonEqual(local.data, cloud.data) ? null : 'device-import' }
  }
  /* Step 4, cloud moved on: unsaved edits here lost the race. */
  if (cloud.version > local.syncedVersion) {
    return { kind: 'adopt', snapshot: local.dirty ? 'conflict' : null }
  }
  /* Step 4, same version: send what changed here, if anything did. */
  return local.dirty ? { kind: 'push', baseVersion: cloud.version, firstPush: false } : { kind: 'none' }
}

/**
 * What to do when a PUT comes back 409. The very first push (step 3)
 * re-runs step 4 against the budget someone else just created; an ordinary
 * save keeps its edits as a conflict snapshot and takes the cloud's copy.
 */
export function decideOnStale(local: LocalCache, cloud: CloudState, firstPush: boolean): Decision {
  if (firstPush) return decideOnLoad(local, cloud)
  if (cloud.data === null) return { kind: 'push', baseVersion: cloud.version, firstPush: true }
  return { kind: 'adopt', snapshot: 'conflict' }
}

/**
 * Step 5: the cache after taking the cloud's copy. A copy written before a
 * migration comes back changed, and stays dirty so it gets saved migrated.
 */
export function adoptCloud(version: number, data: BudgetData): LocalCache {
  const migrated = migrateBudget(data)
  return { data: migrated, syncedVersion: version, dirty: migrated !== data }
}

/** 5 s, 15 s, 60 s, then every 60 s. `failures` counts from 1. */
export function retryDelay(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1
  return RETRY_DELAYS_MS[index]
}

/* A failure outranks "saving": while retrying every minute, the header
   should keep saying why rather than flicker to Saving… on each attempt. */
export function statusOf(state: { dirty: boolean; writing: boolean; failure: Failure | null }): SyncStatus {
  if (state.failure !== null) return state.failure
  return state.dirty || state.writing ? 'saving' : 'saved'
}

const browserScheduler: Scheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type SyncEngine = {
  /** Begin syncing for a signed-in user. Safe to call again after `stop`. */
  start(): void
  /** Stop timers and stop starting requests. Pending edits stay dirty in the cache. */
  stop(): void
  /** Apply a user change: cached right away, saved after the debounce. */
  update(change: (data: BudgetData) => BudgetData): void
  /** The window regained focus or became visible. */
  refresh(): void
  dismissNotice(): void
  subscribe(listener: () => void): () => void
  getView(): SyncView
}

/**
 * One device's sync loop. Every network exchange runs inside a single pass,
 * and only one pass runs at a time — so there are never two saves in flight,
 * and a change made mid-pass is picked up by the save that follows it.
 */
export function createSyncEngine({
  api,
  storage,
  scheduler = browserScheduler,
}: {
  api: BudgetApi
  storage: StorageLike | null
  scheduler?: Scheduler
}): SyncEngine {
  const loaded = readCache(storage)
  /* Step 1: show the cache right away, migrated. A migration that changed
     it is a change like any other, so it waits to be saved. */
  const migrated = migrateBudget(loaded.data)
  let cache: LocalCache = migrated === loaded.data ? loaded : { ...loaded, data: migrated, dirty: true }
  /* Bumps on every change to `cache.data`, so a save can tell whether what
     it sent is still what's on screen when the answer arrives. */
  let revision = 0
  let writing = false
  let failure: Failure | null = null
  let failures = 0
  let notice: string | null = null
  let notMemberUserId: string | null = null
  /* No data leaves the device until a GET this session has confirmed the
     login is a member. */
  let verified = false
  let stopped = true
  let busy = false
  let queued: 'load' | 'save' | null = null
  let saveTimer: { handle: unknown } | null = null
  let retryTimer: { handle: unknown } | null = null
  const listeners = new Set<() => void>()
  let view = buildView()

  function buildView(): SyncView {
    return {
      data: cache.data,
      status: statusOf({ dirty: cache.dirty, writing, failure }),
      notice,
      notMemberUserId,
    }
  }

  function emit() {
    const next = buildView()
    if (
      next.data === view.data &&
      next.status === view.status &&
      next.notice === view.notice &&
      next.notMemberUserId === view.notMemberUserId
    ) {
      return
    }
    view = next
    for (const listener of listeners) listener()
  }

  function commit() {
    writeCache(storage, cache)
    emit()
  }

  function clearSaveTimer() {
    if (saveTimer) scheduler.clear(saveTimer.handle)
    saveTimer = null
  }

  function clearRetryTimer() {
    if (retryTimer) scheduler.clear(retryTimer.handle)
    retryTimer = null
  }

  function succeed() {
    failure = null
    failures = 0
    clearRetryTimer()
    emit()
  }

  function fail(kind: Failure) {
    failure = kind
    failures += 1
    clearRetryTimer()
    if (!stopped) {
      retryTimer = {
        handle: scheduler.set(() => {
          retryTimer = null
          request('load')
        }, retryDelay(failures)),
      }
    }
    emit()
  }

  /* True when the answer is the one we asked for. Otherwise records why,
     so the pass can simply stop. */
  function accept<T>(result: ApiResult<T>): result is { kind: 'ok'; body: T } {
    if (result.kind === 'ok') return true
    if (result.kind === 'not_member') {
      notMemberUserId = result.userId
      clearSaveTimer()
      clearRetryTimer()
      emit()
      return false
    }
    fail(result.kind === 'failed' ? result.failure : 'error')
    return false
  }

  function request(kind: 'load' | 'save') {
    if (stopped || notMemberUserId !== null) return
    if (busy) {
      queued = queued === 'load' || kind === 'load' ? 'load' : 'save'
      return
    }
    busy = true
    clearRetryTimer()
    void run(kind)
  }

  async function run(kind: 'load' | 'save') {
    try {
      /* A save needs a version to build on and a confirmed membership;
         without both, a full GET-and-decide pass does the saving instead. */
      if (kind === 'save' && verified && cache.syncedVersion !== null) {
        await push(cache.syncedVersion, false, 0)
      } else {
        await loadPass()
      }
    } catch (error) {
      console.error('Budget sync failed', error)
      fail('error')
    } finally {
      busy = false
      writing = false
      emit()
      const next = queued
      queued = null
      if (next) request(next)
      else if (cache.dirty && failure === null && saveTimer === null) request('save')
    }
  }

  async function loadPass() {
    const result = await api.load()
    if (!accept(result)) return
    verified = true
    await settle(result.body, decideOnLoad(cache, result.body), 0)
  }

  async function settle(cloud: CloudState, decision: Decision, pushes: number): Promise<void> {
    if (decision.kind === 'none') return succeed()
    if (decision.kind === 'push') return push(decision.baseVersion, decision.firstPush, pushes)
    if (cloud.data === null) return push(cloud.version, true, pushes)
    if (decision.snapshot !== null && !(await keepAside(decision.snapshot))) return
    revision += 1
    cache = adoptCloud(cloud.version, cloud.data)
    if (decision.snapshot === 'conflict') notice = CONFLICT_NOTICE
    commit()
    if (cache.dirty) return push(cloud.version, false, pushes)
    succeed()
  }

  async function push(baseVersion: number, firstPush: boolean, pushes: number): Promise<void> {
    if (pushes >= MAX_PUSHES_PER_PASS) return fail('error')
    const sent = revision
    writing = true
    emit()
    const result = await api.save(baseVersion, cache.data)
    writing = false
    if (result.kind === 'stale') {
      return settle(result.cloud, decideOnStale(cache, result.cloud, firstPush), pushes + 1)
    }
    if (!accept(result)) return
    cache = { ...cache, syncedVersion: result.body.version, dirty: revision !== sent }
    commit()
    succeed()
  }

  /* Snapshot before adopting, so a failed POST leaves the local copy in
     place. If she edits while the POST is out, the newer copy goes up too —
     the one about to be replaced is the one that has to be kept. */
  async function keepAside(reason: SnapshotReason): Promise<boolean> {
    writing = true
    emit()
    for (;;) {
      const taken = revision
      const result = await api.snapshot(reason, cache.data)
      if (!accept(result)) return false
      if (taken === revision) break
    }
    writing = false
    return true
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      notMemberUserId = null
      verified = false
      writeCache(storage, cache)
      emit()
      request('load')
    },
    stop() {
      stopped = true
      clearSaveTimer()
      clearRetryTimer()
    },
    update(change) {
      const next = change(cache.data)
      if (next === cache.data) return
      revision += 1
      cache = { ...cache, data: next, dirty: true }
      commit()
      if (stopped || notMemberUserId !== null) return
      clearSaveTimer()
      saveTimer = {
        handle: scheduler.set(() => {
          saveTimer = null
          /* After a failure the next change is also a retry, and a retry
             re-reads the cloud before it writes. */
          request(failure === null ? 'save' : 'load')
        }, SAVE_DEBOUNCE_MS),
      }
    },
    refresh() {
      if (stopped || notMemberUserId !== null || busy) return
      /* Unsaved edits are the debounce's to send; checking first would only
         race them. After a failure, focus is a retry. */
      if (failure === null && (cache.dirty || saveTimer !== null)) return
      request('load')
    },
    dismissNotice() {
      notice = null
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getView: () => view,
  }
}
