import { describe, expect, test } from 'bun:test'
import { createDb, DbShapeError, intLit, jsonLit, lit, SqlValueError, supabaseRunSql, type Row } from '../../watchdog/db.ts'

/* The SQL the watchdog sends. There are no bind parameters on the road to
   Postgres, so these tests read the statements themselves: every value must
   be there as an escaped literal and never as the raw text. */

const BUDGET = {
  profile: {},
  envelopes: [],
  funds: [],
  paychecks: [],
  extras: [],
  rollRange: { min: 5, max: 25 },
}

/* Text that tries to end the literal and start a statement of its own. */
const HOSTILE = "x'; drop table public.budgets; --"
const HOSTILE_ESCAPED = "'x''; drop table public.budgets; --'"

function fakeSql(answers: Row[][] = []) {
  const sent: string[] = []
  const runSql = async (sql: string) => {
    sent.push(sql)
    return answers.shift() ?? []
  }
  return { sent, runSql }
}

/* True when every `'` inside the statement sits in a properly closed
   literal: walking the text, quotes open and close in pairs and a doubled
   quote stays inside. Then what is left outside is checked for the payload. */
function outsideLiterals(sql: string): string {
  let outside = ''
  let inside = false
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === "'") {
      if (inside && sql[i + 1] === "'") i += 1
      else inside = !inside
    } else if (!inside) {
      outside += sql[i]
    }
  }
  expect(inside).toBe(false)
  return outside
}

describe('literals', () => {
  test('lit doubles single quotes and nothing else', () => {
    expect(lit('plain')).toBe("'plain'")
    expect(lit("it's")).toBe("'it''s'")
    expect(lit("''")).toBe("''''''")
    expect(lit(HOSTILE)).toBe(HOSTILE_ESCAPED)
  })

  test('backslashes, $$ and unicode pass through unchanged inside the quotes', () => {
    expect(lit('a\\b')).toBe("'a\\b'")
    expect(lit("\\'; select 1; --")).toBe("'\\''; select 1; --'")
    expect(lit('$$; drop table x; $$')).toBe("'$$; drop table x; $$'")
    expect(lit('$tag$ x $tag$')).toBe("'$tag$ x $tag$'")
    expect(lit('Añadir 💸 — ’quoted’')).toBe("'Añadir 💸 — ’quoted’'")
  })

  test('lit refuses a NUL and anything that is not a string', () => {
    expect(() => lit(`a${String.fromCharCode(0)}b`)).toThrow(SqlValueError)
    expect(() => lit(5 as unknown as string)).toThrow(SqlValueError)
    expect(() => lit(null as unknown as string)).toThrow(SqlValueError)
  })

  test('jsonLit is the JSON text as a literal, cast to jsonb', () => {
    expect(jsonLit({ a: 1 })).toBe(`'{"a":1}'::jsonb`)
    expect(jsonLit([{ label: "it's", before: null, after: '5' }])).toBe(`'[{"label":"it''s","before":null,"after":"5"}]'::jsonb`)
    expect(() => jsonLit(undefined)).toThrow(SqlValueError)
  })

  test('intLit takes safe integers only', () => {
    expect(intLit(42)).toBe('42')
    expect(intLit(0)).toBe('0')
    for (const bad of [1.5, Number.NaN, Infinity, 2 ** 53, 1e21, '7', '1; drop table x', null, undefined]) {
      expect(() => intLit(bad as number)).toThrow(SqlValueError)
    }
  })
})

describe('createDb', () => {
  test('releaseStuck sends the stuck window and the blocked summary, and sorts the rows', async () => {
    const { sent, runSql } = fakeSql([[{ id: 3, status: 'new' }, { id: 4, status: 'blocked' }, { id: '5', status: 'new' }]])
    expect(await createDb(runSql).releaseStuck()).toEqual({ requeued: [3, 5], blocked: [4] })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("budget_id = 'lockridge'")
    expect(sent[0]).toContain("status = 'in_progress'")
    expect(sent[0]).toContain('make_interval(mins => 180)')
    expect(sent[0]).toContain('attempts >= 2')
    expect(sent[0]).toContain("'This one failed twice. Cooper has been told.'")
  })

  test('claimNext is one statement that locks, skips locked rows and returns the row', async () => {
    const row = { id: 7, clerk_user_id: 'user_laken', author_label: 'Laken', body: HOSTILE, question: null, answer: null, attempts: 1, status: 'in_progress' }
    const { sent, runSql } = fakeSql([[row]])
    expect(await createDb(runSql).claimNext()).toEqual({
      id: 7,
      userId: 'user_laken',
      author: 'Laken',
      body: HOSTILE,
      question: null,
      answer: null,
      attempts: 1,
    })
    expect(sent).toHaveLength(1)
    const sql = sent[0].replace(/\s+/g, ' ')
    expect(sql).toContain("set status = 'in_progress', claimed_at = now(), attempts = attempts + 1, updated_at = now()")
    expect(sql).toContain("where budget_id = 'lockridge' and status = 'new'")
    expect(sql).toContain('order by created_at limit 1 for update skip locked')
    expect(sql).toContain('returning *')
    expect(sql).not.toContain('not in')
  })

  test('claimNext leaves out the ids it is told to skip, and returns null on an empty queue', async () => {
    const { sent, runSql } = fakeSql()
    const db = createDb(runSql)
    expect(await db.claimNext([4, 9])).toBeNull()
    expect(sent[0]).toContain('and id not in (4, 9)')
    await expect(db.claimNext([1.5])).rejects.toThrow(SqlValueError)
    await expect(db.claimNext(['1) or (1=1' as unknown as number])).rejects.toThrow(SqlValueError)
    expect(sent).toHaveLength(1)
  })

  test('a claimed row in an unknown shape is refused', async () => {
    const { runSql } = fakeSql([[{ id: 'seven', body: 'x' }]])
    await expect(createDb(runSql).claimNext()).rejects.toThrow(DbShapeError)
  })

  test('readBudget returns the data and version, and refuses a missing or empty budget', async () => {
    const { sent, runSql } = fakeSql([[{ data: BUDGET, version: 12 }], [{ data: JSON.stringify(BUDGET), version: '13' }], [{ data: null, version: 0 }], []])
    const db = createDb(runSql)
    expect(await db.readBudget()).toEqual({ data: BUDGET, version: 12 })
    expect(await db.readBudget()).toEqual({ data: BUDGET, version: 13 })
    await expect(db.readBudget()).rejects.toThrow(DbShapeError)
    await expect(db.readBudget()).rejects.toThrow(DbShapeError)
    expect(sent[0]).toBe("select data, version from public.budgets where id = 'lockridge'")
  })

  test('applyDataPatch is one statement, guarded on the version, with every value escaped', async () => {
    const { sent, runSql } = fakeSql([[{ version: 13, snapshot_id: 88, request_id: 7 }]])
    const newData = { ...BUDGET, funds: [{ id: 'x', name: HOSTILE }] }
    const changes = [{ label: HOSTILE, before: "5'", after: null }]
    const outcome = await createDb(runSql).applyDataPatch({
      requestId: 7,
      expectedVersion: 12,
      newData: newData as never,
      userId: `user_${HOSTILE}`,
      summary: HOSTILE,
      changes,
    })
    expect(outcome).toEqual({ applied: true, version: 13, snapshotId: 88 })
    expect(sent).toHaveLength(1)
    const sql = sent[0].replace(/\s+/g, ' ')

    /* The version guard: on the read that takes the lock and again on the write. */
    expect(sql).toContain("where id = 'lockridge' and version = 12 and exists ( select 1 from public.budget_requests where id = 7 and budget_id = 'lockridge' and status = 'in_progress' ) for update")
    expect(sql).toContain("where id = 'lockridge' and version = 12 and exists (select 1 from snap)")
    expect(sql).toContain('version = version + 1')
    /* The snapshot is of the data as it was, taken from the locked row. */
    expect(sql).toContain("select 'lockridge', 'user_x''; drop table public.budgets; --', 'watchdog', data from locked")
    expect(sql).toContain("updated_by = 'watchdog'")
    expect(sql).toContain("set status = 'done', lane = 'data'")
    expect(sql).toContain('snapshot_id = (select id from snap), applied_version = (select version from moved)')
    expect(sql).toContain('where id = 7 and budget_id = \'lockridge\' and exists (select 1 from moved)')

    expect(sent[0]).toContain(`summary = ${HOSTILE_ESCAPED}`)
    expect(sent[0]).toContain(jsonLit(newData))
    expect(sent[0]).toContain(jsonLit(changes))
    /* Only one statement: no semicolon and no drop outside a literal. */
    const outside = outsideLiterals(sent[0])
    expect(outside).not.toContain(';')
    expect(outside).not.toContain('drop')
    expect(sent[0]).not.toContain(`summary = '${HOSTILE}'`)
  })

  test('applyDataPatch reports a moved version as not applied', async () => {
    for (const rows of [[{ version: null, snapshot_id: null, request_id: null }], []]) {
      const { runSql } = fakeSql([rows])
      const outcome = await createDb(runSql).applyDataPatch({
        requestId: 7,
        expectedVersion: 12,
        newData: BUDGET as never,
        userId: 'user_laken',
        summary: 's',
        changes: [],
      })
      expect(outcome).toEqual({ applied: false })
    }
  })

  test('applyDataPatch refuses an id or version that is not an integer before sending anything', async () => {
    const { sent, runSql } = fakeSql()
    const db = createDb(runSql)
    const patch = { requestId: 7, expectedVersion: 12, newData: BUDGET as never, userId: 'u', summary: 's', changes: [] }
    await expect(db.applyDataPatch({ ...patch, requestId: 7.5 })).rejects.toThrow(SqlValueError)
    await expect(db.applyDataPatch({ ...patch, expectedVersion: '12 or 1=1' as unknown as number })).rejects.toThrow(SqlValueError)
    expect(sent).toHaveLength(0)
  })

  test('finish escapes every field it is given and only touches a row still in progress', async () => {
    const { sent, runSql } = fakeSql([[{ id: 7 }], []])
    const db = createDb(runSql)
    expect(
      await db.finish(7, {
        status: 'done',
        lane: 'code',
        summary: HOSTILE,
        changes: [{ label: HOSTILE, before: null, after: null }],
        question: `why${HOSTILE}`,
        commitSha: HOSTILE,
      }),
    ).toBe(true)
    expect(sent[0]).toContain("status = 'done'")
    expect(sent[0]).toContain("lane = 'code'")
    expect(sent[0]).toContain(`summary = ${HOSTILE_ESCAPED}`)
    expect(sent[0]).toContain(`commit_sha = ${HOSTILE_ESCAPED}`)
    expect(sent[0]).toContain("question = 'whyx''; drop table public.budgets; --'")
    expect(sent[0]).toContain(jsonLit([{ label: HOSTILE, before: null, after: null }]))
    expect(sent[0].replace(/\s+/g, ' ')).toContain("where id = 7 and budget_id = 'lockridge' and status = 'in_progress'")
    const outside = outsideLiterals(sent[0])
    expect(outside).not.toContain(';')
    expect(outside).not.toContain('drop')

    /* No row came back: the request was no longer this run's. */
    expect(await db.finish(7, { status: 'blocked', summary: 'x' })).toBe(false)
    expect(sent[1]).not.toContain('lane =')
  })

  test('finish refuses a status outside its three and an id that is not an integer', async () => {
    const { sent, runSql } = fakeSql()
    const db = createDb(runSql)
    await expect(db.finish(7, { status: "new'; --" as never })).rejects.toThrow(SqlValueError)
    await expect(db.finish(Number.NaN, { status: 'done' })).rejects.toThrow(SqlValueError)
    expect(sent).toHaveLength(0)
  })

  test('requeue puts the row back, and gives the attempt back only when asked', async () => {
    const { sent, runSql } = fakeSql([[{ id: 7 }], [{ id: 7 }]])
    const db = createDb(runSql)
    expect(await db.requeue(7)).toBe(true)
    expect(sent[0]).toContain("status = 'new', claimed_at = null")
    expect(sent[0]).not.toContain('attempts')
    await db.requeue(7, { refundAttempt: true })
    expect(sent[1]).toContain('attempts = greatest(attempts - 1, 0)')
    await expect(db.requeue('7; drop' as unknown as number)).rejects.toThrow(SqlValueError)
  })
})

describe('supabaseRunSql', () => {
  function fakeExec(result: { code?: number, stdout?: string, stderr?: string, timedOut?: boolean }) {
    const calls: { command: string, args: string[], options: unknown }[] = []
    const exec = async (command: string, args: string[], options?: unknown) => {
      calls.push({ command, args, options })
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...result }
    }
    return { calls, exec }
  }

  test('passes the SQL as one argument to the linked CLI, with a 60 second limit', async () => {
    const { calls, exec } = fakeExec({ stdout: '{"boundary":"b","rows":[{"n":1}],"warning":"w"}' })
    expect(await supabaseRunSql(exec, '/main/repo')(`select ${lit(HOSTILE)}`)).toEqual([{ n: 1 }])
    expect(calls).toEqual([
      {
        command: 'supabase',
        args: ['db', 'query', '--linked', '--workdir', '/main/repo', '-o', 'json', `select ${HOSTILE_ESCAPED}`],
        options: { timeoutMs: 60_000 },
      },
    ])
  })

  /* Under launchd the CLI prints a bare list; inside a Claude session it
     wraps the same rows. The first real run met the first shape and every
     test before it had only seen the second. */
  test('reads the bare list the CLI prints outside an agent session', async () => {
    const { exec } = fakeExec({ stdout: '[\n  { "id": 7, "status": "new" }\n]\n' })
    expect(await supabaseRunSql(exec, '/main/repo')('select 1')).toEqual([{ id: 7, status: 'new' }])
    expect(await supabaseRunSql(fakeExec({ stdout: '[]' }).exec, '/main/repo')('select 1')).toEqual([])
  })

  test('the table the CLI draws without -o json is refused, not misread', async () => {
    const table = '┌─────┐\n│ one │\n├─────┤\n│ 1   │\n└─────┘\n'
    await expect(supabaseRunSql(fakeExec({ stdout: table }).exec, '/main/repo')('select 1')).rejects.toThrow('not JSON')
  })

  test('throws on a non-zero exit, a timeout, or output that is not the rows JSON', async () => {
    for (const result of [
      { code: 1, stderr: 'connection refused' },
      { timedOut: true, code: 137 },
      { stdout: 'A new version is available\n{"rows":[]}' },
      { stdout: '{"boundary":"b"}' },
      { stdout: '{"rows":[1,2]}' },
      { stdout: '[1,2]' },
      { stdout: '' },
    ]) {
      await expect(supabaseRunSql(fakeExec(result).exec, '/main/repo')('select 1')).rejects.toThrow()
    }
  })

  test('the error never carries the SQL', async () => {
    const { exec } = fakeExec({ code: 1, stderr: 'boom' })
    const error = await supabaseRunSql(exec, '/main/repo')(`select ${lit('her words')}`).catch((e: Error) => e)
    expect((error as Error).message).not.toContain('her words')
  })
})
