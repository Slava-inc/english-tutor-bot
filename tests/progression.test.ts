import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-prog-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

/** Create ended sessions for a user, each with the requested error rate (%). */
async function seedSessions(userId: number, rates: number[]): Promise<number[]> {
  const DB = await import('../src/db.js')
  const turns = 10
  const ids: number[] = []
  for (const [i, targetRate] of rates.entries()) {
    const s = DB.createSession(userId, { type: 'free', topic: 'Travel' })
    ids.push(s.id)
    const errors = Math.max(1, Math.round((targetRate / 100) * turns))
    for (let t = 0; t < turns; t++) DB.incrementSession(s.id, 0)
    // Unique corrections keep each seeded error distinct across sessions.
    DB.addErrors(
      userId,
      s.id,
      Array.from({ length: errors }, (_, k) => ({
        category: 'grammar' as const,
        userPhrase: `bad-${i}-${k}`,
        correction: `fix-${i}-${k}`,
        explanation: 'seeded',
      }))
    )
    DB.endSession(s.id)
    // endSession computes error_rate from turn/error counts — pin the wanted rate.
    DB.getDb()
      .prepare('UPDATE sessions SET error_count = ?, error_rate = ? WHERE id = ?')
      .run(errors, targetRate, s.id)
  }
  return ids
}

describe('level progression (§7.1)', () => {
  it('needs two sessions before a baseline exists', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(201, 'Ivan')
    await seedSessions(user.id, [50])
    expect(PROG.ensureBaseline(DB.getUserById(user.id)!)).toBeNull()

    await seedSessions(user.id, [50])
    expect(PROG.ensureBaseline(DB.getUserById(user.id)!)).toBe(50)
    // The baseline is persisted so it never shifts later.
    expect(DB.getUserById(user.id)?.baseline_error_rate).toBe(50)
  })

  it('suggests a level-up when the error rate drops ≥ 30%', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(202, 'Olga', 'B1')
    // Baseline 50% → recent 30% = a 40% drop.
    await seedSessions(user.id, [50, 50, 30, 30, 30, 30, 30])
    PROG.ensureBaseline(DB.getUserById(user.id)!)
    const status = PROG.evaluate(DB.getUserById(user.id)!)

    expect(status.baseline).toBe(50)
    expect(status.deltaPercent).toBe(40)
    expect(status.thresholdMet).toBe(true)
    expect(status.nextLevel).toBe('B1+')
    expect(status.shouldSuggestUp).toBe(true)
  })

  it('does not suggest an upgrade when progress is too small', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(203, 'Pete', 'B1')
    // Baseline 50% → recent 45% = only a 10% drop (< 30%).
    await seedSessions(user.id, [50, 50, 45, 45, 45, 45, 45])
    PROG.ensureBaseline(DB.getUserById(user.id)!)
    const status = PROG.evaluate(DB.getUserById(user.id)!)

    expect(status.deltaPercent).toBe(10)
    expect(status.shouldSuggestUp).toBe(false)
    expect(status.reason).toContain('need ≥ 30%')
  })

  it('blocks an upgrade while baseline mistakes are still recurring', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(204, 'Rita', 'B1')
    const ids = await seedSessions(user.id, [60, 60])

    // Make one baseline mistake clearly dominant so it is the tracked top error.
    for (let i = 0; i < 10; i++) {
      DB.addErrors(user.id, ids[0], [
        { category: 'grammar', userPhrase: 'top', correction: 'TOP-FIX', explanation: 'baseline' },
      ])
    }
    const baseline = DB.baselineTopErrors(user.id, 3)
    expect(baseline[0]).toBe('TOP-FIX')

    // More sessions with good accuracy…
    await seedSessions(user.id, [20, 20, 20, 20])
    // …but the very same baseline mistake comes back in the latest session.
    const last = DB.getLastSession(user.id)!
    DB.addErrors(user.id, last.id, [
      { category: 'grammar', userPhrase: 'same old', correction: 'TOP-FIX', explanation: 'repeats' },
    ])

    PROG.ensureBaseline(DB.getUserById(user.id)!)
    const status = PROG.evaluate(DB.getUserById(user.id)!)

    expect(status.thresholdMet).toBe(true)
    expect(status.cleanOfBaselineErrors).toBe(false)
    expect(status.shouldSuggestUp).toBe(false)
    expect(status.reason).toContain('old mistakes')
  })

  it('never suggests an upgrade above B2', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(205, 'Top', 'B2')
    await seedSessions(user.id, [60, 60, 10, 10, 10, 10, 10])
    PROG.ensureBaseline(DB.getUserById(user.id)!)
    const status = PROG.evaluate(DB.getUserById(user.id)!)
    expect(status.nextLevel).toBe('B2')
    expect(status.shouldSuggestUp).toBe(false)
    expect(status.reason).toContain('top of my ladder')
  })

  it('applies a confirmed promotion and resets the baseline', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(206, 'Up', 'B1')
    await seedSessions(user.id, [50, 50, 25, 25, 25, 25, 25])
    PROG.ensureBaseline(DB.getUserById(user.id)!)
    expect(PROG.evaluate(DB.getUserById(user.id)!).shouldSuggestUp).toBe(true)

    const applied = PROG.confirmLevelUp(DB.getUserById(user.id)!)
    expect(applied).toEqual({ from: 'B1', to: 'B1+' })
    const after = DB.getUserById(user.id)!
    expect(after.level).toBe('B1+')
    expect(after.baseline_error_rate).toBeNull()
    expect(DB.hasAchievement(user.id, 'level_up')).toBe(true)
  })

  it('exposes a grammar ladder per level (§7.2)', async () => {
    const PROG = await import('../src/processes/progression.js')
    expect(PROG.grammarLadderFor('B1')).toContain('present_perfect')
    expect(PROG.grammarLadderFor('B1+')).toContain('passive_voice')
    expect(PROG.grammarLadderFor('B2')).toContain('subjunctive_mood')
    expect(PROG.ladderLabel('B1+')).toContain('Passive Voice')
  })

  it('records a progression row when a session ends', async () => {
    const DB = await import('../src/db.js')
    const PROG = await import('../src/processes/progression.js')

    const user = DB.createUser(207, 'Row', 'B1')
    await seedSessions(user.id, [50, 50, 20, 20, 20, 20, 20])
    const status = PROG.afterSessionEnd(DB.getUserById(user.id)!)
    expect(status.shouldSuggestUp).toBe(true)

    const history = DB.levelProgressHistory(user.id, 5)
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].decision).toBe('suggest_up')
  })
})
