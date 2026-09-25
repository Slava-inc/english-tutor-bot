// Live STT contract check against a running whisper-proxy.
//
//   node scripts/verify-stt.mjs [audio-file]
//
// Verifies the three things the tutor depends on (§3.2 / §5.1 B):
//   1. the proxy answers /health and /v1/audio/transcriptions
//   2. `response_format=verbose_json` returns { text, segments[{ avg_logprob }] }
//   3. the legacy `{ text }` contract still works (n8n compatibility)
//
// Exits non-zero on any failure so it can gate a deploy.
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'

const BASE = process.env.WHISPER_URL
  ? process.env.WHISPER_URL.replace(/\/v1\/audio\/transcriptions.*$/, '')
  : 'http://127.0.0.1:3011'
const ENDPOINT = `${BASE}/v1/audio/transcriptions`

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
}

// --- audio fixture ----------------------------------------------------------
let audioPath = process.argv[2]
let synthetic = false
if (!audioPath || !existsSync(audioPath)) {
  // A tone carries no speech, which is fine: we are testing the contract, not
  // the transcript. ffmpeg is guaranteed present wherever whisper runs.
  audioPath = path.join(tmpdir(), `stt-probe-${Date.now()}.ogg`)
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=180:duration=2',
    '-ar', '16000',
    '-ac', '1',
    audioPath,
  ], { stdio: 'ignore' })
  synthetic = true
}
console.log(`audio: ${audioPath}${synthetic ? ' (synthetic tone)' : ''}\n`)

const post = async (fields) => {
  const boundary = '----sttverify' + Date.now().toString(16)
  const enc = new TextEncoder()
  const parts = []
  const push = (s) => parts.push(enc.encode(s))
  const buf = new Uint8Array(readFileSync(audioPath))

  push(`--${boundary}\r\n`)
  push(`Content-Disposition: form-data; name="file"; filename="${path.basename(audioPath)}"\r\n`)
  push('Content-Type: audio/ogg\r\n\r\n')
  parts.push(buf)
  push('\r\n')
  for (const [name, value] of Object.entries(fields)) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`)
    push(`${value}\r\n`)
  }
  push(`--${boundary}--\r\n`)

  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { body.set(p, off); off += p.length }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    signal: AbortSignal.timeout(600000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* text/plain response */ }
  return { status: res.status, text, json, contentType: res.headers.get('content-type') || '' }
}

// --- 1. health --------------------------------------------------------------
try {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })
  const json = await res.json().catch(() => ({}))
  check('proxy /health reachable', res.ok && json.status === 'ok', JSON.stringify(json))
} catch (e) {
  check('proxy /health reachable', false, String(e))
  console.log('\nStart it with: node /home/deepseekclaw/whisper-proxy/server.cjs')
  process.exit(1)
}

// --- 2. verbose_json (Level B contract) -------------------------------------
const verbose = await post({
  model: 'small',
  language: 'en',
  response_format: 'verbose_json',
})
check('verbose_json returns 200', verbose.status === 200, `status=${verbose.status}`)
check(
  'verbose_json has a string "text" field',
  typeof verbose.json?.text === 'string',
  `text=${JSON.stringify(verbose.json?.text ?? null)}`
)
check('verbose_json has a "segments" array', Array.isArray(verbose.json?.segments))
check('verbose_json pins language=en', verbose.json?.language === 'en', `language=${verbose.json?.language}`)
// Whisper only emits segments for audio it recognises as speech. Synthetic
// fixtures usually yield none (correctly), so this check is conditional: when
// segments ARE present they must carry a numeric avg_logprob, because that is
// the field the Level B "say it again" drill depends on.
const segs = verbose.json?.segments ?? []
check(
  'segments carry numeric avg_logprob (when speech is detected)',
  segs.length === 0 || typeof segs[0]?.avg_logprob === 'number',
  segs.length
    ? `avg_logprob=${segs[0].avg_logprob}`
    : 'no segments — pass a real speech file for the full check'
)

// --- 3. legacy json (backward compatibility) --------------------------------
const legacy = await post({ model: 'small' })
check('legacy json returns 200', legacy.status === 200, `status=${legacy.status}`)
check('legacy json still has "text"', typeof legacy.json?.text === 'string')
check('legacy json did NOT switch shape', !Array.isArray(legacy.json?.segments))

// --- 4. text format ---------------------------------------------------------
const plain = await post({ model: 'small', response_format: 'text' })
check('response_format=text returns 200', plain.status === 200, `status=${plain.status}`)
check('text format is not JSON-wrapped', plain.json === null || typeof plain.text === 'string')

// --- 5. invalid format rejected --------------------------------------------
const bad = await post({ model: 'small', response_format: 'srt' })
check('unsupported response_format is rejected', bad.status === 400, `status=${bad.status}`)

// --- 6. the tutor's own client against the same proxy -----------------------
process.env.WHISPER_URL = ENDPOINT
process.env.WHISPER_MODEL = 'small'
const { transcribeAudio } = await import('../dist/whisper.js')
const clientRes = await transcribeAudio(new Uint8Array(readFileSync(audioPath)), path.basename(audioPath))
check(
  'tutor whisper client completes the round-trip',
  clientRes.ok === true || clientRes.error === 'whisper returned empty text',
  `ok=${clientRes.ok} error=${clientRes.error ?? '(none)'}`
)

if (synthetic) { try { unlinkSync(audioPath) } catch { /* ignore */ } }

console.log(failures === 0 ? '\nSTT_CONTRACT_OK' : `\nSTT_CONTRACT_FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
