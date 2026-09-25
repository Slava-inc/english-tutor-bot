// ============================================================================
// Role-play scenarios (§6)
//
// A scenario session keeps its own turn counter (`sessions.scenario_turns`) and
// role preset (`scenario_key`), so it survives a bot restart — the preset is
// looked up from the static catalogue instead of being cached in memory.
// ============================================================================

import * as DB from '../db.js'
import { SCENARIO_PRESETS, type ScenarioPreset } from '../prompts.js'

/** Default scenario length when the preset does not specify one. */
export const DEFAULT_SCENARIO_TURNS = 12

export function presetByKey(key: string | null | undefined): ScenarioPreset | null {
  if (!key) return null
  return SCENARIO_PRESETS.find((p) => p.key === key) ?? null
}

/** Alias used by tutor.ts when resolving a session's saved role preset. */
export const scenarioByKey = presetByKey

/** Open a new scenario session for the user, closing any active session first. */
export function openScenarioSession(user: DB.User, preset: ScenarioPreset): DB.Session {
  const active = DB.getActiveSession(user.id)
  if (active) DB.endSession(active.id)
  return DB.createSession(user.id, {
    type: 'scenario',
    scenario_key: preset.key,
    scenario_turns: preset.turns || DEFAULT_SCENARIO_TURNS,
    topic: `${preset.icon} ${preset.label}`,
    grammar_focus: null,
  })
}

/** Number of learner turns a scenario session should last. */
export function scenarioLength(session: DB.Session): number {
  return session.scenario_turns ?? DEFAULT_SCENARIO_TURNS
}

/** True when the scenario has run its course (turns exhausted). */
export function isScenarioOver(session: DB.Session): boolean {
  return session.type === 'scenario' && session.turn_count >= scenarioLength(session)
}

/**
 * Opening line the bot speaks when a scenario starts. Kept deterministic so the
 * learner always sees the role and the task before the first real turn.
 */
export function scenarioOpener(preset: ScenarioPreset): string {
  return (
    `${preset.icon} ${preset.label} — I’m ${preset.role}.\n` +
    `We’ll ${preset.description.replace(/^practice /, 'practise ')}.\n\n` +
    `You start — say your first line! 🎤`
  )
}

/** Turn counter shown as a subtle progress hint (does not break immersion). */
export function scenarioProgress(session: DB.Session): string | null {
  if (session.type !== 'scenario') return null
  const total = scenarioLength(session)
  const done = session.turn_count
  if (done <= 0) return null
  if (done >= total) return null
  return `🎭 Scenario progress: ${done}/${total}`
}

/**
 * Closing note appended when the scenario reaches its turn budget — the role
 * stays intact, the review is delivered by /summary (§4.1).
 */
export function scenarioClosing(preset: ScenarioPreset): string {
  return (
    `\n\n🎬 *${preset.label} finished.* ` +
    `That was a solid role-play — type /summary for my full notes on your English.`
  )
}

/** All presets, for the /scenario inline menu. */
export function presetList(): ScenarioPreset[] {
  return SCENARIO_PRESETS
}
