import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-e2e-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
  process.env.SESSION_MAX_TURNS = '3'
  process.env.SESSION_IDLE_MS = '14400000'
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  const LLM = await import('../src/llm.js')
  LLM.setLlmMock(null)
  rmSync(dir, { recursive: true, force: true })
})

/** A canned FREE-mode reply with every marker present. */
const FREE_REPLY = [
  '🎤 London is lovely in autumn. I went there last year myself.',
  '✅ Fix: I go to London yesterday → I went to London yesterday',
  '📝 Why: "yesterday" is past time → use Past Simple "went".',
  '🎯 New: journey — поездка; lorry — грузовик',
  '🔊 British: schedule = /ˈʃedjuːl/ — starts with "sh", not "sk".',
  '🗣 Next: What did you enjoy most about your trip?',
].join('\n')

/** A canned SCENARIO-mode reply: fixes stay silent but are still recorded. */
const SCENARIO_REPLY = [
  '🎤 Certainly, let me check availability for those dates. How many nights?',
  '✅ Fix: I want book room → I would like to book a room',
  '📝 Why: after "would like" use the infinitive without "to".',
  '🗣 Next: Would you prefer a twin or a double room?',
].join('\n')

describe('end-to-end dialog (mock DeepSeek + TTS)', () => {
  it('runs a free-practice turn: parses, persists and composes the reply', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => FREE_REPLY)
    const user = DB.createUser(401, 'Elena', 'B1', 'B2')
    const outcome = await tutorTurn(user, 'I go to London yesterday.')

    // --- spoken text goes to TTS without markers -----------------------------
    expect(outcome.spoken).toContain('London is lovely')
    expect(outcome.spoken).not.toContain('✅')

    // --- the bubble shows the coach blocks (FREE mode) -----------------------
    expect(outcome.silentFixes).toBe(false)
    expect(outcome.replyText).toContain(
      '✅ I go to London yesterday → I went to London yesterday'
    )
    expect(outcome.replyText).toContain('📝 Why:')
    expect(outcome.replyText).toContain('🗣 Next:')

    // --- errors, vocabulary and pronunciation were persisted -----------------
    const top = DB.topErrors(user.id, 5)
    expect(top.map((e) => e.correction)).toContain('I went to London yesterday')
    const words = DB.sessionWords(outcome.session.id).map((w) => w.word)
    expect(words).toContain('journey')
    expect(words).toContain('lorry')
    expect(DB.countPronunciationDrills(user.id)).toBe(1)
    expect(outcome.session.turn_count).toBe(1)
    expect(outcome.session.error_count).toBe(1)
  })

  it('keeps history marker-free and scoped to the session', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => FREE_REPLY)
    const user = DB.createUser(402, 'Hist')
    const first = await tutorTurn(user, 'Hello there.')
    await tutorTurn(user, 'I go to London yesterday.')

    const history = DB.getRecentTurns(user.id, 20, first.session.id)
    const assistantLines = history.filter((h) => h.role === 'assistant')
    expect(assistantLines.length).toBe(2)
    for (const line of assistantLines) {
      expect(line.content).not.toContain('✅')
      expect(line.content).not.toContain('🎯')
      expect(line.content).not.toContain('🔊')
      expect(line.content).not.toContain('🗣')
    }
    // The model receives exactly the sanitized history plus the new message.
    const req = LLM.getLastLlmRequest()!
    expect(req.history.length).toBe(3)
    expect(req.userMessage).toBe('I go to London yesterday.')
  })

  it('hides Fix/Why in SCENARIO mode but still stores them for /summary', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')
    const SCEN = await import('../src/processes/scenario.js')

    LLM.setLlmMock(() => SCENARIO_REPLY)
    const user = DB.createUser(403, 'Role')
    const session = SCEN.openScenarioSession(user, SCEN.presetByKey('hotel_booking')!)

    const outcome = await tutorTurn(user, 'I want book room for two nights.')

    // The bubble stays in character…
    expect(outcome.silentFixes).toBe(true)
    expect(outcome.replyText).not.toContain('✅')
    expect(outcome.replyText).not.toContain('📝 Why')
    expect(outcome.replyText).toContain('Certainly, let me check availability')
    // …but the mistake is on record.
    const fixes = DB.deferredFixes(user.id, session.id)
    expect(fixes).toHaveLength(1)
    expect(fixes[0].correction).toBe('I would like to book a room')

    // The scenario prompt is selected, not the free one.
    const req = LLM.getLastLlmRequest()!
    expect(req.system).toContain('hotel receptionist')
    expect(req.system).toContain('реплика 1 из 10')
  })

  it('closes the session at the turn budget and keeps the dialog alive', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => FREE_REPLY)
    const user = DB.createUser(404, 'Budget')

    // SESSION_MAX_TURNS = 3 for this test.
    const first = await tutorTurn(user, 'One')
    expect(first.ended).toBe(false)
    await tutorTurn(user, 'Two')
    const third = await tutorTurn(user, 'Three')

    expect(third.ended).toBe(true)
    expect(third.session.state).toBe('ended')
    expect(third.session.turn_count).toBe(3)

    // A brand-new session opens on the following message.
    const fourth = await tutorTurn(user, 'Four')
    expect(fourth.fresh).toBe(true)
    expect(fourth.session.id).not.toBe(first.session.id)
    expect(fourth.session.state).toBe('active')
  })

  it('degrades gracefully when the model returns nothing', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => null)
    const user = DB.createUser(405, 'Down')
    const outcome = await tutorTurn(user, 'Hello?')

    expect(outcome.replyText).toContain('Could you try again')
    expect(outcome.spoken).toContain('try again')
    expect(outcome.ended).toBe(false)
  })

  it('starts a free session with a topic and grammar focus', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => FREE_REPLY)
    const user = DB.createUser(406, 'Topic', 'B1')
    const outcome = await tutorTurn(user, 'Hi!')

    expect(outcome.fresh).toBe(true)
    expect(outcome.session.type).toBe('free')
    expect(outcome.session.topic).toBeTruthy()
    expect(outcome.session.grammar_focus).toBeTruthy()
    // The prompt tells the model this is the opening turn.
    const req = LLM.getLastLlmRequest()!
    expect(req.system).toContain('первая реплика новой сессии')
    expect(req.system).toContain('--- УЧЕНИК (профиль) ---')
  })

  it('awards the first-session badge once a session is complete', async () => {
    const DB = await import('../src/db.js')
    const LLM = await import('../src/llm.js')
    const { tutorTurn } = await import('../src/tutor.js')

    LLM.setLlmMock(() => FREE_REPLY)
    const user = DB.createUser(407, 'Badge')
    await tutorTurn(user, 'One')
    await tutorTurn(user, 'Two')
    const last = await tutorTurn(user, 'Three')

    expect(last.ended).toBe(true)
    expect(DB.hasAchievement(user.id, 'first_session')).toBe(true)
  })
})
