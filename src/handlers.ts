// ============================================================================
// Telegram handlers: commands, voice/text turns, inline callbacks (§10)
// ============================================================================

import { Bot, Context, InlineKeyboard, InputFile } from 'grammy'
import * as DB from './db.js'
import type { User } from './db.js'
import { ALLOWED_USER_IDS, TELEGRAM_BOT_TOKEN } from './config.js'
import { logger } from './logger.js'
import { tutorTurn, composeReplyText, buildHistory, type ChatOutcome } from './tutor.js'
import { transcribeAudio } from './whisper.js'
import { textToSpeech } from './speech.js'
import * as SCEN from './processes/scenario.js'
import * as PRON from './processes/pronunciation.js'
import * as VOCAB from './processes/vocabulary.js'
import * as PROG from './processes/progression.js'
import * as ACH from './processes/achievements.js'

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

function allowed(userId: number): boolean {
  if (ALLOWED_USER_IDS.length === 0) return true
  return ALLOWED_USER_IDS.includes(userId)
}

async function ensureUser(ctx: Context): Promise<User | null> {
  const tg = ctx.from
  if (!tg) return null
  return DB.getUserByTelegramId(tg.id) ?? DB.createUser(tg.id, tg.first_name ?? null)
}

function isOnboarded(user: User): boolean {
  return user.onboarded === 1
}

// ---------------------------------------------------------------------------
// Reply delivery
// ---------------------------------------------------------------------------

async function deliver(ctx: Context, outcome: ChatOutcome): Promise<void> {
  const text = withAchievements(outcome)
  // In scenario mode the bubble stays in character: only 🎤 + 🗣.
  const caption = outcome.silentFixes ? undefined : summaryCaption(text)
  let audioSent = false
  if (outcome.spoken) {
    const audioPath = await textToSpeech(outcome.spoken)
    if (audioPath) {
      try {
        await ctx.replyWithVoice(new InputFile(audioPath), { caption })
        audioSent = true
      } catch (e) {
        logger.warn({ error: String(e) }, 'voice reply failed, falling back to text')
      }
    }
  }
  if (!audioSent) {
    await ctx.reply(outcome.spoken ? `🔇 ${text}` : text, { parse_mode: 'HTML' })
  }
}

/** Keep only the fixes / new words / RP tip so the caption is compact (§3.2 item 9). */
function summaryCaption(replyText: string): string | undefined {
  if (!replyText) return undefined
  const lines = replyText
    .split('\n')
    .filter((line) => /^(✅|🎯|🔊|📝)/.test(line.trim()))
  return lines.length ? lines.join('\n').slice(0, 1000) : undefined
}

function withAchievements(outcome: ChatOutcome): string {
  if (outcome.achievements.length === 0) return outcome.replyText
  return (
    outcome.replyText +
    '\n\n' + outcome.achievements.map((label) => `${label} — well done!`).join('\n')
  )
}


// ---------------------------------------------------------------------------
// Turn handling: text, voice, pronunciation drill, vocabulary quiz
// ---------------------------------------------------------------------------

async function handleTurn(ctx: Context, text: string): Promise<void> {
  const user = await ensureUser(ctx)
  if (!user) return

  // An active pronunciation drill consumes the next input with a coaching reply.
  if (PRON.getDrill(user.id)) {
    await handleDrillAnswer(ctx, user, text)
    return
  }

  // An outstanding vocabulary recall question is answered before a normal turn.
  const quiz = VOCAB.getQuiz(user.id)
  if (quiz) {
    await handleQuizAnswer(ctx, user, text)
    return
  }

  await ctx.replyWithChatAction('typing')
  const outcome = await tutorTurn(user, text)
  await deliver(ctx, outcome)

  if (outcome.ended) {
    await offerLevelUpIfEarned(ctx, user)
  }
}

async function handleText(ctx: Context): Promise<void> {
  const from = ctx.from
  const text = (ctx.message?.text ?? '').trim()
  if (!from || !text) return
  if (!allowed(from.id)) {
    await ctx.reply('Access denied.')
    return
  }
  if (text.startsWith('/')) return // commands have their own middleware
  const existing = DB.getUserByTelegramId(from.id)
  if (!existing || !isOnboarded(existing)) {
    // Telegram normally provides first_name; when it does not, onboarding step 1
    // collects the name from typed text instead of the inline buttons.
    if (existing && !existing.first_name && !isOnboarded(existing)) {
      await handleOnboardingInput(ctx, text)
      return
    }
    await startOnboarding(ctx)
    return
  }
  await handleTurn(ctx, text)
}

async function handleVoice(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from) return
  if (!allowed(from.id)) {
    await ctx.reply('Access denied.')
    return
  }
  const user = await ensureUser(ctx)
  if (!user) return
  if (!isOnboarded(user)) {
    await startOnboarding(ctx)
    return
  }

  const voice = ctx.message?.voice ?? ctx.message?.audio
  if (!voice || !ctx.message) return

  await ctx.replyWithChatAction('typing')
  let transcript = ''
  let avgLogprob: number | undefined
  try {
    const file = await ctx.api.getFile(voice.file_id)
    if (!file.file_path) throw new Error('no file path')
    const buf = await downloadTelegramFile(file.file_path)
    const res = await transcribeAudio(
      new Uint8Array(buf),
      file.file_path.split('/').pop() ?? 'voice.ogg'
    )
    if (!res.ok || !res.text) {
      await ctx.reply('🎙 Couldn’t catch that — please write it or try again.')
      return
    }
    transcript = res.text
    avgLogprob = res.avgLogprob
  } catch (e) {
    logger.warn({ error: String(e) }, 'voice download/transcription failed')
    await ctx.reply('🎙 Couldn’t catch that — please write it or try again.')
    return
  }

  // Level B mini-game: a poorly recognised segment triggers "say it again" (§5.1).
  if (typeof avgLogprob === 'number' && avgLogprob < PRON.LOW_CONFIDENCE_LOGPROB) {
    const words = PRON.lowConfidenceWords([{ text: transcript, avg_logprob: avgLogprob }])
    if (words.length > 0 && !PRON.getDrill(user.id)) {
      const drill = PRON.startDrill(user, PRON.findTrap(words[0]) ?? undefined)
      await ctx.reply(
        `${PRON.retryPrompt(words[0])}\n\n(${drill.word} = ${drill.ipa} — ${drill.note})`
      )
      return
    }
  }

  await handleTurn(ctx, transcript)
}

/** Download a Telegram file by its server file_path. */
async function downloadTelegramFile(filePath: string): Promise<Uint8Array> {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`telegram file http ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}

// ---------------------------------------------------------------------------
// Pronunciation drill (§5.2)
// ---------------------------------------------------------------------------

async function handleDrillAnswer(ctx: Context, user: User, heard: string): Promise<void> {
  const drill = PRON.getDrill(user.id)
  if (!drill) return
  const feedback = PRON.buildFeedback(heard, drill)
  const session = DB.getActiveSession(user.id)
  PRON.recordAttempt(user.id, session?.id ?? null, drill, heard)

  await ctx.reply(feedback.comment)

  if (!feedback.retry) {
    PRON.clearDrill(user.id)
    const next = PRON.startDrill(user, PRON.pickTrap(user.id, drill.word))
    await ctx.reply(`🎉 Nice one!\n\n${PRON.drillPrompt(next)}`)
  } else if (drill.attempts >= 3) {
    // Give up gracefully after three tries and move to a fresh word.
    PRON.clearDrill(user.id)
    const next = PRON.startDrill(user, PRON.pickTrap(user.id, drill.word))
    await ctx.reply(
      `Let’s come back to “${drill.word}” later. New word:\n\n${PRON.drillPrompt(next)}`
    )
  }
}

// ---------------------------------------------------------------------------
// Vocabulary recall quiz (§5.3)
// ---------------------------------------------------------------------------

async function handleQuizAnswer(ctx: Context, user: User, answer: string): Promise<void> {
  const quiz = VOCAB.getQuiz(user.id)
  if (!quiz) return
  const ok = VOCAB.judgeQuizAnswer(quiz, answer)
  VOCAB.clearQuiz(user.id)

  if (ok) {
    const status = VOCAB.noteCorrectUse(user.id, quiz.word)
    const badge = ACH.checkVocabularyAchievements(user)
    await ctx.reply(
      `✅ Yes! “${quiz.word}”${quiz.translation ? ` = ${quiz.translation}` : ''}. Remembered it!` +
        (status === 'learned' ? `\n\n🏆 “${quiz.word}” is now marked as learned.` : '') +
        ACH.celebrate(badge)
    )
  } else {
    await ctx.reply(
      `📝 Not quite. “${quiz.word}”${quiz.translation ? ` = ${quiz.translation}` : ''}. ` +
        `I’ll ask again soon — now, let’s carry on.`
    )
  }

  // The answered message is also the learner's turn for the dialog.
  await handleTurn(ctx, answer)
}

// ---------------------------------------------------------------------------
// Onboarding (§10.1) — four steps, one message each
// ---------------------------------------------------------------------------

const ONBOARD_LEVELS: Array<{ label: string; value: string }> = [
  { label: 'A2 — Elementary', value: 'A2' },
  { label: 'B1 — Pre-Intermediate', value: 'B1' },
  { label: 'B2 — Upper-Intermediate', value: 'B2' },
]

const ONBOARD_GOALS: Array<{ label: string; value: string }> = [
  { label: 'Reach B2', value: 'B2' },
  { label: 'Pass IELTS', value: 'IELTS' },
  { label: 'Work / business', value: 'Work' },
  { label: 'Travel', value: 'Travel' },
  { label: 'Just chat', value: 'Chat' },
]

async function startOnboarding(ctx: Context): Promise<void> {
  const user = await ensureUser(ctx)
  if (!user) return
  if (isOnboarded(user)) {
    await cmdStart(ctx)
    return
  }
  // Telegram already gave us a first name — use it and move straight to the level.
  await ctx.reply(
    `👋 Hello${user.first_name ? ', ' + user.first_name : ''}! I'm your British English tutor 🇬🇧\n\n` +
      `Three quick questions and we'll start.\n📊 What's your current level?`,
    { reply_markup: levelKeyboard() }
  )
}

/**
 * Text arriving during onboarding. Only the name step consumes free text; every
 * other step is button-driven, so we simply nudge the learner back to them.
 */
async function handleOnboardingInput(ctx: Context, text: string): Promise<void> {
  const user = await ensureUser(ctx)
  if (!user) return
  if (!user.first_name) {
    DB.updateUser(user.id, { first_name: text.slice(0, 64) })
    await ctx.reply(`Nice to meet you, ${text}! 📊 What's your current level?`, {
      reply_markup: levelKeyboard(),
    })
    return
  }
  // Name already known — the remaining steps are inline buttons.
  await ctx.reply('Please pick an option with the buttons above ☝️', {
    reply_markup: levelKeyboard(),
  })
}

function levelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const l of ONBOARD_LEVELS) kb.text(l.label, `onboard:level:${l.value}`).row()
  return kb
}

function goalKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  ONBOARD_GOALS.forEach((g, i) => {
    kb.text(g.label, `onboard:goal:${g.value}`)
    if (i % 2 === 1) kb.row()
  })
  return kb
}


// ---------------------------------------------------------------------------
// Commands (§10)
// ---------------------------------------------------------------------------

async function cmdStart(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  if (!isOnboarded(user)) {
    await startOnboarding(ctx)
    return
  }

  // A returning learner: close stale sessions and greet with the topic of the day.
  DB.endStaleSessions(user.id)
  const last = DB.getLastSession(user.id)
  const gapMs = last?.ended_at ? Date.now() - last.ended_at : Infinity
  const longBreak = gapMs > 24 * 60 * 60 * 1000

  const prog = PROG.evaluate(user)
  const topic = last?.topic ?? 'Travel'
  const welcome = longBreak ? 'Welcome back! ' : ''
  await ctx.reply(
    `${welcome}🇬🇧 Good to see you${user.first_name ? ', ' + user.first_name : ''}!\n\n` +
      `Level: <b>${user.level}</b> → ${user.target}\n` +
      `Today's topic: <b>${topic}</b> 🌍\n\n` +
      `Send a voice note 🎤 or type — let's practise!\n` +
      `<i>${prog.reason}</i>`,
    { parse_mode: 'HTML' }
  )
}

async function cmdScenario(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  await ensureUser(ctx)
  const kb = new InlineKeyboard()
  for (const p of SCEN.presetList()) {
    kb.text(`${p.icon} ${p.label}`, `scenario:${p.key}`).row()
  }
  kb.text('❌ Cancel', 'scenario:cancel').row()
  await ctx.reply('🎭 Pick a role-play scenario:', { reply_markup: kb })
}

async function cmdPronounce(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const homework = PRON.pronunciationHomework(user.id, 3)
  const drill = PRON.startDrill(user)
  await ctx.reply(
    '🔊 <b>British Pronunciation Coach</b>\n\n' +
      `Tricky words for you: ${homework.map((h) => `${h.word} ${h.ipa}`).join(', ')}\n\n` +
      PRON.drillPrompt(drill) +
      '\n\n<i>/cancel to stop the drill.</i>',
    { parse_mode: 'HTML' }
  )
}

async function cmdSummary(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const active = DB.getActiveSession(user.id)
  const target = active ?? DB.getLastSession(user.id)
  if (!target) {
    await ctx.reply('📊 We haven’t had a session yet — send me a message and we’ll start!')
    return
  }

  const words = DB.sessionWords(target.id)
  const fixes = DB.deferredFixes(user.id, target.id)
  const prog = PROG.evaluate(user)

  const lines = [
    `📊 <b>Session summary</b>${target.topic ? ` — ${target.topic}` : ''}`,
    `Turns: ${target.turn_count} · errors: ${target.error_count}` +
      (target.error_rate != null ? ` · error rate: ${target.error_rate}%` : ''),
  ]

  if (fixes.length) {
    lines.push('', '📝 <b>What to look at</b>')
    for (const f of fixes.slice(0, 8)) {
      lines.push(`• ${f.user_phrase ?? '—'} → ${f.correction ?? '—'}`)
      if (f.explanation) lines.push(`   <i>${f.explanation}</i>`)
    }
  } else {
    lines.push('', '✨ No mistakes recorded in this session — excellent!')
  }

  if (words.length) {
    lines.push('', '📚 <b>Words from this session</b>')
    for (const w of words.slice(0, 5)) {
      lines.push(`• ${w.word}${w.translation ? ` — ${w.translation}` : ''} <i>(${w.status})</i>`)
    }
  }

  if (active) {
    DB.endSession(active.id)
    DB.promoteNewToLearningOnSessionEnd(user.id)
    DB.setSessionSummary(
      active.id,
      [`turns=${active.turn_count}`, `errors=${active.error_count}`].join(' ')
    )
    DB.updateUser(user.id, { session_count: DB.countEndedSessions(user.id) })
    lines.push('', '✅ Session closed — your next message starts a fresh one.')
  }

  lines.push('', `<i>${prog.reason}</i>`)
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })

  if (active) await offerLevelUpIfEarned(ctx, user)
}

async function cmdStats(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const sessions = DB.countEndedSessions(user.id)
  const current = PROG.currentErrorRate(user.id)
  const prog = PROG.evaluate(user)
  const turns = DB.countUserTurns(user.id)
  const scenarios = DB.countSessionsByType(user.id, 'scenario')
  const drills = DB.countPronunciationDrills(user.id)

  const lines = [
    `📈 <b>${user.first_name ?? 'Student'}</b>`,
    `Level: <b>${user.level}</b> → target ${user.target}`,
    `Sessions: ${sessions} (role-plays: ${scenarios}) · turns: ${turns} · drills: ${drills}`,
  ]

  if (prog.baseline != null) {
    lines.push(
      '',
      '<b>Error rate dynamics</b>',
      `Baseline (first ${PROG.BASELINE_SESSIONS} sessions): ${prog.baseline.toFixed(1)}%`,
      `Last ${PROG.PROGRESSION_WINDOW}: ${current != null ? current.toFixed(1) + '%' : '—'}`
    )
    if (prog.deltaPercent != null) {
      const arrow = prog.deltaPercent >= 0 ? '↓' : '↑'
      lines.push(
        `Change: ${arrow} ${Math.abs(prog.deltaPercent)}% (goal ≥ ${prog.requiredPercent}%)`
      )
    }
  } else {
    lines.push('', `<i>Baseline will be set after ${PROG.BASELINE_SESSIONS} sessions.</i>`)
  }

  lines.push('', VOCAB.vocabularyProgress(user.id), '', ACH.badgeReport(user))
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function cmdWords(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const stats = DB.wordStats(user.id)
  const fresh = DB.recentVocab(user.id, 'new', 10)
  const learning = DB.recentVocab(user.id, 'learning', 50)
  const learned = DB.recentVocab(user.id, 'learned', 10)

  const lines = ['📚 <b>Your vocabulary</b>', VOCAB.vocabularyProgress(user.id)]

  if (fresh.length) {
    lines.push('', '<b>🆕 New (up to 10)</b>')
    for (const w of fresh) lines.push(`• ${w.word}${w.translation ? ` — ${w.translation}` : ''}`)
  }
  if (learning.length) {
    lines.push('', `<b>🔁 Learning (${stats.learning})</b>`)
    for (const w of learning.slice(0, 15)) {
      lines.push(`• ${w.word}${w.translation ? ` — ${w.translation}` : ''} (×${w.review_count})`)
    }
  }
  if (learned.length) {
    lines.push('', `<b>✅ Learned (${stats.learned})</b>`)
    lines.push(learned.map((w) => w.word).join(', '))
  }
  if (!fresh.length && !learning.length && !learned.length) {
    lines.push('', 'No words collected yet — keep chatting and I’ll note them down!')
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function cmdLevel(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const arg = (ctx.message?.text ?? '').split(/\s+/).slice(1).join(' ').trim().toLowerCase()
  if (arg === 'up') {
    await applyLevelUp(ctx, user)
    return
  }

  const prog = PROG.evaluate(user)
  const lines = [
    '📊 <b>Level status</b>',
    `Current: <b>${prog.level}</b> → next: <b>${prog.nextLevel}</b>`,
    '',
    PROG.ladderLabel(prog.level),
    '',
    prog.reason,
  ]
  if (prog.shouldSuggestUp) {
    lines.push('', '🚀 You have earned a level-up!')
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: levelUpKeyboard() })
    return
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function cmdCancel(ctx: Context): Promise<void> {
  const from = ctx.from
  if (!from || !allowed(from.id)) return
  const user = await ensureUser(ctx)
  if (!user) return

  const hadDrill = Boolean(PRON.getDrill(user.id))
  const hadQuiz = Boolean(VOCAB.getQuiz(user.id))
  PRON.clearDrill(user.id)
  VOCAB.clearQuiz(user.id)

  const active = DB.getActiveSession(user.id)
  if (active) DB.endSession(active.id)
  DB.promoteNewToLearningOnSessionEnd(user.id)

  const what = hadDrill ? 'the pronunciation drill' : hadQuiz ? 'the word quiz' : 'that session'
  await ctx.reply(`❌ Stopped ${what}. Back to free practice — what shall we talk about?`)
}

// ---------------------------------------------------------------------------
// Level progression (§7.1) — offer and confirmation
// ---------------------------------------------------------------------------

function levelUpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Yes, upgrade me', 'levelup:confirm')
    .text('Not yet', 'levelup:decline')
}

/** After a session ends, proactively offer an earned promotion. */
async function offerLevelUpIfEarned(ctx: Context, user: User): Promise<void> {
  const fresh = DB.getUserById(user.id) ?? user
  const prog = PROG.evaluate(fresh)
  if (!prog.shouldSuggestUp) return
  await ctx.reply(
    `🚀 <b>You've earned a level-up!</b>\n\n` +
      `Your error rate dropped ${prog.deltaPercent}% since the baseline ` +
      `(needed ≥ ${prog.requiredPercent}%).\n` +
      `${prog.level} → <b>${prog.nextLevel}</b>\n\n` +
      `Shall we move up?`,
    { parse_mode: 'HTML', reply_markup: levelUpKeyboard() }
  )
}

async function applyLevelUp(ctx: Context, user: User): Promise<void> {
  const prog = PROG.evaluate(user)
  if (!prog.shouldSuggestUp) {
    await ctx.reply(`📊 Not quite ready yet — keep practising!\n\n${prog.reason}`, {
      parse_mode: 'HTML',
    })
    return
  }
  const { from, to } = PROG.confirmLevelUp(user)
  await ctx.reply(
    `🎉 <b>Congratulations!</b> You are now <b>${to}</b> (was ${from}).\n\n` +
      `Our lessons will use richer vocabulary and new grammar: ` +
      `${PROG.ladderLabel(to)}\n\n` +
      `Let's carry on — send me a voice note 🎤`,
    { parse_mode: 'HTML' }
  )
}

// ---------------------------------------------------------------------------
// Inline callbacks: onboarding, scenario, level-up
// ---------------------------------------------------------------------------

async function onCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data
  const from = ctx.callbackQuery?.from
  if (!data || !from) return
  if (!allowed(from.id)) {
    await ctx.answerCallbackQuery({ text: 'Access denied.' })
    return
  }

  try {
    const user = DB.getUserByTelegramId(from.id) ?? DB.createUser(from.id, from.first_name ?? null)

    if (data.startsWith('onboard:')) {
      await onOnboardCallback(ctx, user, data)
      return
    }
    if (data.startsWith('scenario:')) {
      await onScenarioCallback(ctx, user, data.slice('scenario:'.length))
      return
    }
    if (data.startsWith('levelup:')) {
      const choice = data.slice('levelup:'.length)
      if (choice === 'confirm') {
        await ctx.answerCallbackQuery({ text: 'Upgrading…' })
        await applyLevelUp(ctx, user)
      } else {
        DB.recordLevelProgress(user.id, DB.countEndedSessions(user.id), null, null, 'declined')
        await ctx.answerCallbackQuery({ text: 'No problem — we keep working.' })
        await ctx.reply('👍 Not yet — let us keep strengthening the basics. Tell me about your day!')
      }
      return
    }

    await ctx.answerCallbackQuery()
  } catch (e) {
    logger.warn({ error: String(e) }, 'callback handling failed')
    await ctx.answerCallbackQuery({ text: 'Something went wrong, try again.' })
  }
}

async function onOnboardCallback(ctx: Context, user: User, data: string): Promise<void> {
  const [, kind, value] = data.split(':')

  if (kind === 'level') {
    const level = DB.normalizeLevel(value)
    DB.updateUser(user.id, { level })
    await ctx.answerCallbackQuery({ text: `Level: ${level}` })
    await ctx.editMessageText(
      `Great! And what's your goal? 🎯\n\n(current level: ${level})`
    ).catch(() => undefined)
    await ctx.reply('Pick your goal:', { reply_markup: goalKeyboard() })
    return
  }

  if (kind === 'goal') {
    const fresh = DB.getUserById(user.id) ?? user
    DB.markOnboarded(user.id, DB.normalizeLevel(fresh.level), value)
    await ctx.answerCallbackQuery({ text: `Goal: ${value}` })
    await ctx.editMessageText(`Perfect — goal saved: ${value} 🎯`).catch(() => undefined)

    // Step 4: open the very first session with the topic of the day.
    const updated = DB.getUserById(user.id) ?? fresh
    const opener = await tutorTurn(
      updated,
      'Hello! I have just set up my profile. Please start our first lesson.'
    )
    await deliver(ctx, opener)
    return
  }

  await ctx.answerCallbackQuery()
}

async function onScenarioCallback(ctx: Context, user: User, key: string): Promise<void> {
  if (key === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' })
    await ctx.editMessageText('🎭 Scenario cancelled.').catch(() => undefined)
    return
  }

  const preset = SCEN.presetByKey(key)
  if (!preset) {
    await ctx.answerCallbackQuery({ text: 'Unknown scenario' })
    return
  }

  PRON.clearDrill(user.id)
  VOCAB.clearQuiz(user.id)
  const session = SCEN.openScenarioSession(user, preset)
  await ctx.answerCallbackQuery({ text: `Started: ${preset.label}` })
  await ctx
    .editMessageText(
      `🎭 <b>${preset.label}</b> started — ${session.scenario_turns} turns, stay in character!`,
      { parse_mode: 'HTML' }
    )
    .catch(() => undefined)

  const opener = SCEN.scenarioOpener(preset)
  const audioPath = await textToSpeech(opener)
  if (audioPath) {
    try {
      await ctx.replyWithVoice(new InputFile(audioPath))
      return
    } catch {
      /* fall through to text */
    }
  }
  await ctx.reply(opener)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHandlers(bot: Bot): void {
  bot.command('start', cmdStart)
  bot.command('scenario', cmdScenario)
  bot.command('pronounce', cmdPronounce)
  bot.command('summary', cmdSummary)
  bot.command('stats', cmdStats)
  bot.command('words', cmdWords)
  bot.command('level', cmdLevel)
  bot.command('cancel', cmdCancel)
  bot.command('help', cmdStart)

  bot.on('callback_query:data', onCallback)
  bot.on('message:voice', handleVoice)
  bot.on('message:audio', handleVoice)
  bot.on('message:text', handleText)
}

