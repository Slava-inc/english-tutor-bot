import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// The DB path must point at a scratch file. We set it per test and import the
// db module lazily so the temp directory is honoured.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-db-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
  process.env.TTS_CACHE_DIR = path.join(dir, 'tts-cache')
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('db session state machine', () => {
  it('creates users idempotently and normalizes the level', async () => {
    const DB = await import('../src/db.js')
    const a = DB.createUser(1001, 'Anna', 'b1', 'B2')
    const b = DB.createUser(1001, 'Anna again', 'B2', 'C1')
    expect(b.id).toBe(a.id)
    expect(a.level).toBe('B1')
    expect(a.onboarded).toBe(0)

    const c = DB.createUser(1002, 'Bob', 'nonsense')
    expect(c.level).toBe('B1')
  })

  it('walks the level ladder and stops at B2', async () => {
    const DB = await import('../src/db.js')
    expect(DB.normalizeLevel('b1+')).toBe('B1+')
    expect(DB.normalizeLevel('C1')).toBe('B1')
    expect(DB.nextLevel('A2')).toBe('B1')
    expect(DB.nextLevel('B1')).toBe('B1+')
    expect(DB.nextLevel('B1+')).toBe('B2')
    expect(DB.nextLevel('B2')).toBe('B2')
  })

  it('closes a session and computes the error rate', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(2001, 'Sam')
    const s = DB.createSession(user.id, { type: 'free', topic: 'Travel' })
    expect(s.state).toBe('active')
    expect(s.topic).toBe('Travel')
    expect(s.last_turn_at).not.toBeNull()

    DB.incrementSession(s.id, 1)
    DB.incrementSession(s.id, 2)
    DB.endSession(s.id)

    const ended = DB.getSessionById(s.id)
    expect(ended?.state).toBe('ended')
    expect(ended?.turn_count).toBe(2)
    expect(ended?.error_count).toBe(3)
    // 3 errors / 2 turns → 150%
    expect(ended?.error_rate).toBe(150)
    expect(DB.getActiveSession(user.id)).toBeUndefined()
  })

  it('auto-ends stale sessions and keeps fresh ones open', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(3001, 'Lee')
    const stale = DB.createSession(user.id, { type: 'free' })
    // Backdate the last turn by 5 hours (> 4h idle window).
    DB.getDb()
      .prepare('UPDATE sessions SET last_turn_at = ? WHERE id = ?')
      .run(Date.now() - 5 * 60 * 60 * 1000, stale.id)
    expect(DB.isSessionIdle(DB.getSessionById(stale.id)!)).toBe(true)
    expect(DB.endStaleSessions(user.id)).toBe(1)
    expect(DB.getSessionById(stale.id)?.state).toBe('ended')

    const fresh = DB.createSession(user.id, { type: 'free' })
    expect(DB.isSessionIdle(fresh)).toBe(false)
    expect(DB.endStaleSessions(user.id)).toBe(0)
    expect(DB.getSessionById(fresh.id)?.state).toBe('active')
  })

  it('records errors, bumps repeats and exposes deferred fixes', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(4001, 'Nina')
    const s = DB.createSession(user.id, { type: 'free' })
    const err = {
      category: 'grammar' as const,
      userPhrase: 'I go yesterday',
      correction: 'I went yesterday',
      explanation: 'past time',
    }
    DB.addErrors(user.id, s.id, [err])
    DB.addErrors(user.id, s.id, [err])
    const top = DB.topErrors(user.id, 3)
    expect(top).toHaveLength(1)
    expect(top[0].repeats).toBe(2)
    expect(DB.deferredFixes(user.id, s.id)).toHaveLength(1)
  })

  it('tracks achievements once each', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(5001, 'Kai')
    expect(DB.awardAchievementIfNew(user.id, 'first_session')).toBe(true)
    expect(DB.awardAchievementIfNew(user.id, 'first_session')).toBe(false)
    expect(DB.hasAchievement(user.id, 'first_session')).toBe(true)
    expect(DB.listAchievements(user.id)).toHaveLength(1)
    expect(DB.achievementLabel('first_session')).toContain('First session')
  })

  it('counts turns, sessions by type and error-free sessions', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(6001, 'Zoe')

    const free = DB.createSession(user.id, { type: 'free', topic: 'Food' })
    DB.saveMessage(user.id, free.id, 'user', 'I like fish and chips.')
    DB.saveMessage(user.id, free.id, 'assistant', 'Lovely!')
    DB.saveMessage(user.id, free.id, 'user', 'And mushy peas.')
    DB.endSession(free.id)

    const scenario = DB.createSession(user.id, {
      type: 'scenario',
      scenario_key: 'small_talk',
      scenario_turns: 12,
    })
    expect(scenario.scenario_turns).toBe(12)
    DB.endSession(scenario.id)

    expect(DB.countUserTurns(user.id)).toBe(2)
    expect(DB.countSessionTurns(free.id)).toBe(2)
    expect(DB.countEndedSessions(user.id)).toBe(2)
    expect(DB.countSessionsByType(user.id, 'scenario')).toBe(1)
    expect(DB.countSessionsByType(user.id, 'free')).toBe(1)
  })

  it('scopes the history window to a single session', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(7001, 'Mo')
    const s1 = DB.createSession(user.id, { type: 'free', topic: 'A' })
    DB.saveMessage(user.id, s1.id, 'user', 'first session line')
    const s2 = DB.createSession(user.id, { type: 'free', topic: 'B' })
    DB.saveMessage(user.id, s2.id, 'user', 'second session line')

    const scoped = DB.getRecentTurns(user.id, 20, s2.id)
    expect(scoped).toHaveLength(1)
    expect(scoped[0].content).toBe('second session line')

    const global = DB.getRecentTurns(user.id, 20)
    expect(global).toHaveLength(2)
  })

  it('keeps dialog history scoped per user (multi-user schema)', async () => {
    const DB = await import('../src/db.js')
    const a = DB.createUser(8001, 'A')
    const b = DB.createUser(8002, 'B')
    const sa = DB.createSession(a.id, { type: 'free' })
    const sb = DB.createSession(b.id, { type: 'free' })
    DB.saveMessage(a.id, sa.id, 'user', 'I am A')
    DB.saveMessage(b.id, sb.id, 'user', 'I am B')

    expect(DB.getRecentTurns(a.id, 10)).toHaveLength(1)
    expect(DB.getRecentTurns(a.id, 10)[0].content).toBe('I am A')
    expect(DB.getRecentTurns(b.id, 10)[0].content).toBe('I am B')
  })
})

