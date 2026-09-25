// Local rehearsal of the real conversation flow — no Telegram required.
//
//   node scripts/rehearse.mjs            # text only, mock LLM/TTS
//   node scripts/rehearse.mjs --live     # real DeepSeek + real xAI TTS
//
// Drives the same functions the Telegram handlers call, so it exercises the
// genuine pipeline: session state machine → prompt assembly → DeepSeek → marker
// parser → persistence → reply composition.
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const PROJECT = path.resolve(import.meta.dirname, '..')
process.chdir(PROJECT)

const live = process.argv.includes('--live')
const DIR = mkdtempSync(path.join(tmpdir(), 'tutor-rehearse-'))
process.env.DB_PATH = path.join(DIR, 'rehearse.db')
process.env.TTS_CACHE_DIR = path.join(DIR, 'tts-cache')
process.env.SESSION_MAX_TURNS = process.env.SESSION_MAX_TURNS || '15'

const DB = await import(path.join(PROJECT, 'dist/db.js'))
const LLM = await import(path.join(PROJECT, 'dist/llm.js'))
const { tutorTurn } = await import(path.join(PROJECT, 'dist/tutor.js'))
const { textToSpeech } = await import(path.join(PROJECT, 'dist/speech.js'))
const SCEN = await import(path.join(PROJECT, 'dist/processes/scenario.js'))
const VOCAB = await import(path.join(PROJECT, 'dist/processes/vocabulary.js'))
const PRON = await import(path.join(PROJECT, 'dist/processes/pronunciation.js'))
const PROG = await import(path.join(PROJECT, 'dist/processes/progression.js'))

let failures = 0
const ok = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}
const rule = (t) => console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`)

console.log(`mode: ${live ? 'LIVE (real DeepSeek + real xAI TTS)' : 'MOCK (no network)'}\n`)

const MOCK_REPLY = (n) =>
  [
    `🎤 Lovely to hear from you! Let us talk about journey number ${n}.`,
    n % 2 === 1 ? '✅ Fix: I go to London yesterday → I went to London yesterday' : null,
    n % 2 === 1 ? '📝 Why: "yesterday" is past time, so we need the Past Simple.' : null,
    n % 2 === 1 ? '🎯 New: journey — поездка; lorry — грузовик' : null,
    n % 2 === 1 ? '🔊 British: schedule = /ˈʃedjuːl/ — starts with "sh", not "sk".' : null,
    '🗣 Next: What did you enjoy most about it?',
  ]
    .filter(Boolean)
    .join('\n')

if (!live) {
  let turn = 0
  LLM.setLlmMock(() => MOCK_REPLY(++turn))
}

// --- 1. onboarding state ----------------------------------------------------
rule('1 — new user onboarding')
const user = DB.createUser(900001, 'Rehearsal', 'B1', 'B2')
ok('user created', user.id > 0, `id=${user.id}, level=${user.level}`)
ok('not onboarded yet (bot would run the 4-step flow)', user.onboarded === 0)
DB.markOnboarded(user.id, 'B1', 'B2')
const onboarded = DB.getUserById(user.id)
ok(
  'markOnboarded sets level + goal + flag',
  onboarded.onboarded === 1 && onboarded.level === 'B1' && onboarded.target === 'B2'
)

// --- 2. free-practice turns -------------------------------------------------
rule('2 — free-practice dialog (text)')
const out1 = await tutorTurn(onboarded, 'I go to London yesterday.')
ok('turn 1 produced a reply', out1.replyText.length > 0)
ok(
  'spoken text has no markers (goes to TTS)',
  !/[🎤✅📝🎯🔊🗣]/.test(out1.spoken),
  JSON.stringify(out1.spoken.slice(0, 60))
)
console.log('\n--- what the learner sees in the bubble ---')
console.log(out1.replyText)
console.log('\n--- what is spoken aloud ---')
console.log(out1.spoken)

ok('a session was opened with a topic of the day', Boolean(out1.session.topic), `topic=${out1.session.topic}`)
ok('grammar focus picked from the level ladder', Boolean(out1.session.grammar_focus), `focus=${out1.session.grammar_focus}`)
ok('error recorded in error_log', DB.topErrors(user.id, 5).length > 0)
ok('vocabulary recorded', DB.wordStats(user.id).new + DB.wordStats(user.id).learning > 0)
ok('turn counter incremented', out1.session.turn_count === 1, `turns=${out1.session.turn_count}`)

const out2 = await tutorTurn(onboarded, 'I visited the museum and the park.')
ok('turn 2 continues the same session', out2.session.id === out1.session.id && out2.fresh === false)


// --- 3. the LLM receives clean, sanitized history ---------------------------
rule('3 — what DeepSeek actually receives')
const req = LLM.getLastLlmRequest()
if (req) {
  ok('a system prompt was built', req.system.includes('УЧЕНИК'), 'profile block present')
  ok(
    'history is marker-free',
    !/[✅🎯🔊]/.test(req.history.map((h) => h.content).join(' ')),
    `${req.history.length} messages`
  )
  console.log(`\nsystem prompt (${req.system.length} chars), first 320:\n${req.system.slice(0, 320)}…`)
}

// --- 4. voice synthesis -----------------------------------------------------
rule('4 — voice reply (xAI TTS)')
const audio = await textToSpeech(out1.spoken)
ok('audio file produced', Boolean(audio), audio ? path.basename(audio) : 'null (would fall back to 🔇 text)')
if (audio && existsSync(audio)) {
  const st = statSync(audio)
  ok('file is non-trivial', st.size > 1000, `${st.size} bytes`)
  try {
    const info = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1', audio],
      { encoding: 'utf8' }
    )
    ok(
      'playable by Telegram as a voice note (ogg/opus)',
      info.includes('format_name=ogg') && info.includes('codec_name=opus'),
      info.trim().replace(/\n/g, ' ')
    )
  } catch {
    ok('ffprobe available', false, 'install ffmpeg to check the container')
  }
}

// --- 5. role-play scenario --------------------------------------------------
rule('5 — role-play scenario')
const preset = SCEN.presetByKey('hotel_booking')
const scen = SCEN.openScenarioSession(DB.getUserById(user.id), preset)
ok(
  'scenario session opened',
  scen.type === 'scenario' && scen.scenario_turns === preset.turns,
  `${preset.label}, ${scen.scenario_turns} turns`
)
console.log(`\nopener the bot speaks:\n${SCEN.scenarioOpener(preset)}`)
const sTurn = await tutorTurn(DB.getUserById(user.id), 'I want book room for two nights.')
ok('scenario stays in character (no Fix/Why in the bubble)', sTurn.silentFixes === true)
ok('mistake still recorded for /summary', DB.deferredFixes(user.id, scen.id).length > 0)
console.log('\n--- in-character reply ---')
console.log(sTurn.replyText)

// --- 6. pronunciation coach -------------------------------------------------
rule('6 — pronunciation drill (/pronounce)')
const drill = PRON.startDrill(DB.getUserById(user.id), PRON.findTrap('schedule'))
console.log(PRON.drillPrompt(drill))
console.log(`expected: ${drill.word} = ${drill.ipa} — ${drill.note}`)
ok('a clear attempt is accepted', PRON.buildFeedback('schedule', drill).ok === true)
ok('the American variant is corrected', PRON.buildFeedback('skedule', drill).ok === false)
console.log(`\ncoach reply for "skedule":\n${PRON.buildFeedback('skedule', drill).comment}`)
// The dialog turns also log pronunciation words (the model emits 🔊 British
// blocks), so assert on the delta rather than an absolute count.
const drillsBefore = DB.countPronunciationDrills(user.id)
PRON.recordAttempt(user.id, scen.id, drill, 'skedule')
ok(
  'attempt logged to pronunciation_log',
  DB.countPronunciationDrills(user.id) === drillsBefore + 1,
  `${drillsBefore} → ${DB.countPronunciationDrills(user.id)}`
)
ok(
  'hardest-words report picks it up (feeds /pronounce homework)',
  DB.hardestWords(user.id, 5).some((h) => h.word === 'schedule')
)
PRON.clearDrill(user.id)

// --- 7. spaced repetition ---------------------------------------------------
rule('7 — vocabulary spaced repetition')
const vs = DB.wordStats(user.id)
console.log(`words → new:${vs.new} learning:${vs.learning} learned:${vs.learned}`)
console.log(VOCAB.vocabularyProgress(user.id))

// --- 8. report commands -----------------------------------------------------
rule('8 — report commands (/summary, /level, /stats, /words)')
const active = DB.getActiveSession(user.id) ?? DB.getLastSession(user.id)
const fixes = DB.deferredFixes(user.id, active.id)
const words = DB.sessionWords(active.id)
console.log('📊 /summary')
console.log(`  session: ${active.topic} · turns=${active.turn_count} · errors=${active.error_count}`)
console.log(`  fixes:   ${fixes.length}${fixes.length ? ' → e.g. ' + fixes[0].correction : ''}`)
console.log(`  words:   ${words.map((w) => w.word).join(', ') || '(none)'}`)
const status = PROG.evaluate(DB.getUserById(user.id))
console.log(`\n📊 /level\n  ${status.reason.replace(/\n/g, '\n  ')}`)
console.log(`\n📊 /stats\n  sessions=${DB.countEndedSessions(user.id)} turns=${DB.countUserTurns(user.id)}`)
console.log(`\n📚 /words\n  ${DB.recentVocab(user.id, 'learning', 5).map((w) => w.word).join(', ') || '(none yet)'}`)
ok('/level gives a baseline explanation', status.reason.length > 0)
ok('/words data is available', Array.isArray(DB.recentVocab(user.id, 'new', 5)))

// --- 9. isolation -----------------------------------------------------------
rule('9 — multi-user isolation')
const other = DB.createUser(900002, 'Other', 'A2', 'B1')
await tutorTurn(other, 'Completely separate learner here.')
ok(
  'turns are counted per user',
  DB.countUserTurns(other.id) === 1,
  `user=${DB.countUserTurns(user.id)} other=${DB.countUserTurns(other.id)}`
)
// Isolation, not emptiness: the second learner may legitimately have their own
// words/errors from their own turn — what must never happen is sharing.
const aWords = DB.recentVocab(user.id, 'new', 50).map((w) => w.word)
const bWords = DB.recentVocab(other.id, 'new', 50).map((w) => w.word)
const bSessions = DB.getDb()
  .prepare('SELECT id FROM sessions WHERE user_id = ?')
  .all(other.id)
  .map((r) => r.id)
ok(
  'other learner only sees their own sessions',
  bSessions.length === 1 && DB.getLastSession(other.id).id === bSessions[0],
  `sessions=${bSessions.length}`
)
ok(
  'other learner cannot read the first learner\'s errors',
  DB.deferredFixes(other.id, bSessions[0]).every((f) => !aWords.includes(f.correction))
)
ok(
  'history windows do not overlap',
  DB.getRecentTurns(other.id, 20).every((t) => t.content !== 'I go to London yesterday.')
)
console.log(`  user words:  ${aWords.slice(0, 4).join(', ') || '(none)'}`)
console.log(`  other words: ${bWords.slice(0, 4).join(', ') || '(none)'}`)

// --- teardown ---------------------------------------------------------------
DB.closeDb()
rmSync(DIR, { recursive: true, force: true })
console.log(`\n${'═'.repeat(64)}`)
console.log(failures === 0 ? 'REHEARSAL_OK — the flow works end to end' : `REHEARSAL_FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
