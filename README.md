# English Tutor Bot 🇬🇧

[![CI](https://github.com/Slava-inc/english-tutor-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Slava-inc/english-tutor-bot/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Telegram-бот — персональный репетитор британского английского (B1 → B2).
Говорите голосом 🎤 или текстом; бот отвечает голосом британского диктора (TTS en-GB),
исправляет ошибки, ведёт журнал ошибок и словарный запас, проводит ролевые сценарии.

## Возможности

- **Разговорная практика**: исправление ошибок после каждой реплики с объяснением.
- **Голосовой ввод** (STT): local whisper-proxy → распознавание речи; `language=en`,
  уровень уверенности (`avg_logprob`) для мини-игры «скажи ещё раз».
- **Голосовой вывод** (TTS): **xAI Voice** (`POST https://api.x.ai/v1/tts`), `en-GB`,
  кодек `opus` → **настоящий Ogg-Opus контейнер**, который Telegram принимает как
  voice note без транскодинга. Дисковый кэш — быстрые повторные ответы.
  Fallback: только текст + 🔇. Провайдер переключается через `TTS_PROVIDER`
  (`xai` | `google`).
- **Сессионный автомат**: `idle → active → ended`, авто-закрытие по паузе (>4 ч) или
  по лимиту реплик (15 для free-практики, 10–12 для сценария).
- **Два режима**: свободный диалог (FREE) и ролевые сценарии (SCENARIO).
  В сценарии Fix/Why не показываются сразу — откладываются до `/summary`.
- **Память**: профиль пользователя, журнал ошибок, словарь со spaced repetition,
  лог произношения, baseline/delta прогрессии, бейджи.
- **Произношение**: модуль British Pronunciation Coach (22 слова-«ловушки» RP),
  интерактивный drill по `/pronounce`.
- **Прогрессия**: относительный критерий (снижение error_rate на ≥30 % для B1→B1+,
  ≥50 % для B1+→B2) + проверка, что старые ошибки не вернулись; повышение —
  только с подтверждения кнопкой.

## Команды

| Команда | Действие |
|---|---|
| `/start` | Онбординг (4 шага с inline-кнопками) или приветствие с темой дня |
| `/scenario` | Меню ролевых сценариев (5 пресетов) |
| `/pronounce` | Тренировка британского произношения |
| `/summary` | Итог сессии: ошибки (включая отложенные) + слова + рейтинг прогресса |
| `/stats` | Сессии, реплики, динамика error_rate, бейджи, словарь |
| `/words` | Словарь по статусам `new` / `learning` / `learned` |
| `/level` | Статус уровня, ladder, delta от baseline; `/level up` — повышение |
| `/cancel` | Выйти из сценария, drill или квиза |

## Требования

- Node.js ≥ 20
- Telegram-бот токен от @BotFather
- DeepSeek API key
- xAI API key (для озвучки ответов — `XAI_API_KEY`)
- whisper-proxy на `127.0.0.1:3011` (для голосового ввода)
- `ffmpeg`/`ffprobe` — только для проверочных скриптов

> **Legacy:** для отката на Google Cloud TTS задайте `TTS_PROVIDER=google` и
> service account JSON с включённым API Cloud Text-to-Speech.

## Установка и запуск

```bash
npm install
cp .env.example .env      # заполните токены
npm run dev               # разработка (tsx)
# или
npm run build && npm start
```

Проверка работоспособности — см. **[docs/КАК_ПРОВЕРИТЬ.md](docs/КАК_ПРОВЕРИТЬ.md)**:

```bash
npm run verify         # типы + 97 тестов
npm run rehearse       # весь диалог на mock-модели (без сети)
npm run rehearse:live  # настоящий DeepSeek + настоящий xAI TTS
```

### systemd

Бот работает как systemd-сервис `english-tutor`. Готовый шаблон юнита —
[`deploy/english-tutor.service.example`](deploy/english-tutor.service.example).

Установка:

```bash
cd /path/to/english-tutor-bot
sudo chown -R "$USER:$USER" . && sudo chmod 600 .env   # юнит запускается от вашего пользователя
sed -e "s|__PROJECT_DIR__|$PWD|g" -e "s|__RUN_USER__|$USER|g" \
    deploy/english-tutor.service.example | sudo tee /etc/systemd/system/english-tutor.service
sudo systemctl daemon-reload
sudo systemctl enable --now english-tutor
```

> Голосовой ввод требует отдельного `whisper-proxy` (или любого OpenAI-совместимого
> `/v1/audio/transcriptions`); его адрес задаётся через `WHISPER_URL`. Без него бот
> продолжает работать в текстовом режиме.

Управление:

```bash
systemctl status english-tutor          # состояние
systemctl restart english-tutor         # перезапуск после изменений кода
tail -f bot.log                         # живой лог (путь задан в юните)
```

## Архитектура

```
Telegram (grammy)
   ├ text ──────────────► handlers.ts ──► tutor.ts ──► DeepSeek
   ├ voice ──► whisper-proxy ──► handlers.ts ──► tutor.ts ──► TTS en-GB
   └ callbacks (сценарии, онбординг, level-up)
                              └── SQLite (better-sqlite3):
                                  users/sessions/dialog_messages/error_log/
                                  vocabulary/pronunciation_log/level_progress/achievements
```

## Структура

```
src/
  index.ts       Telegram entry: bot lifecycle, graceful shutdown
  handlers.ts    команды, текст/голос, inline-callbacks, онбординг, доставка ответа
  config.ts      чтение .env
  db.ts          SQLite: 8 таблиц, миграции, CRUD, сессионный автомат, spaced repetition
  llm.ts         клиент DeepSeek (+ setLlmMock для тестов)
  whisper.ts     STT через whisper-proxy (language=en, avg_logprob)
  speech.ts      TTS: xAI Voice (Ogg-Opus) + Google legacy, disk-кэш
  tutor.ts       ядро: собрать контекст → DeepSeek → разбор → записать → ответ
  response.ts    парсер маркеров + sanitizeForHistory
  prompts.ts     системные промпты FREE/SCENARIO, темы по уровням
  data/british-traps.ts        каталог 22 слов-«ловушек» RP
  processes/
    scenario.ts      5 пресетов, жизненный цикл, счётчик ходов
    pronunciation.ts Pronunciation Coach (уровни A/B), drill-состояние, фидбэк
    progression.ts   baseline, delta −30 %/−50 %, ladder, подтверждение повышения
    vocabulary.ts    spaced repetition, детект использования слов, квиз
    achievements.ts  бейджи и проверки достижений
tests/
  parse-response.test.ts  парсер маркеров (free + scenario)
  whisper.test.ts         parseWhisperPayload, sanitizeForHistory, сценарии
  db.test.ts              миграции, CRUD, сессионный автомат, история
  vocabulary.test.ts      переходы new→learning→learned, детект слов, квиз
  progression.test.ts     baseline, −30 %/−50 %, блокировка при рецидиве, level up
  scenario.test.ts        пресеты, жизненный цикл, прогресс
  achievements.test.ts    бейджи, идемпотентность, отчёты
  pronunciation.test.ts   каталог ловушек, фидбэк, similarity, лог
  speech.test.ts          xAI TTS: запрос/кэш/голоса/ошибки/Ogg-guard
  e2e-dialog.test.ts      диалог с mock DeepSeek: парсинг, история, режимы, лимит реплик
scripts/
  smoke.db.mjs            runtime-проверка собранного dist/ на временной БД
  verify-stt.mjs          живая проверка контракта whisper-proxy (verbose_json/avg_logprob)
  verify-tts.mjs          живая проверка xAI TTS (opus-контейнер, голоса, round-trip)
  verify-telegram-voice.mjs  пригодность аудио для Telegram sendVoice
```

## Тесты

```bash
npm run verify        # typecheck + 97 unit/integration-тестов (vitest)
npm run smoke         # build + runtime-проверка dist/ на временной БД
npm run verify:stt    # живая проверка контракта whisper-proxy
npm run verify:tts    # живая проверка xAI TTS (+ --all-voices, --keep)
npm run verify:voice  # Ogg-Opus пригодность для Telegram sendVoice
```

### Проверка озвучки

```bash
npm run verify:tts                          # голос из .env
npm run verify:tts -- --all-voices          # leo / rex / eve
npm run verify:tts -- --voice rex --keep    # сохранить артефакты
node scripts/verify-telegram-voice.mjs <chat_id>   # реальная отправка voice
```

Живая проверка подтверждает: `codec=opus` → `format_name=ogg`, `codec_name=opus`,
mono, 24 kHz; сквозной round-trip через whisper даёт **100 % совпадение** текста
при `avg_logprob ≈ −0.2`.

## Примечания

- Промпт диалога использует маркеры `🎤 spoken · ✅ Fix · 📝 Why · 🎯 New · 🔊 British · 🗣 Next`.
- В режиме сценария исправления накапливаются в `error_log` и выдаются в `/summary` (иммерсия не ломается).
- История для DeepSeek хранит только `🎤`-блок без маркеров; окно — последние 20 сообщений
  с бюджетом ~3000 токенов (минимум 6 последних сообщений сохраняется всегда).
- Прогрессия уровня требует отправной базовой метрики ошибок (baseline) — она считается
  автоматически после первых 2 сессий.

## Лицензия

[MIT](LICENSE) © Slava-inc
