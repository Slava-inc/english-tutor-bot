// ============================================================================
// System prompts, scenario presets, topic lists
// ============================================================================

export interface ScenarioPreset {
  key: string
  label: string
  icon: string
  role: string
  description: string
  turns: number
}

export const TOPICS_BY_LEVEL: Record<string, string[]> = {
  A2: ['Daily routine', 'Food', 'Family', 'Weather', 'Shopping', 'My town'],
  B1: ['Travel', 'Daily routine', 'Food', 'Family', 'Hobbies', 'Work', 'Weather', 'Shopping'],
  'B1+': ['Environment', 'Technology', 'Health', 'News events', 'Opinions & debates'],
  B2: ['Politics (light)', 'Economy (basics)', 'Culture differences', 'Future plans', 'Global issues'],
}

/** Topics available for a level, falling back to B1 when the level is unknown. */
export function topicsForLevel(level: string | null | undefined): string[] {
  return TOPICS_BY_LEVEL[level ?? ''] ?? TOPICS_BY_LEVEL['B1']
}

export const GRAMMAR_LADDER = [
  'present_simple_past',
  'present_perfect',
  'conditionals_1_2',
  'passive_voice',
  'reported_speech',
  'mixed_conditionals',
  'advanced_connectors',
]

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    key: 'job_interview',
    label: 'Job interview',
    icon: '🏢',
    role: 'an HR manager interviewing a candidate',
    description: 'practice self-presentation, Past Simple and asking/answering interview questions',
    turns: 12,
  },
  {
    key: 'hotel_booking',
    label: 'Hotel booking',
    icon: '🏨',
    role: 'a hotel receptionist',
    description: 'practice modal verbs, numbers/dates and polite booking language',
    turns: 10,
  },
  {
    key: 'tech_support',
    label: 'Tech support call',
    icon: '📞',
    role: 'a tech-support operator',
    description: 'practice describing problems and first/second conditionals',
    turns: 10,
  },
  {
    key: 'at_the_doctor',
    label: 'At the doctor',
    icon: '🩺',
    role: 'a doctor',
    description: 'practice health vocabulary and Present Perfect for recent situations',
    turns: 11,
  },
  {
    key: 'small_talk',
    label: 'Small talk',
    icon: '☕',
    role: 'a friendly person at a party',
    description: 'practice Present Simple and common small-talk phrases',
    turns: 12,
  },
]

const BASE_RULES = `Ты — персональный репетитор британского английского.
Ученик: уровень {level}, цель {target}. Говори простыми словами и короткими фразами.
1. Исправляй ошибки кратко и объясняй, почему.
2. Вводи не более 2–3 новых слов за диалог (уровня B1→B2).
3. Усложняй грамматику согласно фокусу: {grammar_focus}.
4. Тренируй британское произношение: 1 слово-«ловушка» за диалог с транскрипцией RP.
5. Если ученик случайно пишет по-русски — вежливо верни к английскому и дай подсказку.
6. Веди диалог: в конце каждой реплики задавай 1 вопрос, чтобы ученик говорил.
7. Хвали за успехи, но исправляй всегда.
8. Если в списке «Целевые слова» есть слова уровня ученика — используй 1–2 из них в своей реплике естественно.
9. Блок 🎤 содержит ТОЛЬКО текст, который произносит репетитор вслух: без маркеров, без транскрипций, 2–4 предложения.
10. Все заголовки блоков (🎤, ✅ Fix, 📝 Why, 🎯 New, 🔊 British, 🗣 Next) пиши РОВНО так, как в шаблоне.`

/** Raw pupil-profile block assembled by tutor.ts (§3.3). */
export interface PupilProfile {
  level: string
  topic: string | null
  mode: 'free' | 'scenario'
  grammarFocus: string | null
  topErrors: string
  targetWords: string[]
}

/** Render the [УЧЕНИК — ПРОФИЛЬ] block of the prompt. */
export function pupilProfileBlock(p: PupilProfile): string {
  const lines = [
    '--- УЧЕНИК (профиль) ---',
    `Уровень: ${p.level}`,
    `Тема сессии: ${p.topic ?? 'свободная'}`,
    `Режим: ${p.mode}`,
    `Грамматика в фокусе: ${p.grammarFocus ?? 'определи по ответам ученика'}`,
    `Повторяющиеся ошибки: ${p.topErrors || 'пока нет'}`,
    `Целевые слова: ${p.targetWords.length ? p.targetWords.join(', ') : 'нет'}`,
    '--- КОНЕЦ ПРОФИЛЯ ---',
  ]
  return lines.join('\n')
}


/**
 * Build the FREE-mode system prompt (§4.1).
 */
export function freeSystemPrompt(opts: {
  name: string | null
  level: string
  target: string
  topic: string | null
  grammarFocus: string | null
  topErrors: string
  targetWords?: string[]
  coachTip?: string
  quiz?: { word: string } | null
}): string {
  const rules = BASE_RULES.replace('{level}', opts.level)
    .replace('{target}', opts.target)
    .replace('{grammar_focus}', opts.grammarFocus ?? 'подбери сам по уровню')

  const profile = pupilProfileBlock({
    level: opts.level,
    topic: opts.topic,
    mode: 'free',
    grammarFocus: opts.grammarFocus,
    topErrors: opts.topErrors,
    targetWords: opts.targetWords ?? [],
  })

  const topicLine = opts.topic
    ? `Сегодняшняя тема диалога: ${opts.topic}. Держись темы, но подстраивайся под ученика.`
    : 'Тему выбери сам по уровню ученика.'

  const extras: string[] = []
  if (opts.coachTip) extras.push(opts.coachTip)
  if (opts.quiz) {
    extras.push(
      `Вставь в 🗣 Next один вопрос на повторение слова: «Do you remember — what does *${opts.quiz.word}* mean?»`
    )
  }

  return (
    rules +
    `\n\nУченик: ${opts.name ?? 'student'}. ${topicLine}\n\n` +
    profile +
    (extras.length ? '\n\n' + extras.join('\n') : '') +
    `

Формат ответа (СТРОГО, по одному блоку на тип; блок можно опустить, если он не применим):
🎤 <текст для озвучки — только то, что говорит репетитор вслух, 2–4 предложения; БЕЗ маркеров и транскрипций>
✅ Fix: <как сказал ученик> → <как правильно>
📝 Why: <объяснение одной фразой>
🎯 New: <слово> — <перевод>; ...   (максимум 3)
🔊 British: <слово> = /транскрипция/ — <короткий комментарий>   (максимум 1)
🗣 Next: <один вопрос ученику>`
  )
}

/**
 * Build the SCENARIO-mode system prompt for a given preset (§4.1).
 *
 * Fix/Why blocks are still requested so the bot can record the learner's
 * mistakes, but rule 3 tells the model never to mention them in 🎤 — they are
 * surfaced later by /summary.
 */
export function scenarioSystemPrompt(opts: {
  name: string | null
  level: string
  target: string
  preset: ScenarioPreset
  topic: string | null
  grammarFocus: string | null
  topErrors: string
  targetWords?: string[]
  turnsDone?: number
  coachTip?: string
}): string {
  const { preset } = opts
  const lastTurn = (opts.turnsDone ?? 0) + 1 >= preset.turns

  const profile = pupilProfileBlock({
    level: opts.level,
    topic: opts.topic,
    mode: 'scenario',
    grammarFocus: opts.grammarFocus,
    topErrors: opts.topErrors,
    targetWords: opts.targetWords ?? [],
  })

  return `Ты играешь роль: ${preset.role}.
Задача ученика (уровень ${opts.level}, цель ${opts.target}): ${preset.description}.
Сценарий «${preset.label}», реплика ${(opts.turnsDone ?? 0) + 1} из ${preset.turns}.
${opts.coachTip ? opts.coachTip + '\n' : ''}
${profile}

Правила:
1. ОСТАВАЙСЯ В РОЛИ весь сценарий. Никогда не выходи из роли ради объяснений.
2. Молча фиксируй ошибки ученика в блоках ✅ Fix / 📝 Why. Эти блоки НЕ озвучиваются и НЕ упоминаются в 🎤 — их покажут ученику только в /summary.
3. В 🎤 реагируй естественно, как персонаж, и продвигай сценарий вперёд.
4. Если ученик застрял — дай мягкую подсказку прямо в реплике: «(You could say: ...)».
5. Говори 1–3 короткими предложениями, ровно как сказал бы живой собеседник.
${lastTurn
      ? '6. Это ПОСЛЕДНЯЯ реплика сценария: заверши разговор как персонаж (попрощайся, подведи итог по роли) и НЕ задавай новых вопросов.'
      : '6. Заканчивай реплику вопросом/репликой, которая двигает сцену вперёд.'}

Формат ответа (СТРОГО):
🎤 <реплика персонажа — то, что бот говорит в роли вслух>
✅ Fix: <как сказал ученик> → <как правильно>   (можно несколько строк)
📝 Why: <объяснение одной фразой>
🗣 Next: <реплика-продолжение (только если сценарий не завершён)>`
}
