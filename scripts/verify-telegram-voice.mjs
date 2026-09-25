// End-to-end Telegram voice-note acceptance test.
//
// Telegram's sendVoice requires Ogg-Opus. This script:
//   1. synthesizes a reply through the real xAI endpoint (active provider)
//   2. asserts the payload is structurally Ogg-Opus (ffprobe + magic bytes)
//   3. optionally delivers it with sendVoice to a real chat
//
// NOTE: step 3 needs a chat the bot can reach — Telegram resolves the chat
// *before* validating media, so an unreachable chat answers `chat not found`
// for valid and invalid files alike. Get a usable id by messaging the bot:
//   TOKEN=$(grep ^TELEGRAM_BOT_TOKEN= .env | cut -d= -f2-)
//   curl -s "https://api.telegram.org/bot$TOKEN/getUpdates"
//
//   node scripts/verify-telegram-voice.mjs [chat_id] [--skip-send]
//
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'

const PROJECT = path.resolve(import.meta.dirname, '..')
process.chdir(PROJECT)

const argv = process.argv.slice(2)
const skipSend = argv.includes('--skip-send')
const chatId = argv.find((a) => /^-?\d+$/.test(a))

process.env.TTS_CACHE_DIR = mkdtempSync(path.join(tmpdir(), 'tg-voice-'))
const { textToSpeech, isOggContainer, isOpusStream } = await import(
  path.join(PROJECT, 'dist/speech.js')
)
const { TELEGRAM_BOT_TOKEN, TTS_XAI_VOICE, TTS_PROVIDER } = await import(
  path.join(PROJECT, 'dist/config.js')
)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

function probe(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,sample_rate,channels',
        '-show_entries', 'format=format_name,duration',
        '-of', 'default=noprint_wrappers=1',
        file,
      ],
      { encoding: 'utf8' }
    )
    const map = {}
    for (const line of out.trim().split('\n')) {
      const [k, v] = line.split('=')
      if (k) map[k] = v
    }
    return map
  } catch (e) {
    return { error: String(e).slice(0, 120) }
  }
}

const SENTENCE =
  'Lovely work! Your past tense is improving. Let us practise the word schedule next.'

console.log(`provider : ${TTS_PROVIDER}`)
console.log(`voice    : ${TTS_XAI_VOICE}`)
console.log(`chat_id  : ${chatId ?? '(none — send step skipped)'}`)
console.log('')

const file = await textToSpeech(SENTENCE, { voice: TTS_XAI_VOICE })
check('TTS produced a file', Boolean(file), file ?? 'null')

if (file) {
  const bytes = readFileSync(file)
  const info = probe(file)

  check('starts with the OggS page header', isOggContainer(bytes), `${bytes.length} bytes`)
  check('declares an OpusHead stream', isOpusStream(bytes))
  check(
    'ffprobe agrees: ogg container + opus codec',
    info.format_name === 'ogg' && info.codec_name === 'opus',
    `format=${info.format_name} codec=${info.codec_name} rate=${info.sample_rate} ch=${info.channels} dur=${info.duration}s`
  )
  check(
    'satisfies the Telegram sendVoice contract (Ogg-Opus, mono)',
    info.format_name === 'ogg' && info.codec_name === 'opus' && info.channels === '1'
  )

  if (chatId && !skipSend && TELEGRAM_BOT_TOKEN) {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('voice', new Blob([bytes], { type: 'audio/ogg' }), 'reply.ogg')
    form.append('caption', '🎤 xAI voice — sendVoice check')

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`, {
      method: 'POST',
      body: form,
    })
    const json = await res.json()
    if (!json.ok && String(json.description).includes('chat not found')) {
      console.log(
        '• sendVoice inconclusive: chat unreachable. Message the bot, then read getUpdates.'
      )
    } else {
      check(
        'Telegram accepted it as a voice note',
        json.ok === true,
        json.ok
          ? `message_id=${json.result?.message_id} duration=${json.result?.voice?.duration}s mime=${json.result?.voice?.mime_type}`
          : JSON.stringify(json).slice(0, 200)
      )
    }
  } else {
    console.log('• sendVoice step skipped (no reachable chat id supplied)')
  }
}

rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true })
console.log(failures === 0 ? '\nTELEGRAM_VOICE_OK' : `\nTELEGRAM_VOICE_FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
