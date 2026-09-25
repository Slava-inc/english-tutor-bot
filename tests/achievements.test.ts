import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-ach-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('achievements / badges (§8, §12)', () => {
  it('awards the first-session badge once a session has ended', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(601, 'Ann')
    const s = DB.createSession(user.id, { type: 'free' })
    DB.endSession(s.id)

    const earned = ACH.checkSessionAchievements(user, DB.getSessionById(s.id)!)
    expect(earned.map((e) => e.code)).toContain('first_session')

    // Idempotent: a second call earns nothing new.
    expect(ACH.checkSessionAchievements(user, DB.getSessionById(s.id)!)).toHaveLength(0)
  })

  it('awards streak_5 on the fifth completed session', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(602, 'Streak')
    let last: DB.Session | undefined
    for (let i = 0; i < 5; i++) {
      last = DB.createSession(user.id, { type: 'free' })
      DB.endSession(last.id)
    }
    const earned = ACH.checkSessionAchievements(user, DB.getSessionById(last!.id)!)
    expect(earned.map((e) => e.code)).toContain('streak_5')
  })

  it('awards the scenario badge only for role-plays', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(603, 'Actor')
    const free = DB.createSession(user.id, { type: 'free' })
    DB.incrementSession(free.id, 0)
    DB.endSession(free.id)
    expect(
      ACH.checkSessionAchievements(user, DB.getSessionById(free.id)!).map((e) => e.code)
    ).not.toContain('scenario_master')

    const scen = DB.createSession(user.id, {
      type: 'scenario',
      scenario_key: 'small_talk',
      scenario_turns: 12,
    })
    DB.incrementSession(scen.id, 0)
    DB.endSession(scen.id)
    expect(
      ACH.checkSessionAchievements(user, DB.getSessionById(scen.id)!).map((e) => e.code)
    ).toContain('scenario_master')
  })

  it('awards a flawless-session badge only for sessions of 5+ turns', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(604, 'Flawless')
    const short = DB.createSession(user.id, { type: 'free' })
    DB.incrementSession(short.id, 0)
    DB.endSession(short.id)
    expect(
      ACH.checkSessionAchievements(user, DB.getSessionById(short.id)!).map((e) => e.code)
    ).not.toContain('no_errors_session')

    const long = DB.createSession(user.id, { type: 'free' })
    for (let i = 0; i < 6; i++) DB.incrementSession(long.id, 0)
    DB.endSession(long.id)
    expect(
      ACH.checkSessionAchievements(user, DB.getSessionById(long.id)!).map((e) => e.code)
    ).toContain('no_errors_session')
  })

  it('awards ten_words after ten words reach the learned status', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')
    const VOCAB = await import('../src/processes/vocabulary.js')

    const user = DB.createUser(605, 'Lexicon')
    const s = DB.createSession(user.id, { type: 'free' })
    const words = [
      'journey',
      'lorry',
      'schedule',
      'leisure',
      'biscuit',
      'queue',
      'flat',
      'rubbish',
      'fortnight',
      'chips',
    ]
    DB.addVocabulary(
      user.id,
      s.id,
      words.map((w) => ({ word: w, translation: null }))
    )
    for (const w of words) {
      for (let i = 0; i < 3; i++) VOCAB.noteCorrectUse(user.id, w)
    }
    expect(DB.wordStats(user.id).learned).toBe(10)
    // The promotion path awards the badge itself.
    expect(DB.hasAchievement(user.id, 'ten_words')).toBe(true)
    expect(ACH.checkVocabularyAchievements(user)).toHaveLength(0)
  })

  it('awards fifty_turns after 50 learner messages', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(606, 'Chatty')
    const s = DB.createSession(user.id, { type: 'free' })
    for (let i = 0; i < 50; i++) DB.saveMessage(user.id, s.id, 'user', `turn ${i}`)

    expect(ACH.checkTurnAchievements(user).map((e) => e.code)).toContain('fifty_turns')
  })

  it('awards the pronunciation badge after ten drills', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')
    const PRON = await import('../src/processes/pronunciation.js')

    const user = DB.createUser(607, 'Spoken')
    const s = DB.createSession(user.id, { type: 'free' })
    const drill = PRON.startDrill(user, PRON.findTrap('water'))
    for (let i = 0; i < 10; i++) PRON.recordAttempt(user.id, s.id, drill, 'wata')

    expect(DB.countPronunciationDrills(user.id)).toBe(10)
    // recordAttempt awards the badge itself, so the badge is already present.
    expect(DB.hasAchievement(user.id, 'pronunciation_10')).toBe(true)
    expect(ACH.checkPronunciationAchievements(user)).toHaveLength(0)
  })

  it('reports badges, locked badges and a celebration line', async () => {
    const DB = await import('../src/db.js')
    const ACH = await import('../src/processes/achievements.js')

    const user = DB.createUser(608, 'Report')
    expect(ACH.badgeReport(user)).toContain('No badges yet')
    expect(ACH.lockedBadges(user).map((b) => b.code)).toContain('first_session')

    DB.awardAchievementIfNew(user.id, 'first_session')
    expect(ACH.badgeReport(user)).toContain('First session complete')
    expect(ACH.lockedBadges(user).map((b) => b.code)).not.toContain('first_session')
    expect(ACH.celebrate([{ code: 'first_session', label: '🎉 First session complete' }]))
      .toContain('well done')
    expect(ACH.celebrate([])).toBe('')
  })
})
