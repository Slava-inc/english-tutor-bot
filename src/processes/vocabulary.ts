// ============================================================================
// Spaced repetition for the learner's vocabulary (§5.3)
//
//   new ──(used correctly once)──> learning ──(3 correct sessions)──> learned
//
// `next_review_at` drives the "Целевые слова" block of the system prompt and
// the quiz question the tutor asks once every three sessions.
// ============================================================================

import * as DB from '../db.js'
import { logger } from '../logger.js'

export type VocabTransition = 'new' | 'learning' | 'learned' | null

const DAY = 24 * 60 * 60 * 1000

/**
 * Record that the learner used `word` correctly in their own turn.
 * Returns the status the word moved to (or null when the word is unknown).
 */
export function noteCorrectUse(userId: number, word: string): VocabTransition {
  const before = DB.cleanWord(word)
  if (!before) return null
  const status = DB.noteWordCorrectUse(userId, before)
  if (status === 'learned') {
    logger.info({ userId, word: before }, 'vocabulary: word learned')
  }
  return status as VocabTransition
}

/**
 * Detect which vocabulary words the learner used in their own message, so the
 * spaced-repetition counters advance from real usage rather than guesswork.
 * Matching is deliberately conservative: whole-word, case-insensitive, and the
 * word must be at least 3 characters long.
 *
 * Every non-learned word is a candidate — a word scheduled for review in two
 * days still counts if the learner happens to use it today.
 */
export function detectUsedWords(userId: number, text: string): string[] {
  if (!text) return []
  const lower = ` ${text.toLowerCase().replace(/[^a-z'’\s-]/g, ' ')} `
  const candidates = [...DB.targetWords(userId, 20), ...DB.allLearningWordsForMatch(userId)]
  const seen = new Set<string>()
  const hits: string[] = []
  for (const c of candidates) {
    const w = DB.cleanWord(c.word)
    if (w.length < 3 || seen.has(w)) continue
    if (hasWord(lower, w)) {
      seen.add(w)
      hits.push(w)
    }
  }
  return hits
}

/** Match `word` as a whole token, tolerating regular English inflections. */
function hasWord(haystack: string, word: string): boolean {
  const base = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\s${base}(?:s|es|ed|d|ing|ly)?\\s`, 'i')
  return re.test(haystack)
}

/**
 * Advance spaced repetition based on one learner turn.
 * Returns the words whose status changed, for the achievements layer.
 */
export function processTurn(userId: number, userText: string): string[] {
  const used = detectUsedWords(userId, userText)
  const changed: string[] = []
  for (const w of used) {
    const status = noteCorrectUse(userId, w)
    if (status === 'learned') changed.push(w)
  }
  return changed
}

/** Words that should be quizzed in the dialog right now ("Do you remember…"). */
export function wordsToQuiz(userId: number): Array<{ word: string; translation: string | null }> {
  return DB.dueReviewWords(userId).map((w) => ({ word: w.word, translation: w.translation }))
}

/** Every `learning` word, ignoring the review clock — used for the timed quiz. */
export function allLearningWords(userId: number): Array<{ word: string; translation: string | null }> {
  return DB.dueReviewWords(userId, true).map((w) => ({
    word: w.word,
    translation: w.translation,
  }))
}
/**
 * Every 3 sessions the tutor is allowed to ask a recall question about one
 * `learning` word. Returns null when it is not the right moment.
 */
export function quizWordForSession(userId: number): { word: string; translation: string | null } | null {
  const sessionCount = DB.countEndedSessions(userId)
  if (sessionCount === 0 || sessionCount % 3 !== 0) return null
  const due = wordsToQuiz(userId)
  const pool = due.length ? due : allLearningWords(userId)
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Human-readable progress line used by /words and /stats. */
export function vocabularyProgress(userId: number): string {
  const s = DB.wordStats(userId)
  const total = s.new + s.learning + s.learned
  if (total === 0) return 'No words collected yet — let’s talk and I’ll note them down!'
  const pct = Math.round((s.learned / total) * 100)
  const bar = progressBar(pct)
  return (
    `📚 Words: ${total} total\n` +
    `🆕 new: ${s.new}   🔁 learning: ${s.learning}   ✅ learned: ${s.learned}\n` +
    `${bar} ${pct}% mastered`
  )
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

/** Next review date for a `learning` word, as a short human string. */
export function nextReviewLabel(nextReviewAt: number | null): string {
  if (!nextReviewAt) return 'any time'
  const diff = nextReviewAt - Date.now()
  if (diff <= 0) return 'due now'
  const days = Math.ceil(diff / DAY)
  return days === 1 ? 'in 1 day' : `in ${days} days`
}

// ---------------------------------------------------------------------------
// Vocabulary quiz state (per user, in memory — one question at a time)
// ---------------------------------------------------------------------------

export interface QuizState {
  word: string
  translation: string | null
  askedAt: number
}

const quizzes = new Map<number, QuizState>()

export function startQuiz(userId: number, word: string, translation: string | null): QuizState {
  const state: QuizState = { word, translation, askedAt: Date.now() }
  quizzes.set(userId, state)
  return state
}

export function getQuiz(userId: number): QuizState | undefined {
  return quizzes.get(userId)
}

export function clearQuiz(userId: number): void {
  quizzes.delete(userId)
}

/**
 * Judge a recall answer. We accept the English word itself or its translation
 * (learners often remember the meaning before the spelling).
 */
export function judgeQuizAnswer(state: QuizState, answer: string): boolean {
  const a = answer.trim().toLowerCase()
  if (!a) return false
  const w = DB.cleanWord(state.word)
  if (a.includes(w)) return true
  const tr = (state.translation ?? '').toLowerCase()
  if (tr.length > 2 && tr.split(/[;,/]/).some((part) => part.trim() && a.includes(part.trim()))) {
    return true
  }
  return false
}
