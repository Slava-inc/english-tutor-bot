// Live TTS verification against the xAI Voice API.
//
//   node scripts/verify-tts.mjs [--voice leo] [--all-voices] [--keep]
//
// Checks everything the tutor depends on (§4, §3.2):
//   1. the endpoint authenticates and returns audio
//   2. the configured codec yields a Telegram-playable container
//      (Ogg-Opus: "OggS" page header + "OpusHead" stream header)
//   3. the cached file is what we claim it is (ffprobe format/codec)
//   4. the audio is intelligible: round-tripped through the local whisper-proxy
//   5. failure modes: bad codec / bad sample rate are rejected before the call
//
// Exits non-zero on any failure so it can gate a deploy.
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'

const PROJECT = path.resolve(import.meta.dirname, '..')
process.chdir(PROJECT)
process.env.TTS_CACHE_DIR = mkdtempSync(path.join(tmpdir(), 'tts-verify-cache-'))

const {
  synthesizeXai,
  textToSpeech,
  cleanSpokenText,
  isOggContainer,
  isOpusStream,
  SUPPORTED_CODECS,
  SUPPORTED_SAMPLE_RATES,
  BRITISH_VOICES,
} = await import(path.join(PROJECT, 'dist/speech.js'))
const { TTS_PROVIDER, TTS_CODEC, TTS_XAI_VOICE, TTS_LANGUAGE, XAI_API_KEY } = await import(
  path.join(PROJECT, 'dist/config.js')
)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

// --- CLI args ---------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}
const wantAllVoices = flag('--all-voices')
const keep = flag('--keep')
const requestedVoice = value('--voice', TTS_XAI_VOICE)

console.log('--- configuration ---')
console.log(`provider    : ${TTS_PROVIDER}`)
console.log(`voice       : ${requestedVoice}`)
console.log(`language    : ${TTS_LANGUAGE}`)
console.log(`codec       : ${TTS_CODEC}`)
console.log(`api key     : ${XAI_API_KEY ? XAI_API_KEY.slice(0, 8) + '…' : '(missing)'}`)
console.log('')

/** Probe a file with ffprobe and return the parsed format/codec info. */
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

/** Write bytes to a temp file for ffprobe and return its path. */
function materialize(bytes, name) {
  const p = path.join(process.env.TTS_CACHE_DIR, name)
  const b64 = Buffer.from(bytes).toString('base64')
  execFileSync(
    'node',
    [
      '-e',
      "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2],'base64'))",
      p,
      b64,
    ],
    { stdio: 'ignore' }
  )
  return p
}

// --- 1. credentials ---------------------------------------------------------
check('XAI_API_KEY is configured', Boolean(XAI_API_KEY))

// --- 2. the tutor's own entry point (cache + provider routing) -------------
const SENTENCE = 'I went to the garage last Saturday and my schedule was absolutely full.'
const audioPath = await textToSpeech(SENTENCE, { voice: requestedVoice })
check('textToSpeech() produced a file', Boolean(audioPath), audioPath ?? 'null returned')

if (audioPath) {
  check('cached file exists on disk', existsSync(audioPath))
  const buf = readFileSync(audioPath)
  check('audio is non-trivial in size', buf.length > 1000, `${buf.length} bytes`)

  const info = probe(audioPath)
  check(
    'ffprobe reads it as Ogg-Opus (Telegram voice contract)',
    info.format_name === 'ogg' && info.codec_name === 'opus',
    `format=${info.format_name} codec=${info.codec_name} rate=${info.sample_rate} ch=${info.channels}`
  )
  check('container starts with the "OggS" page header', isOggContainer(buf))
  check('stream declares an "OpusHead" header', isOpusStream(buf))

  // --- 3. cache hit (second call must not re-synthesize) -------------------
  const again = await textToSpeech(SENTENCE, { voice: requestedVoice })
  check('second call returns the cached path', again === audioPath)
}

// --- 4. text sanitising -----------------------------------------------------
// Markers stripped, the parenthetical stage direction dropped, emphasis removed.
const cleaned = cleanSpokenText('🎤 Hello there! ✅ Fix: a → b (You could say: hi) *bold*')
check(
  'markers and stage directions are stripped before synthesis',
  cleaned === 'Hello there! Fix: a → b bold',
  JSON.stringify(cleaned)
)
check(
  'a bare stage direction leaves no trailing artefact',
  cleanSpokenText('🎤 Hi! (You could say: how are you?)') === 'Hi!',
  JSON.stringify(cleanSpokenText('🎤 Hi! (You could say: how are you?)'))
)
check(
  'whitespace-only input yields no audio',
  (await textToSpeech('🎤 ✅ 📝')) === null
)

// --- 5. speed control ------------------------------------------------------
const slow = await synthesizeXai(SENTENCE, { voice: requestedVoice, speed: 0.8 })
const fast = await synthesizeXai(SENTENCE, { voice: requestedVoice, speed: 1.4 })
check('speed=0.8 accepted', slow.audio.length > 0, `${slow.audio.length} bytes`)
check('speed=1.4 accepted', fast.audio.length > 0, `${fast.audio.length} bytes`)

// --- 6. authoritative enum values -----------------------------------------
console.log('')
console.log(`codecs      : ${SUPPORTED_CODECS.join(', ')}`)
console.log(`sample rates: ${SUPPORTED_SAMPLE_RATES.join(', ')}`)
console.log(`uk voices   : ${BRITISH_VOICES.join(', ')}`)

// --- 7. round-trip through whisper (intelligibility) -----------------------
const roundTripPath = audioPath
if (roundTripPath) {
  const WHISPER = process.env.WHISPER_URL || 'http://127.0.0.1:3011/v1/audio/transcriptions'
  try {
    const boundary = '----ttsverify' + Date.now().toString(16)
    const enc = new TextEncoder()
    const parts = []
    const push = (s) => parts.push(enc.encode(s))
    const buf = new Uint8Array(readFileSync(roundTripPath))
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="file"; filename="say.ogg"\r\n`)
    push('Content-Type: audio/ogg\r\n\r\n')
    parts.push(buf)
    push('\r\n')
    for (const [k, v] of Object.entries({
      model: 'small',
      language: 'en',
      response_format: 'verbose_json',
    })) {
      push(`--${boundary}\r\n`)
      push(`Content-Disposition: form-data; name="${k}"\r\n\r\n`)
      push(`${v}\r\n`)
    }
    push(`--${boundary}--\r\n`)
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let off = 0
    for (const p of parts) {
      body.set(p, off)
      off += p.length
    }

    const res = await fetch(WHISPER, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
      signal: AbortSignal.timeout(300000),
    })
    const json = await res.json()
    const heard = (json.text || '').trim()
    const words = SENTENCE.toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z]/g, ''))
      .filter((w) => w.length > 3)
    const heardLower = heard.toLowerCase()
    const matched = words.filter((w) => heardLower.includes(w))
    const ratio = words.length ? matched.length / words.length : 0
    const logprob = json.segments?.[0]?.avg_logprob

    check('whisper transcribes the xAI audio', heard.length > 0, `heard: "${heard}"`)
    check(
      'transcript matches the source (>=80% of content words)',
      ratio >= 0.8,
      `${Math.round(ratio * 100)}% of content words`
    )
    if (typeof logprob === 'number') {
      check(
        'recognition confidence is healthy (> -0.5)',
        logprob > -0.5,
        `avg_logprob=${logprob.toFixed(3)}`
      )
    }
  } catch (e) {
    check('whisper round-trip', false, String(e).slice(0, 140))
  }
}

// --- 8. all British voices (on demand) -------------------------------------
if (wantAllVoices) {
  console.log('')
  console.log('--- british voices ---')
  for (const v of BRITISH_VOICES) {
    try {
      const r = await synthesizeXai('Lovely to meet you. Shall we begin?', { voice: v })
      const info = probe(materialize(r.audio, `${v}-sample.ogg`))
      check(
        `voice "${v}" synthesizes Ogg-Opus`,
        isOpusStream(r.audio),
        `${r.audio.length} bytes, ${info.codec_name}/${info.format_name}`
      )
    } catch (e) {
      check(`voice "${v}"`, false, String(e).slice(0, 120))
    }
  }
}

// --- 9. error handling ------------------------------------------------------
let rejectedBadCodec = false
try {
  await synthesizeXai('test', { codec: 'ogg' })
} catch {
  rejectedBadCodec = true
}
check('unsupported codec "ogg" is rejected locally', rejectedBadCodec)

let rejectedBadRate = false
try {
  await synthesizeXai('test', { sampleRate: 12345 })
} catch {
  rejectedBadRate = true
}
check('unsupported sample_rate is rejected locally', rejectedBadRate)

// --- cleanup ----------------------------------------------------------------
if (!keep) rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true })
else console.log(`\nartifacts kept in ${process.env.TTS_CACHE_DIR}`)

console.log(failures === 0 ? '\nTTS_VERIFY_OK' : `\nTTS_VERIFY_FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

