// ============================================================================
// Level progression (§7.1)
//
// Thresholds are *relative* to the learner's own baseline:
//   baseline = average error_rate of the first 2 ended sessions
//   B1 → B1+ : last-5 average error_rate dropped ≥ 30% vs baseline
//   B1+ → B2 : dropped ≥ 50% vs baseline
//   additional: none of the baseline top-3 errors reappeared in the last 3 sessions
//
// A promotion is never automatic — the bot suggests /level up and the learner
// confirms with an inline button.
// ============================================================================

import * as DB from '../db.js'
import { logger } from '../logger.js'

/** Sessions needed before a baseline can be computed. */
export const BASELINE_SESSIONS = 2
/** Window over which the "current" error rate is averaged. */
export const PROGRESSION_WINDOW = 5

export interface ProgressionStatus {
  level: string
  nextLevel: string
  baseline: number | null
  current: number | null
  /** Percentage drop from baseline (positive = improvement). */
  deltaPercent: number | null
  /** Required drop for the next promotion, in percent. */
  requiredPercent: number | null
  /** Whether the numeric threshold is met. */
  thresholdMet: boolean
  /** Whether the baseline top-3 errors stayed away for the last 3 sessions. */
  cleanOfBaselineErrors: boolean
  /** Final verdict: the bot may offer a promotion. */
  shouldSuggestUp: boolean
  sessions: number
  /** One-line explanation suitable for /level and /stats. */
  reason: string
}

const THRESHOLDS: Record<string, number> = {
  A2: 20,
  B1: 30,
  'B1+': 50,
  B2: 50,
}

/** Baseline = average error rate of the first `BASELINE_SESSIONS` ended sessions. */
export function ensureBaseline(user: DB.User): number | null {
  if (user.baseline_error_rate != null) return user.baseline_error_rate
  if (DB.countEndedSessions(user.id) < BASELINE_SESSIONS) return null
  const baseline = DB.firstErrorRateAverage(user.id, BASELINE_SESSIONS)
  if (baseline == null) return null
  DB.updateUser(user.id, { baseline_error_rate: baseline })
  // Mirror the baseline into level_progress so the history is auditable.
  DB.recordLevelProgress(user.id, DB.countEndedSessions(user.id), baseline, 0, 'stay')
  logger.info({ userId: user.id, baseline }, 'progression: baseline captured')
  return baseline
}

/** Average error rate over the last `PROGRESSION_WINDOW` ended sessions. */
export function currentErrorRate(userId: number): number | null {
  return DB.recentErrorRateAverage(userId, PROGRESSION_WINDOW)
}


export function evaluate(user: DB.User): ProgressionStatus {
  const baseline = ensureBaseline(user)
  const sessions = DB.countEndedSessions(user.id)
  const current = currentErrorRate(user.id)
  const next = DB.nextLevel(user.level)
  const requiredPercent = THRESHOLDS[DB.normalizeLevel(user.level)] ?? 30

  let deltaPercent: number | null = null
  if (baseline != null && baseline > 0 && current != null) {
    deltaPercent = Math.round(((baseline - current) / baseline) * 100)
  } else if (baseline === 0 && current === 0) {
    deltaPercent = 100
  }

  const thresholdMet =
    baseline != null && current != null && deltaPercent != null && deltaPercent >= requiredPercent

  const baselineErrors = DB.baselineTopErrors(user.id, 3)
  const recentErrors = new Set(DB.recentErrorCorrections(user.id, 3).map((s) => s.toLowerCase()))
  const cleanOfBaselineErrors =
    baselineErrors.length === 0 || baselineErrors.every((e) => !recentErrors.has(e.toLowerCase()))

  const atTop = next === DB.normalizeLevel(user.level)
  const shouldSuggestUp =
    !atTop && sessions >= BASELINE_SESSIONS && thresholdMet && cleanOfBaselineErrors

  return {
    level: DB.normalizeLevel(user.level),
    nextLevel: next,
    baseline,
    current,
    deltaPercent,
    requiredPercent,
    thresholdMet,
    cleanOfBaselineErrors,
    shouldSuggestUp,
    sessions,
    reason: explain({
      sessions,
      baseline,
      current,
      deltaPercent,
      requiredPercent,
      thresholdMet,
      cleanOfBaselineErrors,
      atTop,
    }),
  }
}

function explain(o: {
  sessions: number
  baseline: number | null
  current: number | null
  deltaPercent: number | null
  requiredPercent: number
  thresholdMet: boolean
  cleanOfBaselineErrors: boolean
  atTop: boolean
}): string {
  if (o.sessions < BASELINE_SESSIONS) {
    return `I need ${BASELINE_SESSIONS} finished sessions to set your baseline (${o.sessions} done so far).`
  }
  if (o.baseline == null) return 'Your baseline is still being calculated.'
  if (o.atTop) return 'You are at the top of my ladder (B2) — brilliant work!'
  if (o.current == null) return 'No error statistics yet — keep practising.'
  const parts = [
    `Baseline error rate: ${o.baseline.toFixed(1)}% · last ${PROGRESSION_WINDOW} sessions: ${o.current.toFixed(1)}%`,
  ]
  if (o.deltaPercent != null) {
    const sign = o.deltaPercent >= 0 ? '↓' : '↑'
    parts.push(`Change: ${sign} ${Math.abs(o.deltaPercent)}% (need ≥ ${o.requiredPercent}% drop)`)
  }
  if (o.thresholdMet && !o.cleanOfBaselineErrors) {
    parts.push('Almost — but your old mistakes are still coming back.')
  }
  if (!o.thresholdMet) {
    parts.push('Keep going: a little more accuracy and I will offer an upgrade.')
  }
  return parts.join('\n')
}

/**
 * Called when a session ends: persist the measurement and decide whether the
 * learner has earned a promotion offer.
 */
export function afterSessionEnd(user: DB.User): ProgressionStatus {
  const status = evaluate(user)
  DB.recordLevelProgress(
    user.id,
    status.sessions,
    status.current,
    status.deltaPercent,
    status.shouldSuggestUp ? 'suggest_up' : 'stay'
  )
  return status
}

/** Apply a confirmed promotion: bump the level, reset the baseline for the new level. */
export function confirmLevelUp(user: DB.User): { from: string; to: string } {
  const from = DB.normalizeLevel(user.level)
  const to = DB.nextLevel(from)
  if (to === from) return { from, to }
  DB.updateUser(user.id, { level: to, baseline_error_rate: null })
  DB.recordLevelProgress(user.id, DB.countEndedSessions(user.id), null, null, 'confirmed_up')
  DB.awardAchievementIfNew(user.id, 'level_up')
  logger.info({ userId: user.id, from, to }, 'progression: level up confirmed')
  return { from, to }
}

/** Grammar focus for a given level (§7.2). */
export function grammarLadderFor(level: string): string[] {
  switch (DB.normalizeLevel(level)) {
    case 'A2':
      return ['present_simple', 'past_simple', 'plurals_and_articles']
    case 'B1':
      return ['present_simple_past', 'present_perfect', 'conditionals_1_2']
    case 'B1+':
      return ['passive_voice', 'reported_speech', 'modal_verbs_advanced']
    case 'B2':
      return ['mixed_conditionals', 'advanced_connectors', 'subjunctive_mood']
  }
}

/** Human-readable ladder display for /level. */
export function ladderLabel(level: string): string {
  switch (DB.normalizeLevel(level)) {
    case 'A2':
      return 'A2 · basics: Present Simple → Past Simple → plurals & articles'
    case 'B1':
      return 'B1 · Present Simple/Past → Present Perfect → Conditionals (1,2)'
    case 'B1+':
      return 'B1+ · Passive Voice → Reported Speech → Modal verbs (advanced)'
    case 'B2':
      return 'B2 · Mixed conditionals → Advanced connectors → Subjunctive mood'
  }
}
