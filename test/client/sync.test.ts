import { describe, expect, test } from 'bun:test'
import type { ApiResult, BudgetApi, CloudState, SnapshotReason } from '../../src/lib/budgetApi'
import { DEFAULT_BUDGET, DEFAULT_ENVELOPES, type BudgetData } from '../../src/lib/finance'
import {
  CACHE_KEY,
  CONFLICT_NOTICE,
  LEGACY_KEYS,
  adoptCloud,
  createSyncEngine,
  decideOnLoad,
  decideOnStale,
  jsonEqual,
  readCache,
  retryDelay,
  statusOf,
  writeCache,
  type LocalCache,
  type Scheduler,
} from '../../src/lib/sync'

/* Spec group 3: the sync decisions (steps 3–5), the save path with its 409,
   and the freshness, backoff, and membership rules around them. The engine
   runs against a fake API, in-memory storage, and a clock the test moves. */

const LOCAL: BudgetData = { ...DEFAULT_BUDGET, extras: [{ id: 'x-local', date: '2026-09-12', amount: 12, rolled: true }] }
const OTHER: BudgetData = { ...DEFAULT_BUDGET, extras: [{ id: 'x-other', date: '2026-09-13', amount: 40, rolled: false }] }
/* A budget written before the Aug 6 migration: the challenge envelope is still there. */
const UNMIGRATED: BudgetData = {
  ...DEFAULT_BUDGET,
  envelopes: [...DEFAULT_ENVELOPES, { id: 'challenge', name: 'Envelope Challenge', kind: 'fixedPerCheck', value: 0, balance: 613, countsAsSavings: true, remaining: null }],
}

const cloud = (version: number, data: BudgetData | null): CloudState => ({
  version,
  data,
  updatedAt: '2026-09-14T12:00:00Z',
  updatedBy: 'user_other',
})
const ok = <T>(body: T): ApiResult<T> => ({ kind: 'ok', body })
const offline = { kind: 'failed', failure: 'offline' } as const

/* Let every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Call =
  | { method: 'load' }
  | { method: 'save'; baseVersion: number; data: BudgetData }
  | { method: 'snapshot'; reason: SnapshotReason; data: BudgetData }

type Handlers = {
  load: () => ApiResult<CloudState> | Promise<ApiResult<CloudState>>
  save: (baseVersion: number, data: BudgetData) => ApiResult<{ version: number }> | Promise<ApiResult<{ version: number }>>
  snapshot: (reason: SnapshotReason, data: BudgetData) => ApiResult<null> | Promise<ApiResult<null>>
}

function fakeApi(overrides: Partial<Handlers>) {
  const handlers: Handlers = {
    load: () => offline,
    save: (baseVersion) => ok({ version: baseVersion + 1 }),
    snapshot: () => ok(null),
    ...overrides,
  }
  const calls: Call[] = []
  const api: BudgetApi = {
    load: async () => {
      calls.push({ method: 'load' })
      return handlers.load()
    },
    save: async (baseVersion, data) => {
      calls.push({ method: 'save', baseVersion, data })
      return handlers.save(baseVersion, data)
    },
    snapshot: async (reason, data) => {
      calls.push({ method: 'snapshot', reason, data })
      return handlers.snapshot(reason, data)
    },
  }
  return { api, calls, handlers, methods: () => calls.map((c) => c.method) }
}

function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const scheduler: Scheduler = {
    set(run, ms) {
      nextId += 1
      timers.set(nextId, { at: now + ms, run })
      return nextId
    },
    clear(handle) {
      timers.delete(handle as number)
    },
  }
  return {
    scheduler,
    /** How far away each waiting timer is, soonest first. */
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
        await settle()
      }
      now = until
      await settle()
    },
  }
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const items = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
  }
}

function setup(stored: Record<string, unknown>, handlers: Partial<Handlers>) {
  const storage = memoryStorage(stored)
  const fake = fakeApi(handlers)
  const clock = fakeClock()
  const engine = createSyncEngine({ api: fake.api, storage, scheduler: clock.scheduler })
  const cached = (): LocalCache => JSON.parse(storage.items.get(CACHE_KEY) as string)
  return { storage, clock, engine, cached, ...fake }
}

const cacheOf = (data: BudgetData, syncedVersion: number | null, dirty: boolean) => ({
  [CACHE_KEY]: { data, syncedVersion, dirty },
})

describe('decideOnLoad (steps 3–4)', () => {
  const local = (syncedVersion: number | null, dirty: boolean): LocalCache => ({ data: LOCAL, syncedVersion, dirty })

  test('step 3: nobody has synced yet, so push with the cloud version as base', () => {
    expect(decideOnLoad(local(null, false), cloud(0, null))).toEqual({ kind: 'push', baseVersion: 0, firstPush: true })
    expect(decideOnLoad(local(3, true), cloud(0, null))).toEqual({ kind: 'push', baseVersion: 0, firstPush: true })
  })

  test('step 3, untouched seed data: never claims the empty budget until something is edited', () => {
    const seed = JSON.parse(JSON.stringify(DEFAULT_BUDGET)) as BudgetData
    expect(decideOnLoad({ data: seed, syncedVersion: null, dirty: false }, cloud(0, null))).toEqual({ kind: 'none' })
    expect(decideOnLoad({ data: seed, syncedVersion: null, dirty: true }, cloud(0, null))).toEqual({ kind: 'push', baseVersion: 0, firstPush: true })
  })

  test('step 4, never synced and different: keep a device-import snapshot, then adopt', () => {
    expect(decideOnLoad(local(null, false), cloud(2, OTHER))).toEqual({ kind: 'adopt', snapshot: 'device-import' })
  })

  test('step 4, never synced and equal: adopt without a snapshot, even with jsonb key order', () => {
    const reordered = JSON.parse(JSON.stringify({ rollRange: LOCAL.rollRange, extras: LOCAL.extras, paychecks: LOCAL.paychecks, funds: LOCAL.funds, envelopes: LOCAL.envelopes, profile: LOCAL.profile }))
    expect(decideOnLoad(local(null, true), cloud(2, reordered))).toEqual({ kind: 'adopt', snapshot: null })
  })

  test('step 4, cloud newer and local dirty: keep a conflict snapshot, then adopt', () => {
    expect(decideOnLoad(local(2, true), cloud(3, OTHER))).toEqual({ kind: 'adopt', snapshot: 'conflict' })
  })

  test('step 4, cloud newer and local clean: adopt', () => {
    expect(decideOnLoad(local(2, false), cloud(3, OTHER))).toEqual({ kind: 'adopt', snapshot: null })
  })

  test('step 4, same version and dirty: push on that version', () => {
    expect(decideOnLoad(local(3, true), cloud(3, OTHER))).toEqual({ kind: 'push', baseVersion: 3, firstPush: false })
  })

  test('same version and clean: nothing to do', () => {
    expect(decideOnLoad(local(3, false), cloud(3, LOCAL))).toEqual({ kind: 'none' })
  })

  test('cloud behind this device (a reset server) is treated like a device that never synced', () => {
    expect(decideOnLoad(local(9, false), cloud(2, OTHER))).toEqual({ kind: 'adopt', snapshot: 'device-import' })
    expect(decideOnLoad(local(9, true), cloud(2, LOCAL))).toEqual({ kind: 'adopt', snapshot: null })
  })
})

describe('decideOnStale and adoptCloud (409s and step 5)', () => {
  test('a save that hits 409 keeps a conflict snapshot and adopts', () => {
    expect(decideOnStale({ data: LOCAL, syncedVersion: 2, dirty: true }, cloud(5, OTHER), false)).toEqual({ kind: 'adopt', snapshot: 'conflict' })
  })

  test('the first push hitting 409 continues with step 4 on the returned state', () => {
    const neverSynced: LocalCache = { data: LOCAL, syncedVersion: null, dirty: false }
    expect(decideOnStale(neverSynced, cloud(1, OTHER), true)).toEqual({ kind: 'adopt', snapshot: 'device-import' })
    expect(decideOnStale(neverSynced, cloud(1, LOCAL), true)).toEqual({ kind: 'adopt', snapshot: null })
  })

  test('step 5: adopting an unmigrated copy migrates it and leaves it dirty to save', () => {
    const adopted = adoptCloud(7, UNMIGRATED)
    expect(adopted.syncedVersion).toBe(7)
    expect(adopted.dirty).toBe(true)
    expect(adopted.data.envelopes.some((e) => e.id === 'challenge')).toBe(false)
  })

  test('adopting a current copy keeps the reference and is clean', () => {
    expect(adoptCloud(7, OTHER)).toEqual({ data: OTHER, syncedVersion: 7, dirty: false })
    expect(adoptCloud(7, OTHER).data).toBe(OTHER)
  })
})

describe('sync engine: loading', () => {
  test('step 1: renders the migrated cache before the GET answers, built from the old pfd2 keys', async () => {
    const gate = deferred<ApiResult<CloudState>>()
    const legacy = { [LEGACY_KEYS.envelopes]: UNMIGRATED.envelopes, [LEGACY_KEYS.extras]: LOCAL.extras }
    const s = setup(legacy, { load: () => gate.promise })
    const general = DEFAULT_ENVELOPES.find((e) => e.id === 'general')?.balance ?? 0

    expect(s.engine.getView().data.envelopes.find((e) => e.id === 'general')?.balance).toBeCloseTo(general + 313, 6)
    expect(s.engine.getView().data.extras).toEqual(LOCAL.extras)
    expect(s.engine.getView().data.funds).toEqual(DEFAULT_BUDGET.funds)

    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load'])
    expect(s.cached().syncedVersion).toBeNull()
    /* The old keys stay as a backup. */
    expect(JSON.parse(s.storage.items.get(LEGACY_KEYS.envelopes) as string)).toEqual(UNMIGRATED.envelopes)
    gate.resolve(offline)
  })

  test('step 3: an empty cloud gets this device’s copy, based on version 0', async () => {
    const s = setup(cacheOf(LOCAL, null, false), { load: () => ok(cloud(0, null)) })
    s.engine.start()
    await settle()
    expect(s.calls).toEqual([{ method: 'load' }, { method: 'save', baseVersion: 0, data: LOCAL }])
    expect(s.cached()).toEqual({ data: LOCAL, syncedVersion: 1, dirty: false })
    expect(s.engine.getView().status).toBe('saved')
  })

  test('step 3, a brand-new device: sends nothing until an edit, then claims the budget', async () => {
    const s = setup({}, { load: () => ok(cloud(0, null)) })
    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load'])

    s.engine.update((data) => ({ ...data, extras: LOCAL.extras }))
    await s.clock.advance(800)
    expect(s.methods()).toEqual(['load', 'load', 'save'])
    expect(s.calls[2]).toMatchObject({ method: 'save', baseVersion: 0 })
    expect(s.cached()).toMatchObject({ syncedVersion: 1, dirty: false })
  })

  test('step 3 then 409: continues with step 4 using the returned cloud state', async () => {
    const s = setup(cacheOf(LOCAL, null, false), {
      load: () => ok(cloud(0, null)),
      save: () => ({ kind: 'stale', cloud: cloud(1, OTHER) }),
    })
    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load', 'save', 'snapshot'])
    expect(s.calls[2]).toEqual({ method: 'snapshot', reason: 'device-import', data: LOCAL })
    expect(s.engine.getView().data).toEqual(OTHER)
    expect(s.cached()).toMatchObject({ syncedVersion: 1, dirty: false })
    expect(s.engine.getView().notice).toBeNull()
  })

  test('step 4, never synced: snapshot goes up before the cloud copy replaces this one', async () => {
    const seenAtSnapshot: BudgetData[] = []
    const s = setup(cacheOf(LOCAL, null, false), {
      load: () => ok(cloud(4, OTHER)),
      snapshot: () => {
        seenAtSnapshot.push(s.engine.getView().data)
        return ok(null)
      },
    })
    s.engine.start()
    await settle()
    expect(s.calls).toEqual([{ method: 'load' }, { method: 'snapshot', reason: 'device-import', data: LOCAL }])
    expect(seenAtSnapshot).toEqual([LOCAL])
    expect(s.engine.getView().data).toEqual(OTHER)
    expect(s.cached()).toEqual({ data: OTHER, syncedVersion: 4, dirty: false })
  })

  test('step 4, cloud newer while dirty: conflict snapshot, adopt, and the notice', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), { load: () => ok(cloud(3, OTHER)) })
    s.engine.start()
    await settle()
    expect(s.calls).toEqual([{ method: 'load' }, { method: 'snapshot', reason: 'conflict', data: LOCAL }])
    expect(s.cached()).toEqual({ data: OTHER, syncedVersion: 3, dirty: false })
    expect(s.engine.getView().notice).toBe(CONFLICT_NOTICE)
    s.engine.dismissNotice()
    expect(s.engine.getView().notice).toBeNull()
  })

  test('step 4, cloud newer while clean: adopt quietly', async () => {
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(3, OTHER)) })
    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load'])
    expect(s.cached()).toEqual({ data: OTHER, syncedVersion: 3, dirty: false })
    expect(s.engine.getView().notice).toBeNull()
  })

  test('step 4, same version while dirty: PUT on that version', async () => {
    const s = setup(cacheOf(LOCAL, 4, true), { load: () => ok(cloud(4, OTHER)) })
    s.engine.start()
    await settle()
    expect(s.calls).toEqual([{ method: 'load' }, { method: 'save', baseVersion: 4, data: LOCAL }])
    expect(s.cached()).toEqual({ data: LOCAL, syncedVersion: 5, dirty: false })
  })

  test('same version and clean: only the GET', async () => {
    const s = setup(cacheOf(LOCAL, 4, false), { load: () => ok(cloud(4, LOCAL)) })
    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load'])
    expect(s.engine.getView().status).toBe('saved')
  })

  test('step 5: an unmigrated cloud copy is adopted migrated and saved back', async () => {
    const s = setup(cacheOf(LOCAL, 6, false), { load: () => ok(cloud(7, UNMIGRATED)) })
    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load', 'save'])
    const save = s.calls[1] as Extract<Call, { method: 'save' }>
    expect(save.baseVersion).toBe(7)
    expect(save.data.envelopes.some((e) => e.id === 'challenge')).toBe(false)
    expect(s.cached()).toMatchObject({ syncedVersion: 8, dirty: false })
  })

  test('a failed snapshot keeps the local copy and retries later', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), { load: () => ok(cloud(3, OTHER)), snapshot: () => offline })
    s.engine.start()
    await settle()
    expect(s.engine.getView().data).toEqual(LOCAL)
    expect(s.cached()).toEqual({ data: LOCAL, syncedVersion: 2, dirty: true })
    expect(s.engine.getView().status).toBe('offline')
    expect(s.clock.pending()).toEqual([5_000])
  })
})

describe('sync engine: saving', () => {
  const withExtra = (amount: number) => (budget: BudgetData): BudgetData => ({
    ...budget,
    extras: [{ id: `x-${amount}`, date: '2026-09-14', amount, rolled: false }, ...budget.extras],
  })

  test('debounces 800 ms, then PUTs on the synced version', async () => {
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)) })
    s.engine.start()
    await settle()

    s.engine.update(withExtra(5))
    expect(s.cached().dirty).toBe(true)
    expect(s.engine.getView().status).toBe('saving')
    await s.clock.advance(799)
    expect(s.methods()).toEqual(['load'])

    await s.clock.advance(1)
    expect(s.methods()).toEqual(['load', 'save'])
    expect(s.calls[1]).toMatchObject({ baseVersion: 2 })
    expect((s.calls[1] as Extract<Call, { method: 'save' }>).data.extras[0].amount).toBe(5)
    expect(s.cached()).toMatchObject({ syncedVersion: 3, dirty: false })
    expect(s.engine.getView().status).toBe('saved')
  })

  test('never two saves in flight; a change made during one rides the next', async () => {
    const first = deferred<ApiResult<{ version: number }>>()
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)) })
    s.engine.start()
    await settle()

    s.handlers.save = () => first.promise
    s.engine.update(withExtra(5))
    await s.clock.advance(800)
    s.engine.update(withExtra(7))
    await s.clock.advance(800)
    expect(s.methods()).toEqual(['load', 'save'])

    s.handlers.save = (baseVersion) => ok({ version: baseVersion + 1 })
    first.resolve(ok({ version: 3 }))
    await settle()
    expect(s.methods()).toEqual(['load', 'save', 'save'])
    const second = s.calls[2] as Extract<Call, { method: 'save' }>
    expect(second.baseVersion).toBe(3)
    expect(second.data.extras.map((x) => x.amount)).toEqual([7, 5, 12])
    expect(s.cached()).toMatchObject({ syncedVersion: 4, dirty: false })
  })

  test('the first save’s answer leaves the cache dirty when she changed something meanwhile', async () => {
    const first = deferred<ApiResult<{ version: number }>>()
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)) })
    s.engine.start()
    await settle()
    s.handlers.save = () => first.promise
    s.engine.update(withExtra(5))
    await s.clock.advance(800)
    s.engine.update(withExtra(7))
    s.handlers.save = () => new Promise(() => {})
    first.resolve(ok({ version: 3 }))
    await settle()
    expect(s.cached()).toMatchObject({ syncedVersion: 3, dirty: true })
  })

  test('save 409: conflict snapshot of the local data, adopt the cloud, show the notice', async () => {
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)) })
    s.engine.start()
    await settle()

    s.handlers.save = () => ({ kind: 'stale', cloud: cloud(5, OTHER) })
    s.engine.update(withExtra(9))
    const edited = s.engine.getView().data
    await s.clock.advance(800)

    expect(s.methods()).toEqual(['load', 'save', 'snapshot'])
    expect(s.calls[2]).toEqual({ method: 'snapshot', reason: 'conflict', data: edited })
    expect(s.cached()).toEqual({ data: OTHER, syncedVersion: 5, dirty: false })
    expect(s.engine.getView().notice).toBe(CONFLICT_NOTICE)
  })
})

describe('sync engine: freshness, failures, membership', () => {
  test('focus while clean re-reads and adopts a newer version', async () => {
    let version = 2
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(version, version === 2 ? LOCAL : OTHER)) })
    s.engine.start()
    await settle()
    version = 3
    s.engine.refresh()
    await settle()
    expect(s.methods()).toEqual(['load', 'load'])
    expect(s.cached()).toEqual({ data: OTHER, syncedVersion: 3, dirty: false })
  })

  test('focus while dirty or mid-save sends nothing extra', async () => {
    const gate = deferred<ApiResult<{ version: number }>>()
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)), save: () => gate.promise })
    s.engine.start()
    await settle()
    s.engine.update((b) => ({ ...b, rollRange: { min: 1, max: 9 } }))
    s.engine.refresh()
    await settle()
    expect(s.methods()).toEqual(['load'])

    await s.clock.advance(800)
    s.engine.refresh()
    await settle()
    expect(s.methods()).toEqual(['load', 'save'])
    gate.resolve(ok({ version: 3 }))
  })

  test('no connection: offline status, retries at 5 s, 15 s, 60 s, then every 60 s', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), { load: () => offline })
    s.engine.start()
    await settle()
    expect(s.engine.getView().status).toBe('offline')
    expect(s.cached()).toMatchObject({ data: LOCAL, dirty: true })

    for (const delay of [5_000, 15_000, 60_000, 60_000]) {
      expect(s.clock.pending()).toEqual([delay])
      const before = s.calls.length
      await s.clock.advance(delay)
      expect(s.calls.length).toBe(before + 1)
    }
  })

  test('a change after a failure retries on the debounce instead of waiting out the backoff', async () => {
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => offline })
    s.engine.start()
    await settle()
    await s.clock.advance(5_000)
    expect(s.clock.pending()).toEqual([15_000])

    s.handlers.load = () => ok(cloud(2, LOCAL))
    s.engine.update((b) => ({ ...b, rollRange: { min: 2, max: 20 } }))
    await s.clock.advance(800)
    expect(s.methods()).toEqual(['load', 'load', 'load', 'save'])
    expect(s.engine.getView().status).toBe('saved')
    expect(s.clock.pending()).toEqual([])
  })

  test('focus after a failure is a retry too', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), { load: () => offline })
    s.engine.start()
    await settle()
    s.handlers.load = () => ok(cloud(2, LOCAL))
    s.engine.refresh()
    await settle()
    expect(s.methods()).toEqual(['load', 'load', 'save'])
    expect(s.engine.getView().status).toBe('saved')
  })

  test('a server error reads as "couldn’t save" and keeps the edits', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), {
      load: () => ok(cloud(2, LOCAL)),
      save: () => ({ kind: 'failed', failure: 'error' }),
    })
    s.engine.start()
    await settle()
    expect(s.engine.getView().status).toBe('error')
    expect(s.cached()).toEqual({ data: LOCAL, syncedVersion: 2, dirty: true })
    expect(s.clock.pending()).toEqual([5_000])
  })

  test('403 not_member: the user id is shown and no data is ever sent', async () => {
    const s = setup(cacheOf(LOCAL, 2, true), { load: () => ({ kind: 'not_member', userId: 'user_new' }) })
    s.engine.start()
    await settle()
    expect(s.engine.getView().notMemberUserId).toBe('user_new')

    s.engine.update((b) => ({ ...b, rollRange: { min: 3, max: 30 } }))
    s.engine.refresh()
    await s.clock.advance(120_000)
    expect(s.methods()).toEqual(['load'])
    expect(s.clock.pending()).toEqual([])
  })

  test('stop halts timers, and a later start syncs the edits it left', async () => {
    const s = setup(cacheOf(LOCAL, 2, false), { load: () => ok(cloud(2, LOCAL)) })
    s.engine.start()
    await settle()
    s.engine.update((b) => ({ ...b, rollRange: { min: 4, max: 40 } }))
    s.engine.stop()
    await s.clock.advance(5_000)
    expect(s.methods()).toEqual(['load'])

    s.engine.start()
    await settle()
    expect(s.methods()).toEqual(['load', 'load', 'save'])
    expect(s.cached()).toMatchObject({ syncedVersion: 3, dirty: false })
  })
})

describe('local cache and helpers', () => {
  test('a storage that throws falls back to the defaults, never synced', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readCache(broken)).toEqual({ data: DEFAULT_BUDGET, syncedVersion: null, dirty: false })
    expect(readCache(null)).toEqual({ data: DEFAULT_BUDGET, syncedVersion: null, dirty: false })
    expect(() => writeCache(broken, { data: LOCAL, syncedVersion: 1, dirty: false })).not.toThrow()
  })

  test('a valid pfd3 cache wins over the old keys; a corrupt one does not', () => {
    const good = memoryStorage({ ...cacheOf(OTHER, 6, true), [LEGACY_KEYS.extras]: LOCAL.extras })
    expect(readCache(good)).toEqual({ data: OTHER, syncedVersion: 6, dirty: true })

    const corrupt = memoryStorage({ [CACHE_KEY]: { data: { profile: {} }, syncedVersion: 'x', dirty: 1 }, [LEGACY_KEYS.extras]: LOCAL.extras })
    expect(readCache(corrupt)).toEqual({ data: { ...DEFAULT_BUDGET, extras: LOCAL.extras }, syncedVersion: null, dirty: false })
  })

  test('an old key holding the wrong shape falls back to that slice’s default', () => {
    const storage = memoryStorage({ [LEGACY_KEYS.funds]: { not: 'an array' }, [LEGACY_KEYS.rollRange]: { min: 'five' } })
    storage.items.set(LEGACY_KEYS.paychecks, '{not json')
    expect(readCache(storage).data).toEqual(DEFAULT_BUDGET)
  })

  test('retry delays', () => {
    expect([1, 2, 3, 4, 10].map(retryDelay)).toEqual([5_000, 15_000, 60_000, 60_000, 60_000])
  })

  test('status words', () => {
    expect(statusOf({ dirty: false, writing: false, failure: null })).toBe('saved')
    expect(statusOf({ dirty: true, writing: false, failure: null })).toBe('saving')
    expect(statusOf({ dirty: false, writing: true, failure: null })).toBe('saving')
    expect(statusOf({ dirty: true, writing: true, failure: 'offline' })).toBe('offline')
    expect(statusOf({ dirty: true, writing: false, failure: 'error' })).toBe('error')
  })

  test('jsonEqual ignores key order and undefined keys', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1, note: undefined }, { a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(jsonEqual([1, 2], [2, 1])).toBe(false)
    expect(jsonEqual({ a: null }, { a: undefined })).toBe(false)
  })
})
