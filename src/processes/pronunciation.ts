// ============================================================================
// British Pronunciation Coach (§5)
//
//   Level A (implemented): trap-word catalogue + coaching feedback from the
//           whisper transcript + one RP tip per dialog.
//   Level B (implemented): avg_logprob from whisper-proxy marks a segment as
//           "poorly recognised" → the bot asks the learner to say it again.
//   Level C (out of scope): paid phoneme scoring APIs.
// ============================================================================

import * as DB from '../db.js'
import { BRITISH_TRAPS, type BritishTrap } from '../data/british-traps.js'
import { logger } from '../logger.js'

/** A segment is treated as "poorly recognised" below this avg_logprob (§5.1 B). */
export const LOW_CONFIDENCE_LOGPROB = -0.5

export interface DrillState {
  word: string
  ipa: string
  note: string
  attempts: number
  askedAt: number
}

export interface PronunciationFeedback {
  /** What the learner said (whisper transcript). */
  heard: string
  /** Best matching trap word, when the transcript resembles the target. */
  target: BritishTrap | null
  /** Coach comment ready to be shown to the learner. */
  comment: string
  /** Whether the learner's pronunciation looks acceptable. */
  ok: boolean
  /** True when the learner should try again (Level B mini-game). */
  retry: boolean
}

const drills = new Map<number, DrillState>()

// --- trap word selection -----------------------------------------------------

/** Pick the next trap word for a user, avoiding immediate repeats. */
export function pickTrap(userId: number, avoid?: string): BritishTrap {
  const history = DB.hardestWords(userId, 5).map((w) => w.word)
  const notRepeated = BRITISH_TRAPS.filter(
    (t) => t.word !== avoid && !history.slice(0, 3).includes(t.word.toLowerCase())
  )
  const pool = notRepeated.length ? notRepeated : BRITISH_TRAPS.filter((t) => t.word !== avoid)
  const list = pool.length ? pool : BRITISH_TRAPS
  return list[Math.floor(Math.random() * list.length)]
}

export function findTrap(word: string): BritishTrap | undefined {
  const clean = DB.cleanWord(word)
  return BRITISH_TRAPS.find((t) => DB.cleanWord(t.word) === clean)
}

export function trapList(): BritishTrap[] {
  return BRITISH_TRAPS
}

// --- drill state -------------------------------------------------------------

export function startDrill(user: DB.User, trap?: BritishTrap): DrillState {
  const t = trap ?? pickTrap(user.id)
  const state: DrillState = {
    word: t.word,
    ipa: t.ipa,
    note: t.note,
    attempts: 0,
    askedAt: Date.now(),
  }
  drills.set(user.id, state)
  return state
}

export function getDrill(userId: number): DrillState | undefined {
  return drills.get(userId)
}

export function clearDrill(userId: number): void {
  drills.delete(userId)
}

/** Prompt shown to the learner when a drill starts. */
export function drillPrompt(state: DrillState): string {
  return (
    `🔊 Say this word: “${state.word}”\n` +
    `Send me a voice note 🎤 — I’ll listen for the British sound.`
  )
}

// --- feedback ----------------------------------------------------------------

/** A transcript must be at least this close to the target to count as correct. */
export const MATCH_THRESHOLD = 0.9

/**
 * Evaluate a whisper transcript against the active drill word.
 *
 * Level A honesty: without phoneme scoring we can only compare what whisper
 * heard with the target word. A close match means the articulation was clear
 * enough for the recogniser — which is genuine, if indirect, evidence.
 *
 * The threshold is deliberately strict (§5.1): many British "trap" words differ
 * from the American/misspelled variant by a single consonant group
 * (`schedule` vs `skedule`), so a lenient ratio would pass exactly the mistakes
 * the coach exists to catch.
 */
export function buildFeedback(heardRaw: string, state: DrillState): PronunciationFeedback {
  const heard = heardRaw.trim()
  const heardClean = DB.cleanWord(heard)
  const targetClean = DB.cleanWord(state.word)
  const trap = findTrap(state.word)

  if (!heard) {
    return {
      heard,
      target: trap ?? null,
      comment: `I didn’t catch anything. Try once more, slowly: “${state.word}”.`,
      ok: false,
      retry: true,
    }
  }

  const similarity = similarityScore(targetClean, heardClean)
  const exact = heardClean === targetClean

  if (exact || similarity >= MATCH_THRESHOLD) {
    return {
      heard,
      target: trap ?? null,
      comment:
        `✅ Heard: “${heard}” — that matches “${state.word}”.\n` +
        `British: ${state.ipa}${trap ? ' — ' + trap.note : ''}`,
      ok: true,
      retry: false,
    }
  }

  // The recogniser may have substituted a whole other trap word — very useful
  // coaching signal ("you said X, I was listening for Y").
  const heardTrap = BRITISH_TRAPS.find(
    (t) => DB.cleanWord(t.word) !== targetClean && heardClean.includes(DB.cleanWord(t.word))
  )
  const stage =
    heardTrap && heardTrap.word !== state.word
      ? `You said “${heardTrap.word}” — I was listening for “${state.word}”.`
      : `I heard “${heard}” — a little different from “${state.word}”.`

  return {
    heard,
    target: trap ?? null,
    comment:
      `📝 ${stage}\n` +
      `British target: ${state.word} = ${state.ipa}${trap ? ` — ${trap.note}` : ''}\n` +
      `🎤 Now say it again, slowly: “${state.word}”.`,
    ok: false,
    retry: true,
  }
}

/** Levenshtein-based ratio in [0,1]; 1 = identical. */
export function similarityScore(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1
  const dist = levenshtein(a, b)
  return 1 - dist / Math.max(a.length, b.length)
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
}

/** Record the attempt in pronunciation_log and keep the drill state in sync. */
export function recordAttempt(
  userId: number,
  sessionId: number | null,
  state: DrillState,
  heard: string,
  avgLogprob?: number
): void {
  state.attempts += 1
  DB.addPronunciation(userId, sessionId, {
    word: state.word,
    ipa: state.ipa,
    heard_text: heard,
    avg_logprob: avgLogprob,
  })
  if (state.attempts > 1) DB.incrementPronunciationRepeat(userId, state.word)
  if (DB.countPronunciationDrills(userId) >= 10) {
    DB.awardAchievementIfNew(userId, 'pronunciation_10')
  }
  logger.info({ userId, word: state.word, attempts: state.attempts }, 'pronunciation drill attempt')
}

// --- Level B: low-confidence segments from whisper ---------------------------

/**
 * Given whisper segments with avg_logprob, return the words that deserve a
 * "say it again" mini-game (§5.1 B).
 */
export function lowConfidenceWords(
  segments: Array<{ text: string; avg_logprob?: number }>
): string[] {
  const out: string[] = []
  for (const seg of segments) {
    if (typeof seg.avg_logprob !== 'number') continue
    if (seg.avg_logprob >= LOW_CONFIDENCE_LOGPROB) continue
    const trap = BRITISH_TRAPS.find((t) => seg.text.toLowerCase().includes(t.word.toLowerCase()))
    const words = seg.text.split(/\s+/).filter((w) => w.replace(/[^A-Za-z']/g, '').length > 3)
    if (trap) out.push(trap.word)
    else if (words.length) out.push(words[words.length - 1].replace(/[^A-Za-z']/g, ''))
  }
  return [...new Set(out)].slice(0, 3)
}

/** The "say it again" prompt from §5.1 B. */
export function retryPrompt(word: string): string {
  return `I didn’t quite catch that — could you say *${word}* again? 🎤`
}

/** One RP tip injected into the dialog prompt (§5.1 A item 4). */
export function coachLineFor(userId: number): BritishTrap {
  return pickTrap(userId)
}

/** Homework: the trap words this learner struggles with most. */
export function pronunciationHomework(userId: number, limit = 3): BritishTrap[] {
  const hardest = DB.hardestWords(userId, limit)
  const traps = hardest
    .map((h) => findTrap(h.word))
    .filter((t): t is BritishTrap => Boolean(t))
  if (traps.length > 0) return traps
  return BRITISH_TRAPS.slice(0, limit)
}

/** Block appended to the system prompt listing sounds to drill this session. */
export function coachBlock(userId: number): string {
  const trap = coachLineFor(userId)
  const homework = pronunciationHomework(userId, 2)
  const lines = [
    `🔊 British pronunciation focus for this session: "${trap.word}" = ${trap.ipa} — ${trap.note}`,
  ]
  if (homework.length) {
    lines.push(
      'Previously tricky words (use one of them naturally in your reply): ' +
        homework.map((h) => `${h.word} ${h.ipa}`).join(', ')
    )
  }
  return lines.join('\n')
}
