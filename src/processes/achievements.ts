// ============================================================================
// Achievements / badges (§8, §12)
//
// Every check is idempotent: `awardAchievementIfNew` uses ON CONFLICT DO
// NOTHING, so calling it after every turn is safe. The functions return the
// labels newly earned so the bot can celebrate them in the reply.
// ============================================================================

import * as DB from '../db.js'

export interface AchievementResult {
  code: string
  label: string
}

/** Milestones evaluated after each learner turn. */
export function checkTurnAchievements(user: DB.User): AchievementResult[] {
  const earned: AchievementResult[] = []
  const turns = DB.countUserTurns(user.id)
  if (turns >= 50 && DB.awardAchievementIfNew(user.id, 'fifty_turns')) {
    earned.push({ code: 'fifty_turns', label: DB.achievementLabel('fifty_turns') })
  }
  return earned
}

/** Milestones evaluated when a session ends. */
export function checkSessionAchievements(user: DB.User, session: DB.Session): AchievementResult[] {
  const earned: AchievementResult[] = []

  if (DB.countEndedSessions(user.id) >= 1 && DB.awardAchievementIfNew(user.id, 'first_session')) {
    earned.push({ code: 'first_session', label: DB.achievementLabel('first_session') })
  }

  if (DB.countEndedSessions(user.id) >= 5 && DB.awardAchievementIfNew(user.id, 'streak_5')) {
    earned.push({ code: 'streak_5', label: DB.achievementLabel('streak_5') })
  }

  if (
    session.type === 'scenario' &&
    session.turn_count > 0 &&
    DB.awardAchievementIfNew(user.id, 'scenario_master')
  ) {
    earned.push({ code: 'scenario_master', label: DB.achievementLabel('scenario_master') })
  }

  if (
    session.turn_count >= 5 &&
    (session.error_count ?? 0) === 0 &&
    DB.awardAchievementIfNew(user.id, 'no_errors_session')
  ) {
    earned.push({ code: 'no_errors_session', label: DB.achievementLabel('no_errors_session') })
  }

  return earned
}

/** Milestones evaluated by the vocabulary layer. */
export function checkVocabularyAchievements(user: DB.User): AchievementResult[] {
  const earned: AchievementResult[] = []
  const stats = DB.wordStats(user.id)
  if (
    stats.learned >= 10 &&
    DB.awardAchievementIfNew(user.id, 'ten_words')
  ) {
    earned.push({ code: 'ten_words', label: DB.achievementLabel('ten_words') })
  }
  return earned
}

/** Milestones evaluated by the pronunciation coach. */
export function checkPronunciationAchievements(user: DB.User): AchievementResult[] {
  const earned: AchievementResult[] = []
  if (
    DB.countPronunciationDrills(user.id) >= 10 &&
    DB.awardAchievementIfNew(user.id, 'pronunciation_10')
  ) {
    earned.push({ code: 'pronunciation_10', label: DB.achievementLabel('pronunciation_10') })
  }
  return earned
}

/** All badges a user has earned, newest last. */
export function badges(user: DB.User): AchievementResult[] {
  return DB.listAchievements(user.id).map((a) => ({ code: a.code, label: a.label ?? a.code }))
}

/** Compact badge block for the reply footer. */
export function celebrate(earned: AchievementResult[]): string {
  if (earned.length === 0) return ''
  return '\n\n' + earned.map((e) => `${e.label} — well done!`).join('\n')
}

/** Full badge list for /stats. */
export function badgeReport(user: DB.User): string {
  const list = badges(user)
  if (list.length === 0) return '🏅 No badges yet — your first lesson earns one!'
  return '🏅 Badges:\n' + list.map((b) => `• ${b.label}`).join('\n')
}

/** Catalogue of everything that can still be unlocked (motivation layer). */
export function lockedBadges(user: DB.User): AchievementResult[] {
  const have = new Set(badges(user).map((b) => b.code))
  const all = [
    'first_session',
    'streak_5',
    'no_errors_session',
    'ten_words',
    'fifty_turns',
    'pronunciation_10',
    'scenario_master',
    'level_up',
  ]
  return all
    .filter((code) => !have.has(code))
    .map((code) => ({ code, label: DB.achievementLabel(code) }))
}
