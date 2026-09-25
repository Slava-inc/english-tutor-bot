import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-scen-'))
  process.env.DB_PATH = path.join(dir, 'test.db')
  process.env.LLM_MOCK = '1'
})

afterEach(async () => {
  const DB = await import('../src/db.js')
  DB.closeDb()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('role-play scenarios (§6)', () => {
  it('exposes the five presets from the plan', async () => {
    const SCEN = await import('../src/processes/scenario.js')
    const keys = SCEN.presetList().map((p) => p.key)
    expect(keys).toEqual([
      'job_interview',
      'hotel_booking',
      'tech_support',
      'at_the_doctor',
      'small_talk',
    ])
    for (const p of SCEN.presetList()) {
      expect(p.turns).toBeGreaterThanOrEqual(10)
      expect(p.role.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })

  it('resolves presets by key from the persisted scenario_key', async () => {
    const SCEN = await import('../src/processes/scenario.js')
    expect(SCEN.presetByKey('hotel_booking')?.label).toBe('Hotel booking')
    expect(SCEN.presetByKey('nope')).toBeNull()
    expect(SCEN.presetByKey(null)).toBeNull()
  })

  it('opens a scenario session and closes the previous one', async () => {
    const DB = await import('../src/db.js')
    const SCEN = await import('../src/processes/scenario.js')

    const user = DB.createUser(301, 'Nate')
    const free = DB.createSession(user.id, { type: 'free', topic: 'Travel' })
    expect(DB.getActiveSession(user.id)?.id).toBe(free.id)

    const preset = SCEN.presetByKey('job_interview')!
    const scenario = SCEN.openScenarioSession(user, preset)

    expect(scenario.type).toBe('scenario')
    expect(scenario.scenario_key).toBe('job_interview')
    expect(scenario.scenario_turns).toBe(preset.turns)
    expect(scenario.topic).toContain('Job interview')
    // The free session was closed, the scenario is the only active one.
    expect(DB.getSessionById(free.id)?.state).toBe('ended')
    expect(DB.getActiveSession(user.id)?.id).toBe(scenario.id)
  })

  it('detects the end of a scenario at its own turn budget', async () => {
    const DB = await import('../src/db.js')
    const SCEN = await import('../src/processes/scenario.js')

    const user = DB.createUser(302, 'Ann')
    const preset = SCEN.presetByKey('hotel_booking')!
    const session = SCEN.openScenarioSession(user, preset)

    expect(SCEN.scenarioLength(session)).toBe(preset.turns)
    for (let i = 0; i < preset.turns - 1; i++) DB.incrementSession(session.id, 0)
    expect(SCEN.isScenarioOver(DB.getSessionById(session.id)!)).toBe(false)

    DB.incrementSession(session.id, 0)
    expect(SCEN.isScenarioOver(DB.getSessionById(session.id)!)).toBe(true)
  })

  it('falls back to the default length when the preset does not set one', async () => {
    const DB = await import('../src/db.js')
    const SCEN = await import('../src/processes/scenario.js')

    const user = DB.createUser(303, 'Def')
    const session = DB.createSession(user.id, {
      type: 'scenario',
      scenario_key: 'small_talk',
    })
    expect(SCEN.scenarioLength(session)).toBe(SCEN.DEFAULT_SCENARIO_TURNS)
  })

  it('builds an in-character opener and a closing for /summary', async () => {
    const SCEN = await import('../src/processes/scenario.js')
    const preset = SCEN.presetByKey('tech_support')!

    const opener = SCEN.scenarioOpener(preset)
    expect(opener).toContain('tech-support operator')
    expect(opener).toContain('You start')

    const closing = SCEN.scenarioClosing(preset)
    expect(closing).toContain('Tech support call finished')
    expect(closing).toContain('/summary')
  })

  it('reports scenario progress without breaking immersion', async () => {
    const DB = await import('../src/db.js')
    const SCEN = await import('../src/processes/scenario.js')

    const user = DB.createUser(304, 'Prog')
    const session = SCEN.openScenarioSession(user, SCEN.presetByKey('small_talk')!)
    expect(SCEN.scenarioProgress(session)).toBeNull()

    DB.incrementSession(session.id, 0)
    DB.incrementSession(session.id, 0)
    const mid = DB.getSessionById(session.id)!
    expect(SCEN.scenarioProgress(mid)).toContain('2/12')
  })

  it('does not report progress for free-practice sessions', async () => {
    const DB = await import('../src/db.js')
    const SCEN = await import('../src/processes/scenario.js')
    const user = DB.createUser(305, 'Free')
    const s = DB.createSession(user.id, { type: 'free' })
    expect(SCEN.scenarioProgress(s)).toBeNull()
  })
})
