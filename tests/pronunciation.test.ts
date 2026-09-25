import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-pron-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('British pronunciation coach (§5)', () => {
  it('ships the RP trap catalogue from the plan', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    const words = PRON.trapList().map((t) => t.word)

    for (const expected of ['schedule', "can't", 'water', 'dance', 'either', 'hot']) {
      expect(words).toContain(expected)
    }
    for (const t of PRON.trapList()) {
      expect(t.ipa).toMatch(/^\/.+\/$/)
      expect(t.note.length).toBeGreaterThan(5)
    }
  })

  it('finds trap words case-insensitively and ignores unknown ones', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    expect(PRON.findTrap('Schedule')?.word).toBe('schedule')
    expect(PRON.findTrap('SCHEDULE')?.ipa).toBe('/ˈʃedjuːl/')
    expect(PRON.findTrap('banana')).toBeUndefined()
  })

  it('accepts a clear pronunciation as correct', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    const state = {
      word: 'schedule',
      ipa: '/ˈʃedjuːl/',
      note: 'sh not sk',
      attempts: 0,
      askedAt: Date.now(),
    }
    const ok = PRON.buildFeedback('schedule', state)
    expect(ok.ok).toBe(true)
    expect(ok.retry).toBe(false)
    expect(ok.comment).toContain('matches')

    // Whisper often adds punctuation and a different case.
    expect(PRON.buildFeedback('Schedule.', state).ok).toBe(true)
  })

  it('coaches and asks for a retry when the word is mispronounced', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    const state = {
      word: 'schedule',
      ipa: '/ˈʃedjuːl/',
      note: "First syllable sounds like 'sheh' (/ʃ/), not 'ske' (/sk/).",
      attempts: 0,
      askedAt: Date.now(),
    }
    const bad = PRON.buildFeedback('skedule', state)
    expect(bad.ok).toBe(false)
    expect(bad.retry).toBe(true)
    expect(bad.comment).toContain('/ˈʃedjuːl/')
    expect(bad.comment).toContain('say it again')
  })

  it('handles an empty transcript gracefully', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    const state = {
      word: 'water',
      ipa: '/ˈwɔːtə/',
      note: 'long /ɔː/',
      attempts: 0,
      askedAt: Date.now(),
    }
    const empty = PRON.buildFeedback('   ', state)
    expect(empty.ok).toBe(false)
    expect(empty.retry).toBe(true)
    expect(empty.comment).toContain('didn’t catch')
  })

  it('scores string similarity monotonically', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    expect(PRON.similarityScore('schedule', 'schedule')).toBe(1)
    expect(PRON.similarityScore('schedule', 'schedul')).toBeGreaterThan(0.8)
    expect(PRON.similarityScore('schedule', 'banana')).toBeLessThan(0.4)
    expect(PRON.similarityScore('', '')).toBe(1)
    expect(PRON.similarityScore('a', '')).toBe(0)
  })

  it('records attempts and counts drills', async () => {
    const DB = await import('../src/db.js')
    const PRON = await import('../src/processes/pronunciation.js')

    const user = DB.createUser(501, 'Drill')
    const session = DB.createSession(user.id, { type: 'free' })
    const drill = PRON.startDrill(user, PRON.findTrap('water'))

    PRON.recordAttempt(user.id, session.id, drill, 'wata')
    expect(DB.countPronunciationDrills(user.id)).toBe(1)
    expect(DB.hardestWords(user.id, 3)[0].word).toBe('water')

    // A second attempt bumps the retry counter.
    PRON.recordAttempt(user.id, session.id, drill, 'wata')
    const row = DB.getDb()
      .prepare(
        'SELECT repeat_count FROM pronunciation_log WHERE user_id = ? ORDER BY id DESC LIMIT 1'
      )
      .get(user.id) as { repeat_count: number }
    expect(row.repeat_count).toBe(1)
  })

  it('stores the trap word in the vocabulary list for later repetition', async () => {
    const DB = await import('../src/db.js')
    const PRON = await import('../src/processes/pronunciation.js')

    const user = DB.createUser(502, 'Vocab')
    const session = DB.createSession(user.id, { type: 'free' })
    const drill = PRON.startDrill(user, PRON.findTrap('leisure'))
    PRON.recordAttempt(user.id, session.id, drill, 'leysure')

    expect(DB.sessionWords(session.id).map((w) => w.word)).toContain('leisure')
  })

  it('flags low-confidence segments for the say-it-again mini-game', async () => {
    const PRON = await import('../src/processes/pronunciation.js')
    const segments = [
      { text: 'I went to the garage yesterday', avg_logprob: -0.9 },
      { text: 'It was fine thanks', avg_logprob: -0.1 },
    ]
    const words = PRON.lowConfidenceWords(segments)
    expect(words).toContain('garage')
    expect(words).not.toContain('fine')

    expect(PRON.lowConfidenceWords([{ text: 'all good', avg_logprob: -0.2 }])).toEqual([])
    expect(PRON.lowConfidenceWords([{ text: 'no score' }])).toEqual([])
  })

  it('builds the retry prompt and the per-session coach block', async () => {
    const DB = await import('../src/db.js')
    const PRON = await import('../src/processes/pronunciation.js')

    expect(PRON.retryPrompt('schedule')).toContain('*schedule*')

    const user = DB.createUser(503, 'Coach')
    const block = PRON.coachBlock(user.id)
    expect(block).toContain('British pronunciation focus')
    expect(block).toMatch(/\/.+\//)
  })

  it('delivers pronunciation homework from the hardest words', async () => {
    const DB = await import('../src/db.js')
    const PRON = await import('../src/processes/pronunciation.js')

    const user = DB.createUser(504, 'Hw')
    const session = DB.createSession(user.id, { type: 'free' })
    for (let i = 0; i < 3; i++) {
      const drill = PRON.startDrill(user, PRON.findTrap('tomato'))
      PRON.recordAttempt(user.id, session.id, drill, 'tomayto')
    }
    const hw = PRON.pronunciationHomework(user.id, 3)
    expect(hw.map((h) => h.word)).toContain('tomato')
  })

  it('tracks drill state per user', async () => {
    const DB = await import('../src/db.js')
    const PRON = await import('../src/processes/pronunciation.js')
    const user = DB.createUser(505, 'State')
    const drill = PRON.startDrill(user, PRON.findTrap('herb'))
    expect(PRON.getDrill(user.id)?.word).toBe('herb')
    expect(PRON.drillPrompt(drill)).toContain('herb')
    PRON.clearDrill(user.id)
    expect(PRON.getDrill(user.id)).toBeUndefined()
  })
})
