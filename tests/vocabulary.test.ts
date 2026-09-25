import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-vocab-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('vocabulary spaced repetition', () => {
  it('adds words once and moves new → learning → learned', async () => {
    const DB = await import('../src/db.js')
    const VOCAB = await import('../src/processes/vocabulary.js')

    const user = DB.createUser(101, 'Vera')
    const s = DB.createSession(user.id, { type: 'free' })

    expect(DB.addVocabulary(user.id, s.id, [{ word: 'journey', translation: 'поездка' }])).toBe(1)
    // Duplicate words are ignored (UNIQUE(user_id, word)).
    expect(DB.addVocabulary(user.id, s.id, [{ word: 'Journey', translation: 'поездка' }])).toBe(0)

    expect(DB.wordStats(user.id)).toEqual({ new: 1, learning: 0, learned: 0 })
    expect(DB.targetWords(user.id)[0].word).toBe('journey')

    // First correct use: new → learning.
    expect(VOCAB.noteCorrectUse(user.id, 'journey')).toBe('learning')
    expect(DB.wordStats(user.id)).toEqual({ new: 0, learning: 1, learned: 0 })
    // The scheduled review is 2 days out, so the tutor pulls it via the
    // schedule-agnostic list until then.
    expect(DB.dueReviewWords(user.id, true).map((w) => w.word)).toEqual(['journey'])

    // Uses 2 and 3: the third promotes the word to learned.
    expect(VOCAB.noteCorrectUse(user.id, 'journey')).toBe('learning')
    expect(VOCAB.noteCorrectUse(user.id, 'journey')).toBe('learned')
    expect(DB.wordStats(user.id)).toEqual({ new: 0, learning: 0, learned: 1 })
  })

  it('detects inflected forms in learner text but ignores short words', async () => {
    const DB = await import('../src/db.js')
    const VOCAB = await import('../src/processes/vocabulary.js')

    const user = DB.createUser(102, 'Will')
    const s = DB.createSession(user.id, { type: 'free' })
    DB.addVocabulary(user.id, s.id, [
      { word: 'journey', translation: 'поездка' },
      { word: 'environment', translation: 'окружающая среда' },
      { word: 'go', translation: null },
    ])

    const used = VOCAB.detectUsedWords(
      user.id,
      'My journeys changed the environment around me.'
    )
    expect(used).toContain('journey')
    expect(used).toContain('environment')
    // "go" is below the 3-character floor and must not match.
    expect(used).not.toContain('go')
  })

  it('advances status from a real learner turn', async () => {
    const DB = await import('../src/db.js')
    const VOCAB = await import('../src/processes/vocabulary.js')

    const user = DB.createUser(103, 'Tess')
    const s = DB.createSession(user.id, { type: 'free' })
    DB.addVocabulary(user.id, s.id, [{ word: 'journey', translation: 'поездка' }])

    VOCAB.processTurn(user.id, 'My journey to Bath was brilliant.')
    expect(DB.wordStats(user.id).learning).toBe(1)
  })

  it('scores recall answers against the word and its translation', async () => {
    const VOCAB = await import('../src/processes/vocabulary.js')
    const state = VOCAB.startQuiz(1, 'journey', 'поездка')

    expect(VOCAB.judgeQuizAnswer(state, 'journey')).toBe(true)
    expect(VOCAB.judgeQuizAnswer(state, 'It is a journey')).toBe(true)
    expect(VOCAB.judgeQuizAnswer(state, 'поездка')).toBe(true)
    expect(VOCAB.judgeQuizAnswer(state, 'banana')).toBe(false)
    expect(VOCAB.judgeQuizAnswer(state, '')).toBe(false)
  })

  it('tracks quiz state per user', async () => {
    const VOCAB = await import('../src/processes/vocabulary.js')
    expect(VOCAB.getQuiz(9)).toBeUndefined()
    VOCAB.startQuiz(9, 'route', 'маршрут')
    expect(VOCAB.getQuiz(9)?.word).toBe('route')
    VOCAB.clearQuiz(9)
    expect(VOCAB.getQuiz(9)).toBeUndefined()
  })

  it('reports progress with a readable bar', async () => {
    const DB = await import('../src/db.js')
    const VOCAB = await import('../src/processes/vocabulary.js')
    const user = DB.createUser(104, 'Uma')
    const s = DB.createSession(user.id, { type: 'free' })

    expect(VOCAB.vocabularyProgress(user.id)).toContain('No words collected yet')

    DB.addVocabulary(user.id, s.id, [
      { word: 'journey', translation: null },
      { word: 'route', translation: null },
      { word: 'lorry', translation: null },
      { word: 'flat', translation: null },
    ])
    VOCAB.noteCorrectUse(user.id, 'journey')
    VOCAB.noteCorrectUse(user.id, 'journey')
    VOCAB.noteCorrectUse(user.id, 'journey')

    const text = VOCAB.vocabularyProgress(user.id)
    expect(text).toContain('Words: 4 total')
    expect(text).toContain('learned: 1')
    expect(text).toMatch(/[▰▱]{10}/)
  })

  it('promotes new words to learning when a session ends', async () => {
    const DB = await import('../src/db.js')
    const user = DB.createUser(105, 'Bob')
    const s = DB.createSession(user.id, { type: 'free' })
    DB.addVocabulary(user.id, s.id, [{ word: 'lorry', translation: 'грузовик' }])
    expect(DB.wordStats(user.id).new).toBe(1)

    DB.promoteNewToLearningOnSessionEnd(user.id)
    expect(DB.wordStats(user.id)).toEqual({ new: 0, learning: 1, learned: 0 })
  })
})
