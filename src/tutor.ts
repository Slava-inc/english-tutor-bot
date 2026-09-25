// placeholder

// ============================================================================
// Tutor core: session state machine, prompt assembly (§3.3), DeepSeek call,
// marker parsing, persistence, and reply composition.
// ============================================================================

import type { User, Session } from './db.js'
import * as DB from './db.js'
import { chatCompletion } from './llm.js'
import { parseTutorResponse, sanitizeForHistory, type ParsedTutorResponse } from './response.js'
import { freeSystemPrompt, scenarioSystemPrompt, TOPICS_BY_LEVEL } from './prompts.js'
import { SESSION_MAX_TURNS, MAX_HISTORY_TOKENS, MAX_HISTORY_TURNS } from './config.js'
import { logger } from './logger.js'
import * as PROG from './processes/progression.js'
import * as SCEN from './processes/scenario.js'
import * as VOCAB from './processes/vocabulary.js'
import * as PRON from './processes/pronunciation.js'
import * as ACH from './processes/achievements.js'

export interface ChatOutcome {
  replyText: string // rich text to show to the user (markers formatted)
  spoken: string // plain text for TTS ('' = do not synthesize)
  session: Session
  /** True when this turn created a new session (topic-day greeting applies). */
  fresh: boolean
  /** True when the session was closed by this turn. */
  ended: boolean
  /** True when the reply belongs to a role-play (no Fix/Why in the bubble). */
  silentFixes: boolean
  /** Badge labels unlocked by this turn. */
  achievements: string[]
}

// ---------------------------------------------------------------------------
// Session lifecycle (§3.1)
// ---------------------------------------------------------------------------

/** Deterministic round-robin topic selection for a user. */
function pickTopic(user: User, session: Session): string | null {
  const list = TOPICS_BY_LEVEL[user.level] ?? TOPICS_BY_LEVEL['B1']
  if (!list || list.length === 0) return null
  return list[session.id % list.length] ?? list[0]
}

function pickGrammar(user: User): string | null {
  const ladder = PROG.grammarLadderFor(user.level)
  if (ladder.length === 0) return null
  return ladder[user.session_count % ladder.length] ?? ladder[0]
}

function createFreeSession(user: User): Session {
  const session = DB.createSession(user.id, {
    type: 'free',
    topic: null,
    grammar_focus: pickGrammar(user),
  })
  // The topic depends on the freshly created session id, so patch it in after.
  const topic = pickTopic(user, session)
  if (topic) {
    DB.setSessionTopic(session.id, topic)
    session.topic = topic
  }
  return session
}

/** Session budget: scenarios are shorter than free-practice sessions. */
function sessionBudget(session: Session): number {
  return session.type === 'scenario' ? SCEN.scenarioLength(session) : SESSION_MAX_TURNS
}

/**
 * Return the session this turn belongs to, applying the state machine:
 *   - an active session idle for > SESSION_IDLE_MS is closed
 *   - an active session that reached its turn budget is closed
 *   - closed → a brand-new active session is opened
 */
function ensureSession(user: User): { session: Session; fresh: boolean } {
  const existing = DB.getActiveSession(user.id)

  if (existing && DB.isSessionIdle(existing)) {
    DB.endSession(existing.id)
    DB.promoteNewToLearningOnSessionEnd(user.id)
    logger.info({ userId: user.id, sessionId: existing.id }, 'session auto-ended (idle)')
    return { session: createFreeSession(user), fresh: true }
  }

  if (existing) {
    if (existing.turn_count >= sessionBudget(existing)) {
      DB.endSession(existing.id)
      DB.promoteNewToLearningOnSessionEnd(user.id)
      return { session: createFreeSession(user), fresh: true }
    }
    return { session: existing, fresh: false }
  }

  return { session: createFreeSession(user), fresh: true }
}



// ---------------------------------------------------------------------------
// Main turn
// ---------------------------------------------------------------------------

/**
 * Full turn: persist input, build context, call the model, parse the reply,
 * persist errors/vocabulary/pronunciation, and prepare the reply payload.
 */
export async function tutorTurn(user: User, text: string): Promise<ChatOutcome> {
  const { session, fresh } = ensureSession(user)
  const sessionId = session.id

  DB.saveMessage(user.id, sessionId, 'user', text)
  DB.touchSession(sessionId)

  const preset = session.type === 'scenario' ? SCEN.scenarioByKey(session.scenario_key) : null
  const isScenario = session.type === 'scenario' && preset != null

  // --- context window (§3.3): last 20 turns, oldest trimmed first -----------
  const history = buildHistory(user.id, sessionId)

  // --- pupil profile -------------------------------------------------------
  const top = DB.topErrors(user.id, 3)
  const topErrText = top.map((e) => `"${e.correction}" (${e.repeats}x)`).join('; ')
  const target = DB.wordsForRepetition(user.id, 5)
  const quiz = isScenario ? null : VOCAB.quizWordForSession(user.id)

  const base = {
    name: user.first_name,
    level: user.level,
    target: user.target,
    topic: session.topic,
    grammarFocus: session.grammar_focus,
    topErrors: topErrText,
    targetWords: target.map((w) => w.word),
    coachTip: PRON.coachBlock(user.id),
  }

  let system: string
  if (isScenario && preset) {
    system = scenarioSystemPrompt({ ...base, preset, turnsDone: session.turn_count })
  } else {
    system = freeSystemPrompt({ ...base, quiz })
  }
  if (fresh) {
    system +=
      '\n\nЭто первая реплика новой сессии. Поздоровайся, назови тему дня и задай первый лёгкий вопрос — коротко, по-человечески.'
  }

  const raw = await chatCompletion({ system, history, userMessage: text })
  if (!raw) {
    DB.incrementSession(sessionId, 0)
    return {
      replyText: '😅 I missed that. Could you try again?',
      spoken: 'I missed that. Could you try again?',
      session,
      fresh,
      ended: false,
      silentFixes: false,
      achievements: [],
    }
  }

  const parsed = parseTutorResponse(raw)
  const addedWords = persistParsed(user.id, sessionId, parsed)
  DB.recordSessionWords(sessionId, addedWords)

  // Assistant history keeps only the 🎤 block, marker-free (§3.3 item 4).
  const assistantContent = sanitizeForHistory(parsed.spoken || parsed.next || '')
  if (assistantContent) {
    DB.saveMessage(user.id, sessionId, 'assistant', assistantContent, raw)
  }

  DB.incrementSession(sessionId, parsed.fixes.length)

  // --- vocabulary spaced repetition from the learner's own words -----------
  VOCAB.processTurn(user.id, text)

  // --- session close-out ---------------------------------------------------
  const updated = DB.getSessionById(sessionId) ?? session
  let ended = false
  let closing = ''
  if (updated.turn_count >= sessionBudget(updated)) {
    closing = isScenario && preset ? SCEN.scenarioClosing(preset) : ''
    DB.endSession(sessionId, closing.trim() || undefined)
    DB.promoteNewToLearningOnSessionEnd(user.id)
    DB.updateUser(user.id, { session_count: DB.countEndedSessions(user.id) })
    ended = true
  }

  // Achievements are evaluated after the close-out so completion badges see the
  // freshly ended session.
  const achievements = collectAchievements(user, DB.getSessionById(sessionId) ?? updated)

  return {
    replyText: composeReplyText(parsed, { silentFixes: isScenario }) + closing,
    spoken: parsed.spoken || parsed.next || fallbackSpoken(parsed),
    session: DB.getSessionById(sessionId) ?? updated,
    fresh,
    ended,
    silentFixes: isScenario,
    achievements,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the sliding-window history (§3.3): the last MAX_HISTORY_TURNS messages
 * of the current session, oldest trimmed first, sanitized of markers, and with
 * at least the last 6 messages kept regardless of the budget.
 */
export function buildHistory(
  userId: number,
  sessionId: number,
  limit = MAX_HISTORY_TURNS
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = DB.getRecentTurns(userId, limit, sessionId)
  const cleaned = rows
    .map((r) => ({
      role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: r.role === 'assistant' ? sanitizeForHistory(r.content) : r.content.trim(),
    }))
    .filter((m) => m.content.length > 0)

  // Always keep the last 3 exchanges (6 messages), even under a tight budget.
  const MIN_KEEP = 6
  const budget = MAX_HISTORY_TOKENS
  const kept: typeof cleaned = []
  let used = 0
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const msg = cleaned[i]
    const cost = estimateTokens(msg.content)
    if (kept.length >= MIN_KEEP && used + cost > budget) break
    kept.unshift(msg)
    used += cost
  }
  return kept
}

/** Cheap character-based token estimate (≈4 chars per token for English). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Persist everything the model reported about this turn. */
function persistParsed(
  userId: number,
  sessionId: number | null,
  p: ParsedTutorResponse
): number {
  const errs = p.fixes.map((f) => ({
    category: 'grammar' as DB.ParsedError['category'],
    userPhrase: f.from,
    correction: f.to,
    explanation: p.why || null,
  }))
  if (errs.length) DB.addErrors(userId, sessionId, errs)
  const addedWords = DB.addVocabulary(
    userId,
    sessionId,
    p.newWords.map((w) => ({ word: w.word, translation: w.translation })).filter((w) => w.word)
  )
  for (const br of p.british) {
    if (br.word) DB.addPronunciation(userId, sessionId, { word: br.word, ipa: br.ipa })
  }
  return addedWords
}

/** Run every achievement check that can be evaluated after a turn. */
function collectAchievements(user: User, session: Session): string[] {
  const fresh = DB.getSessionById(session.id) ?? session
  const earned = [
    ...ACH.checkTurnAchievements(user),
    ...ACH.checkVocabularyAchievements(user),
    ...ACH.checkPronunciationAchievements(user),
  ]
  // Session-scoped badges are only meaningful once the budget is exhausted.
  if (fresh.turn_count >= sessionBudget(fresh)) {
    earned.push(...ACH.checkSessionAchievements(user, fresh))
  }
  return earned.map((e) => e.label)
}

function fallbackSpoken(p: ParsedTutorResponse): string {
  return p.next || p.spoken || 'Great — tell me more!'
}

/**
 * Render the assistant reply for the chat bubble.
 *
 * In SCENARIO mode the Fix/Why blocks are suppressed so the role-play stays
 * immersive; they are stored in error_log and shown by /summary (§4.1).
 */
export function composeReplyText(
  p: ParsedTutorResponse,
  opts: { silentFixes?: boolean } = {}
): string {
  const lines: string[] = []
  if (p.spoken) lines.push(p.spoken)
  if (!opts.silentFixes) {
    for (const f of p.fixes) {
      if (f.from && f.to) lines.push(`✅ ${f.from} → ${f.to}`)
      else if (f.to) lines.push(`✅ ${f.to}`)
    }
  if (p.why) lines.push(`📝 Why: ${p.why}`)
    if (p.newWords.length) {
      lines.push(
        '🎯 ' +
          p.newWords
            .map((w) => `${w.word}${w.translation ? ` — ${w.translation}` : ''}`)
            .join('; ')
      )
    }
    if (p.british.length) {
      const br = p.british[0]
      if (br.word || br.ipa) {
        lines.push(
          `🔊 British: ${br.word || ''}${br.ipa ? ' = ' + br.ipa : ''}${br.comment ? ' — ' + br.comment : ''}`
        )
      }
    }
  }
  if (p.next) lines.push(`🗣 Next: ${p.next}`)
  return lines.join('\n')
}

logger.info('tutor core ready')

