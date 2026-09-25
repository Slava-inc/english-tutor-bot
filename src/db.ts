import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import path from 'path'
import { DB_PATH, DATA_DIR, SESSION_IDLE_MS } from './config.js'
import { logger } from './logger.js'

// ============================================================================
// Types
// ============================================================================

export interface User {
  id: number
  telegram_id: number
  first_name: string | null
  level: string
  target: string
  baseline_error_rate: number | null
  session_count: number
  onboarded: number
  explain_lang: string
  pronoun_session: number | null
  created_at: number
}

/** Learning levels the tutor knows how to teach, in order. */
export const LEVELS = ['A2', 'B1', 'B1+', 'B2'] as const
export type Level = (typeof LEVELS)[number]

export function isLevel(v: string): v is Level {
  return (LEVELS as readonly string[]).includes(v)
}

export function normalizeLevel(v: string | null | undefined, fallback: Level = 'B1'): Level {
  if (!v) return fallback
  const t = v.trim().toUpperCase().replace(/^([A-C])$/i, '$1' + '1')
  return isLevel(t) ? (t as Level) : fallback
}

/** Next level up the ladder: A2 → B1 → B1+ → B2 (B2 stays B2). */
export function nextLevel(level: string): Level {
  const i = LEVELS.indexOf(normalizeLevel(level))
  return LEVELS[Math.min(i + 1, LEVELS.length - 1)]
}

export type SessionType = 'free' | 'scenario'
export type SessionState = 'idle' | 'active' | 'ended'
export type Category = 'grammar' | 'vocab' | 'word_order' | 'spelling'
export type VocabStatus = 'new' | 'learning' | 'learned'

export interface Session {
  id: number
  user_id: number
  started_at: number
  ended_at: number | null
  state: SessionState
  type: SessionType
  scenario_key: string | null
  scenario_turns: number | null
  topic: string | null
  grammar_focus: string | null
  new_words_count: number
  error_count: number
  turn_count: number
  error_rate: number | null
  summary: string | null
  last_turn_at: number | null
}

// ============================================================================
// Init
// ============================================================================

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
  }
  return db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      first_name TEXT,
      level TEXT NOT NULL DEFAULT 'B1',
      target TEXT NOT NULL DEFAULT 'B2',
      baseline_error_rate REAL,
      session_count INTEGER NOT NULL DEFAULT 0,
      onboarded INTEGER NOT NULL DEFAULT 0,
      explain_lang TEXT NOT NULL DEFAULT 'en',
      pronoun_session INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      state TEXT NOT NULL DEFAULT 'idle',
      type TEXT NOT NULL DEFAULT 'free',
      scenario_key TEXT,
      scenario_turns INTEGER,
      topic TEXT,
      grammar_focus TEXT,
      new_words_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      error_rate REAL,
      summary TEXT,
      last_turn_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS dialog_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      raw_response TEXT,
      deferred_fix INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      category TEXT NOT NULL DEFAULT 'grammar',
      user_phrase TEXT,
      correction TEXT,
      explanation TEXT,
      repeats INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vocabulary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      translation TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      source_session INTEGER,
      review_count INTEGER NOT NULL DEFAULT 0,
      next_review_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, word)
    );

    CREATE TABLE IF NOT EXISTS pronunciation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      word TEXT,
      ipa TEXT,
      heard_text TEXT,
      avg_logprob REAL,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS level_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_number INTEGER,
      error_rate REAL,
      baseline_delta REAL,
      decision TEXT NOT NULL DEFAULT 'stay',
      decided_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      label TEXT,
      earned_at INTEGER NOT NULL,
      UNIQUE(user_id, code)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON dialog_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON dialog_messages(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_error_user ON error_log(user_id);
  `)

  addColumnIfMissing(d, 'sessions', 'scenario_turns', 'INTEGER')
  addColumnIfMissing(d, 'sessions', 'last_turn_at', 'INTEGER')
  addColumnIfMissing(d, 'dialog_messages', 'deferred_fix', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(d, 'users', 'onboarded', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(d, 'users', 'explain_lang', "TEXT NOT NULL DEFAULT 'en'")
  addColumnIfMissing(d, 'users', 'pronoun_session', 'INTEGER')
}

/** Idempotent `ALTER TABLE ... ADD COLUMN` for databases created before the field existed. */
function addColumnIfMissing(
  d: Database.Database,
  table: string,
  column: string,
  sqlType: string
): void {
  try {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) return
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`)
    logger.info({ table, column }, 'db migration: column added')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn({ table, column, error: msg }, 'db migration: add column failed')
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ============================================================================
// Users
// ============================================================================

export function getUserByTelegramId(telegramId: number): User | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .get(telegramId) as User | undefined
}

export function getUserById(id: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | User
    | undefined
}

export function createUser(
  telegramId: number,
  first_name: string | null,
  level = 'B1',
  target = 'B2'
): User {
  const existing = getUserByTelegramId(telegramId)
  if (existing) return existing
  const info = getDb()
    .prepare(
      `INSERT INTO users (telegram_id, first_name, level, target, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(telegramId, first_name, normalizeLevel(level), target, Date.now())
  const user = getUserById(Number(info.lastInsertRowid))
  if (!user) throw new Error('Failed to create user')
  return user
}

export function updateUser(
  userId: number,
  patch: Partial<
    Pick<
      User,
      | 'level'
      | 'target'
      | 'first_name'
      | 'baseline_error_rate'
      | 'session_count'
      | 'onboarded'
      | 'explain_lang'
      | 'pronoun_session'
    >
  >
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`)
      vals.push(value)
    }
  }
  if (sets.length === 0) return
  vals.push(userId)
  getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function markOnboarded(userId: number, level: string, target: string): void {
  updateUser(userId, { level: normalizeLevel(level), target, onboarded: 1 })
}

// ============================================================================
// Sessions
// ============================================================================

export function getActiveSession(userId: number): Session | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE user_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1"
    )
    .get(userId) as Session | undefined
}

export function getLastSession(userId: number): Session | undefined {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId) as Session | undefined
}

export function getSessionById(sessionId: number): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Session
    | undefined
}

// ============================================================================
// Session state machine (§3.1)
//   idle ──(first msg after >4h or /start)──> active
//   active ──(/summary, N turns, or >4h pause)──> ended
//   ended ──(next message)──> idle → new active
// ============================================================================

/**
 * End every session of the user still marked 'active' — used when the idle
 * window has elapsed or the user explicitly starts a new activity.
 */
export function endStaleSessions(userId: number, idleMs = SESSION_IDLE_MS): number {
  const stale = getDb()
    .prepare(
      `SELECT id, last_turn_at FROM sessions
       WHERE user_id = ? AND state = 'active'`
    )
    .all(userId) as Array<{ id: number; last_turn_at: number | null }>
  const cutoff = Date.now() - idleMs
  let closed = 0
  for (const s of stale) {
    const touched = s.last_turn_at ?? null
    const row = touched
      ? { last_turn_at: touched }
      : (getDb()
          .prepare('SELECT MAX(created_at) AS last_turn_at FROM dialog_messages WHERE session_id = ?')
          .get(s.id) as { last_turn_at: number | null })
    if (!row.last_turn_at || row.last_turn_at <= cutoff) {
      endSession(s.id)
      closed++
    }
  }
  return closed
}

/** True when the given session has been silent longer than the idle window. */
export function isSessionIdle(session: Session, idleMs = SESSION_IDLE_MS): boolean {
  if (session.state !== 'active') return false
  const last =
    session.last_turn_at ?? sessionLastTurnAt(session.id) ?? session.started_at
  return Date.now() - last > idleMs
}

export function sessionLastTurnAt(sessionId: number): number | null {
  const row = getDb()
    .prepare('SELECT MAX(created_at) AS last_turn_at FROM dialog_messages WHERE session_id = ?')
    .get(sessionId) as { last_turn_at: number | null }
  return row.last_turn_at ?? null
}

export function touchSession(sessionId: number): void {
  getDb()
    .prepare('UPDATE sessions SET last_turn_at = ? WHERE id = ?')
    .run(Date.now(), sessionId)
}

export function createSession(
  userId: number,
  opts: Partial<
    Pick<
      Session,
      'type' | 'topic' | 'grammar_focus' | 'scenario_key' | 'scenario_turns'
    >
  > = {},
  state: SessionState = 'active'
): Session {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO sessions
         (user_id, started_at, state, type, scenario_key, scenario_turns, topic, grammar_focus, last_turn_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      now,
      state,
      opts.type ?? 'free',
      opts.scenario_key ?? null,
      opts.scenario_turns ?? null,
      opts.topic ?? null,
      opts.grammar_focus ?? null,
      now
    )
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Session
  return row
}

export function endSession(sessionId: number, summary?: string): void {
  const s = getDb()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as Session | undefined
  if (!s) return
  const errorRate =
    s.turn_count > 0
      ? Math.round(((s.error_count ?? 0) / s.turn_count) * 1000) / 10
      : null
  getDb()
    .prepare(
      `UPDATE sessions SET state = 'ended', ended_at = ?, error_rate = ?,
         summary = COALESCE(?, summary)
       WHERE id = ?`
    )
    .run(Date.now(), errorRate, summary ?? null, sessionId)
}

export function setSessionSummary(sessionId: number, summary: string): void {
  getDb()
    .prepare('UPDATE sessions SET summary = ? WHERE id = ?')
    .run(summary, sessionId)
}

export function setSessionTopic(sessionId: number, topic: string): void {
  getDb().prepare('UPDATE sessions SET topic = ? WHERE id = ?').run(topic, sessionId)
}

export function incrementSession(sessionId: number, newErrors = 0): void {
  getDb()
    .prepare(
      `UPDATE sessions
       SET turn_count = turn_count + 1,
           error_count = error_count + ?,
           last_turn_at = ?
       WHERE id = ?`
    )
    .run(newErrors, Date.now(), sessionId)
}

/** Turns in the current (or last ended) session of a user. */
export function countSessionTurns(sessionId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM dialog_messages WHERE session_id = ? AND role = ?')
    .get(sessionId, 'user') as { cnt: number }
  return row.cnt
}

export function recordSessionWords(sessionId: number, newWords = 0): void {
  if (newWords > 0) {
    getDb()
      .prepare(
        'UPDATE sessions SET new_words_count = new_words_count + ? WHERE id = ?'
      )
      .run(newWords, sessionId)
  }
}

/**
 * Load the last N turns of clean dialog (assistant content already stripped of
 * markers when saved) for context building (§3.3).
 *
 * When `sessionId` is provided the window is scoped to that session, so a new
 * session never inherits the previous one's chit-chat.
 */
export function getRecentTurns(userId: number, limit: number, sessionId?: number) {
  const rows = sessionId
    ? (getDb()
        .prepare(
          `SELECT role, content FROM dialog_messages
           WHERE user_id = ? AND session_id = ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(userId, sessionId, limit) as { role: string; content: string }[])
    : (getDb()
        .prepare(
          `SELECT role, content FROM dialog_messages
           WHERE user_id = ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(userId, limit) as { role: string; content: string }[])
  return rows.reverse()
}


// ============================================================================
// Dialog messages
// ============================================================================

export function saveMessage(
  userId: number,
  sessionId: number | null,
  role: 'user' | 'assistant',
  content: string,
  rawResponse?: string,
  deferredFix = false
): void {
  getDb()
    .prepare(
      `INSERT INTO dialog_messages
         (user_id, session_id, role, content, raw_response, deferred_fix, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      sessionId,
      role,
      content,
      rawResponse ?? null,
      deferredFix ? 1 : 0,
      Date.now()
    )
}

/**
 * Deferred (silent) fixes accumulated during a SCENARIO session — shown only in
 * /summary so the role-play immersion stays intact (§4.1).
 */
export function deferredFixes(userId: number, sessionId: number): Array<{
  user_phrase: string | null
  correction: string | null
  explanation: string | null
}> {
  return getDb()
    .prepare(
      `SELECT user_phrase, correction, explanation FROM error_log
       WHERE user_id = ? AND session_id = ?
       ORDER BY id`
    )
    .all(userId, sessionId) as Array<{
    user_phrase: string | null
    correction: string | null
    explanation: string | null
  }>
}

// ============================================================================
// Error log
// ============================================================================

export interface ParsedError {
  category: 'grammar' | 'vocab' | 'word_order' | 'spelling'
  userPhrase: string | null
  correction: string | null
  explanation: string | null
}

export function addErrors(
  userId: number,
  sessionId: number | null,
  errors: ParsedError[]
): number {
  const now = Date.now()
  let newCount = 0
  const findExisting = getDb().prepare(
    'SELECT * FROM error_log WHERE user_id = ? AND correction = ? LIMIT 1'
  )
  const bumpRepeat = getDb().prepare(
    `UPDATE error_log
     SET repeats = repeats + 1, last_seen_at = ?, session_id = ?
     WHERE id = ?`
  )

  /**
   * The *latest* session in which the mistake occurred is what drives the
   * §7.1 "did the baseline mistake come back?" check, so we overwrite the
   * session_id on every recurrence.
   */
  const insert = getDb().prepare(
    `INSERT INTO error_log
       (user_id, session_id, category, user_phrase, correction, explanation, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const e of errors) {
    const existing = findExisting.get(userId, e.correction) as
      | { id: number }
      | undefined
    if (existing) {
      bumpRepeat.run(now, sessionId, existing.id)
    } else {
      insert.run(
        userId,
        sessionId,
        e.category,
        e.userPhrase,
        e.correction,
        e.explanation,
        now,
        now
      )
      newCount++
    }
  }
  return errors.length // return count of errors to apply to session.error_count
}

export function topErrors(userId: number, limit = 3): Array<{
  category: string
  correction: string | null
  explanation: string | null
  repeats: number
}> {
  return getDb()
    .prepare(
      `SELECT category, correction, explanation, repeats FROM error_log
       WHERE user_id = ? AND correction IS NOT NULL
       ORDER BY repeats DESC, last_seen_at DESC LIMIT ?`
    )
    .all(userId, limit) as Array<{
    category: string
    correction: string | null
    explanation: string | null
    repeats: number
  }>
}


// ============================================================================
// Vocabulary + spaced repetition
// ============================================================================

/** Clean a word to a lower-case alphabetic token. */
export function cleanWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, '')
}

export function addVocabularyWord(
  userId: number,
  sessionId: number | null,
  rawWord: string,
  translation: string | null
): boolean {
  const word = cleanWord(rawWord)
  if (!word) return false
  const info = getDb()
    .prepare(
      `INSERT INTO vocabulary (user_id, word, translation, source_session, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, word) DO NOTHING`
    )
    .run(userId, word, translation, sessionId, Date.now())
  return info.changes > 0
}

export function addVocabulary(
  userId: number,
  sessionId: number | null,
  words: Array<{ word: string; translation: string | null }>
): number {
  let added = 0
  for (const w of words) {
    if (addVocabularyWord(userId, sessionId, w.word, w.translation)) added++
  }
  return added
}

/** Words marked 'new' — candidates the tutor should use in upcoming dialog. */
export function targetWords(userId: number, limit = 5): Array<{
  word: string
  translation: string | null
}> {
  return getDb()
    .prepare(
      `SELECT word, translation FROM vocabulary
       WHERE user_id = ? AND status = 'new'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit) as Array<{ word: string; translation: string | null }>
}

/**
 * 'learning' words whose next_review_at has passed — for quiz prompts.
 *
 * Pass `all = true` to ignore the schedule (the tutor quizzes one `learning`
 * word every third session regardless of the spaced-repetition clock, §5.3).
 */
export function dueReviewWords(
  userId: number,
  all = false
): Array<{
  id: number
  word: string
  translation: string | null
  review_count: number
}> {
  const sql = all
    ? `SELECT id, word, translation, review_count FROM vocabulary
       WHERE user_id = ? AND status = 'learning'
       ORDER BY next_review_at ASC`
    : `SELECT id, word, translation, review_count FROM vocabulary
       WHERE user_id = ? AND status = 'learning'
         AND (next_review_at IS NULL OR next_review_at <= ?)
       ORDER BY next_review_at ASC`
  const stmt = getDb().prepare(sql)
  const rows = all ? stmt.all(userId) : stmt.all(userId, Date.now())
  return rows as Array<{
    id: number
    word: string
    translation: string | null
    review_count: number
  }>
}

/** Called when the learner used a word correctly in a turn. */
export function noteWordCorrectUse(userId: number, rawWord: string): string | null {
  const word = cleanWord(rawWord)
  const row = getDb()
    .prepare(
      'SELECT id, status, review_count FROM vocabulary WHERE user_id = ? AND word = ?'
    )
    .get(userId, word) as { id: number; status: string; review_count: number } | undefined
  if (!row) return null

  const now = Date.now()
  if (row.status === 'new') {
    // new → learning after first correct use
    getDb()
      .prepare(
        `UPDATE vocabulary SET status = 'learning', review_count = review_count + 1,
          next_review_at = ? WHERE id = ?`
      )
      .run(now + 2 * 24 * 60 * 60 * 1000, row.id)
    setNextSessionReviewFor(userId)
    return 'learning'
  }
  if (row.status === 'learning') {
    const newCount = row.review_count + 1
    if (newCount >= 3) {
      getDb()
        .prepare(
          `UPDATE vocabulary SET status = 'learned', review_count = ?, next_review_at = NULL
           WHERE id = ?`
        )
        .run(newCount, row.id)
      awardAchievementIfNew(userId, 'ten_words')
      return 'learned'
    }
    getDb()
      .prepare(
        `UPDATE vocabulary SET status = 'learning', review_count = ?, next_review_at = ?
         WHERE id = ?`
      )
      .run(newCount, now + 7 * 24 * 60 * 60 * 1000, row.id)
    return 'learning'
  }
  return row.status
}

/**
 * Promote new words to learning once a session containing them has ended.
 * Called when a session ends.
 */
export function promoteNewToLearningOnSessionEnd(userId: number): void {
  getDb()
    .prepare(
      `UPDATE vocabulary SET status = 'learning', next_review_at = ?
       WHERE user_id = ? AND status = 'new' AND created_at <= ?`
    )
    .run(Date.now() + 2 * 24 * 60 * 60 * 1000, userId, Date.now())
}

export function wordsByStatus(userId: number) {
  return getDb()
    .prepare(
      'SELECT status, COUNT(*) as count FROM vocabulary WHERE user_id = ? GROUP BY status'
    )
    .all(userId) as Array<{ status: string; count: number }>
}

export function recentVocab(
  userId: number,
  status: VocabStatus | string,
  limit = 10
): Array<{ word: string; translation: string | null; status: string; review_count: number }> {
  return getDb()
    .prepare(
      `SELECT word, translation, status, review_count FROM vocabulary
       WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, status, limit) as Array<{
    word: string
    translation: string | null
    status: string
    review_count: number
  }>
}

/** New words introduced during one session (used by /summary and the model context). */
export function sessionWords(sessionId: number): Array<{
  word: string
  translation: string | null
  status: string
}> {
  return getDb()
    .prepare(
      `SELECT word, translation, status FROM vocabulary
       WHERE source_session = ? ORDER BY id`
    )
    .all(sessionId) as Array<{ word: string; translation: string | null; status: string }>
}

/** Every word a user has, grouped for /words. */
export function wordStats(userId: number): { new: number; learning: number; learned: number } {
  const rows = wordsByStatus(userId)
  const out = { new: 0, learning: 0, learned: 0 }
  for (const r of rows) {
    if (r.status === 'new') out.new = r.count
    else if (r.status === 'learning') out.learning = r.count
    else if (r.status === 'learned') out.learned = r.count
  }
  return out
}

/** Every `learning` word regardless of its review schedule — usage matching. */
export function allLearningWordsForMatch(userId: number): Array<{
  word: string
  translation: string | null
}> {
  return getDb()
    .prepare(
      `SELECT word, translation FROM vocabulary
       WHERE user_id = ? AND status = 'learning'`
    )
    .all(userId) as Array<{ word: string; translation: string | null }>
}

/** Words the tutor should actively reuse: words introduced recently (`new`) plus
 * `learning` words whose spaced-repetition slot has come up (§5.3).
 */
export function wordsForRepetition(userId: number, limit = 5): Array<{
  word: string
  translation: string | null
  status: string
}> {
  const fresh = getDb()
    .prepare(
      `SELECT word, translation, status FROM vocabulary
       WHERE user_id = ? AND status = 'new'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit) as Array<{ word: string; translation: string | null; status: string }>
  if (fresh.length >= limit) return fresh
  const due = getDb()
    .prepare(
      `SELECT word, translation, status FROM vocabulary
       WHERE user_id = ? AND status = 'learning'
         AND (next_review_at IS NULL OR next_review_at <= ?)
       ORDER BY next_review_at ASC LIMIT ?`
    )
    .all(userId, Date.now(), limit - fresh.length) as Array<{
    word: string
    translation: string | null
    status: string
  }>
  return [...fresh, ...due]
}

function setNextSessionReviewFor(userId: number): void {
  // placeholder kept for clarity; scheduling handled by noteWordCorrectUse
  void userId
}

// ============================================================================
// Pronunciation log
// ============================================================================

export function addPronunciation(
  userId: number,
  sessionId: number | null,
  entry: { word: string; ipa?: string; heard_text?: string; avg_logprob?: number }
): void {
  const word = cleanWord(entry.word)
  if (!word) return
  getDb()
    .prepare(
      `INSERT INTO pronunciation_log
         (user_id, session_id, word, ipa, heard_text, avg_logprob, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      sessionId,
      word,
      entry.ipa ?? null,
      entry.heard_text ?? null,
      entry.avg_logprob ?? null,
      Date.now()
    )
  // Treat the word as a vocab candidate (for later repetition), no translation.
  addVocabularyWord(userId, sessionId, word, null)
}

/** Number of pronunciation drills the learner has done. */
export function countPronunciationDrills(userId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM pronunciation_log WHERE user_id = ?')
    .get(userId) as { cnt: number }
  return row.cnt
}

/** Bump the retry counter for a trap word (mini-game "say it again"). */
export function incrementPronunciationRepeat(userId: number, rawWord: string): void {
  const word = cleanWord(rawWord)
  if (!word) return
  getDb()
    .prepare(
      `UPDATE pronunciation_log SET repeat_count = repeat_count + 1
       WHERE id = (
         SELECT id FROM pronunciation_log
         WHERE user_id = ? AND word = ?
         ORDER BY id DESC LIMIT 1
       )`
    )
    .run(userId, word)
}

/** Trap words the learner pronounced poorly most often — next session's homework. */
export function hardestWords(userId: number, limit = 5): Array<{ word: string; tries: number }> {
  const rows = getDb()
    .prepare(
      `SELECT word, COUNT(*) AS tries FROM pronunciation_log
       WHERE user_id = ? AND word IS NOT NULL
       GROUP BY word ORDER BY tries DESC, MAX(created_at) DESC LIMIT ?`
    )
    .all(userId, limit) as Array<{ word: string; tries: number }>
  return rows
}

// ============================================================================
// Level progress & baseline
// ============================================================================

export function getLatestLevelProgress(userId: number) {
  return getDb()
    .prepare(
      'SELECT * FROM level_progress WHERE user_id = ? ORDER BY session_number DESC LIMIT 1'
    )
    .get(userId)
}

export function countEndedSessions(userId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ? AND state = 'ended'"
    )
    .get(userId) as { cnt: number }
  return row.cnt
}

export function recordLevelProgress(
  userId: number,
  sessionNumber: number,
  errorRate: number | null,
  baselineDelta: number | null,
  decision: 'stay' | 'suggest_up' | 'confirmed_up' | 'declined' = 'stay'
): void {
  getDb()
    .prepare(
      `INSERT INTO level_progress
         (user_id, session_number, error_rate, baseline_delta, decision, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, sessionNumber, errorRate, baselineDelta, decision, Date.now())
}

export function levelProgressHistory(userId: number, limit = 10) {
  return getDb()
    .prepare(
      `SELECT session_number, error_rate, baseline_delta, decision, decided_at
       FROM level_progress WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit) as Array<{
    session_number: number
    error_rate: number | null
    baseline_delta: number | null
    decision: string
    decided_at: number | null
  }>
}

/**
 * Top error corrections recorded during the user's first `sessions` ended
 * sessions.
 *
 * Uses `created_at` (first sighting) rather than the mutable `session_id`:
 * `session_id` is repointed to the latest occurrence whenever the same mistake
 * comes back, which is exactly what recurrence detection needs (§7.1).
 *
 * The cutoff is the start of the first session *after* the baseline window, so
 * errors recorded slightly after a session closed still count as baseline.
 */
export function baselineTopErrors(userId: number, limit = 3, sessions = 2): string[] {
  const ordered = getDb()
    .prepare(
      `SELECT id, started_at, COALESCE(ended_at, started_at) AS ended_at FROM sessions
       WHERE user_id = ?
       ORDER BY id ASC`
    )
    .all(userId) as Array<{ id: number; started_at: number; ended_at: number }>
  if (ordered.length === 0) return []

  const baselineWindow = ordered.slice(0, sessions)
  const after = ordered[sessions]
  const cutoff = after
    ? Math.max(...baselineWindow.map((s) => s.ended_at), after.started_at)
    : Number.MAX_SAFE_INTEGER

  const rows = getDb()
    .prepare(
      `SELECT correction, SUM(repeats) AS hits FROM error_log
       WHERE user_id = ? AND created_at <= ? AND correction IS NOT NULL
       GROUP BY correction
       ORDER BY hits DESC, MIN(created_at) ASC LIMIT ?`
    )
    .all(userId, cutoff, limit) as Array<{ correction: string; hits: number }>
  return rows.map((r) => r.correction).filter(Boolean)
}

/** Corrections that appeared in the user's most recent `sessions` sessions. */
export function recentErrorCorrections(userId: number, sessions = 3): string[] {
  const recent = getDb()
    .prepare(
      `SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, sessions) as Array<{ id: number }>
  if (recent.length === 0) return []
  const ids = recent.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT correction FROM error_log
       WHERE user_id = ? AND session_id IN (${placeholders}) AND correction IS NOT NULL`
    )
    .all(userId, ...ids) as Array<{ correction: string }>
  return rows.map((r) => r.correction)
}

// Average error rate over the last N ended sessions for a user.
export function recentErrorRateAverage(userId: number, n = 5): number | null {
  const rows = getDb()
    .prepare(
      `SELECT error_rate FROM sessions
       WHERE user_id = ? AND state = 'ended' AND error_rate IS NOT NULL
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, n) as Array<{ error_rate: number }>
  if (rows.length === 0) return null
  return rows.reduce((sum, r) => sum + r.error_rate, 0) / rows.length
}

/**
 * Average error rate of the FIRST `n` ended sessions — the learner's starting
 * point used as the progression baseline (§7.1).
 */
export function firstErrorRateAverage(userId: number, n = 2): number | null {
  const rows = getDb()
    .prepare(
      `SELECT error_rate FROM sessions
       WHERE user_id = ? AND state = 'ended' AND error_rate IS NOT NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(userId, n) as Array<{ error_rate: number }>
  if (rows.length === 0) return null
  return rows.reduce((sum, r) => sum + r.error_rate, 0) / rows.length
}

// ============================================================================
// Achievements
// ============================================================================

const ACHIEVEMENT_LABELS: Record<string, string> = {
  first_session: '🎉 First session complete',
  streak_5: '🔥 5 sessions in a row',
  ten_words: '📚 10 words learned',
  level_up: '🚀 Level up!',
  fifty_turns: '💬 50 turns of practice',
  no_errors_session: '✨ A whole session with no mistakes',
  pronunciation_10: '🗣 10 pronunciation drills',
  scenario_master: '🎭 Completed a role-play scenario',
}

export function achievementLabel(code: string): string {
  return ACHIEVEMENT_LABELS[code] ?? code
}

export function hasAchievement(userId: number, code: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM achievements WHERE user_id = ? AND code = ?')
    .get(userId, code) as { x: number } | undefined
  return Boolean(row)
}

export function awardAchievementIfNew(userId: number, code: string): boolean {
  const label = ACHIEVEMENT_LABELS[code] ?? code
  const info = getDb()
    .prepare(
      `INSERT INTO achievements (user_id, code, label, earned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, code) DO NOTHING`
    )
    .run(userId, code, label, Date.now())
  return info.changes > 0
}

/** Total number of turns the user has produced across all sessions. */
export function countUserTurns(userId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS cnt FROM dialog_messages WHERE user_id = ? AND role = 'user'"
    )
    .get(userId) as { cnt: number }
  return row.cnt
}

/** How many distinct sessions the learner has used (role-play included). */
export function countSessionsByType(userId: number, type: SessionType): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ? AND type = ? AND state = 'ended'")
    .get(userId, type) as { cnt: number }
  return row.cnt
}

/** Consecutive ended sessions (most recent first) whose error_rate is 0. */
export function countErrorFreeSessions(userId: number): number {
  const rows = getDb()
    .prepare(
      `SELECT error_rate FROM sessions
       WHERE user_id = ? AND state = 'ended' AND error_rate IS NOT NULL
       ORDER BY id DESC LIMIT 10`
    )
    .all(userId) as Array<{ error_rate: number }>
  let n = 0
  for (const r of rows) {
    if (r.error_rate === 0) n++
    else break
  }
  return n
}

export function listAchievements(userId: number) {
  return getDb()
    .prepare(
      'SELECT code, label, earned_at FROM achievements WHERE user_id = ? ORDER BY earned_at'
    )
    .all(userId) as Array<{ code: string; label: string; earned_at: number }>
}

