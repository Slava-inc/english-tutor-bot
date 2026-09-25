// Runtime smoke test for the compiled DB + process layers.
// Run with:  npm run build && node scripts/smoke.db.mjs
// Uses a throwaway database so the real data/ directory is untouched.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const dir = mkdtempSync(path.join(tmpdir(), 'tutor-smoke-'))
process.env.DB_PATH = path.join(dir, 'smoke.db')
process.env.TTS_CACHE_DIR = path.join(dir, 'tts-cache')
process.env.SESSION_MAX_TURNS = '15'

const DB = await import('../dist/db.js')
const PROG = await import('../dist/processes/progression.js')
const VOCAB = await import('../dist/processes/vocabulary.js')
const SCEN = await import('../dist/processes/scenario.js')
const ACH = await import('../dist/processes/achievements.js')
const PRON = await import('../dist/processes/pronunciation.js')

function ok(label, condition, detail = '') {
  if (!condition) throw new Error(`FAILED: ${label} ${detail}`)
  console.log(`✓ ${label}${detail ? ' — ' + detail : ''}`)
}

DB.getDb() // init schema

// --- users & sessions ------------------------------------------------------
const u = DB.createUser(999999001, 'SmokeTest', 'B1', 'B2')
ok('user created', u.id > 0 && u.level === 'B1', `id=${u.id}`)
ok('user creation is idempotent', DB.createUser(999999001, 'Again').id === u.id)

const s = DB.createSession(u.id, {
  type: 'free',
  topic: 'Travel',
  grammar_focus: 'present_perfect',
})
ok('session created', s.state === 'active' && s.topic === 'Travel', `id=${s.id}`)

DB.saveMessage(u.id, s.id, 'user', 'I go to London yesterday.')
DB.addErrors(u.id, s.id, [
  {
    category: 'grammar',
    userPhrase: 'I go to London yesterday.',
    correction: 'I went to London yesterday.',
    explanation: 'past time → Past Simple',
  },
])
const added = DB.addVocabulary(u.id, s.id, [{ word: 'journey', translation: 'поездка' }])
ok('vocabulary added', added === 1)
ok('top error tracked', DB.topErrors(u.id)[0]?.correction === 'I went to London yesterday.')
ok('deferred fixes visible for /summary', DB.deferredFixes(u.id, s.id).length === 1)

DB.incrementSession(s.id, 1)
DB.endSession(s.id)
DB.promoteNewToLearningOnSessionEnd(u.id)
const ended = DB.getSessionById(s.id)
ok('session closed', ended.state === 'ended', `error_rate=${ended.error_rate}`)
ok('ended session counted', DB.countEndedSessions(u.id) === 1)

// --- spaced repetition -----------------------------------------------------
ok('new word promoted on session end', DB.wordStats(u.id).learning === 1)
const used = VOCAB.detectUsedWords(u.id, 'My journey to Bath was lovely.')
ok('word usage detected in learner text', used.includes('journey'))
VOCAB.noteCorrectUse(u.id, 'journey')
VOCAB.noteCorrectUse(u.id, 'journey')
ok('new → learned after three correct uses', VOCAB.noteCorrectUse(u.id, 'journey') === 'learned')

// --- pronunciation coach ---------------------------------------------------
const drill = PRON.startDrill(u, PRON.findTrap('schedule'))
ok('drill accepts a clear pronunciation', PRON.buildFeedback('schedule', drill).ok === true)
ok('drill rejects the American variant', PRON.buildFeedback('skedule', drill).ok === false)
PRON.recordAttempt(u.id, s.id, drill, 'schedule')
ok('pronunciation logged', DB.countPronunciationDrills(u.id) === 1)

// --- scenarios -------------------------------------------------------------
const preset = SCEN.presetByKey('hotel_booking')
const scen = SCEN.openScenarioSession(u, preset)
ok('scenario opened', scen.type === 'scenario' && scen.scenario_turns === preset.turns)
ok('previous session auto-closed', DB.getSessionById(s.id).state === 'ended')

// --- progression & achievements -------------------------------------------
const rate = PROG.currentErrorRate(u.id)
ok('error rate measured', typeof rate === 'number', `${rate}%`)
const status = PROG.evaluate(DB.getUserById(u.id))
ok('progression evaluated', typeof status.reason === 'string' && status.reason.length > 0)
ok('baseline pending with one session', status.baseline === null)

ACH.checkSessionAchievements(DB.getUserById(u.id), DB.getSessionById(s.id))
ok('first-session badge awarded', DB.hasAchievement(u.id, 'first_session'))

// --- health check ----------------------------------------------------------
const tables = DB.getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name)
ok(
  'schema has all eight tables',
  [
    'users',
    'sessions',
    'dialog_messages',
    'error_log',
    'vocabulary',
    'pronunciation_log',
    'level_progress',
    'achievements',
  ].every((t) => tables.includes(t))
)

DB.closeDb()
rmSync(dir, { recursive: true, force: true })
console.log('\nSMOKE_OK')
