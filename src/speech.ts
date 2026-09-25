// ============================================================================
// Text-to-speech (§4, §3.2)
//
// Prototype: xAI Voice (`POST https://api.x.ai/v1/tts`) replaces Google Cloud
// TTS. Two properties make this a near drop-in replacement:
//
//   1. `output_format.codec = "opus"` returns a real Ogg-Opus container
//      (verified live: OggS / OpusHead, ffprobe `format_name=ogg`), which is
//      exactly what Telegram voice notes accept — no ffmpeg transcoding needed.
//   2. The endpoint returns raw audio bytes, so the response is written straight
//      into the existing sha256 disk cache.
//
// The Google provider is kept behind the same interface so `TTS_PROVIDER=google`
// remains a one-variable rollback.
// ============================================================================

import { mkdirSync, existsSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import {
  XAI_API_KEY,
  XAI_TTS_URL,
  XAI_TTS_TIMEOUT_MS,
  TTS_PROVIDER,
  TTS_LANGUAGE,
  TTS_XAI_VOICE,
  TTS_VOICE,
  TTS_SPEED,
  TTS_CODEC,
  TTS_SAMPLE_RATE,
  TTS_CACHE_DIR,
  TTS_CACHE_TTL_MS,
} from './config.js'
import { logger } from './logger.js'

/** Codecs the xAI endpoint accepts (learned from its own 422 error message). */
export const SUPPORTED_CODECS = ['mp3', 'wav', 'pcm', 'opus', 'mulaw', 'ulaw', 'alaw'] as const
export type Codec = (typeof SUPPORTED_CODECS)[number]

/** Sample rates the xAI endpoint accepts. */
export const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const

/** British (en-GB) built-in voices, from the xAI voice catalogue. */
export const BRITISH_VOICES = ['leo', 'rex', 'eve'] as const

export interface SpeakOptions {
  /** Provider-specific voice id; defaults to the configured voice. */
  voice?: string
  /** Speech speed multiplier; 1.0 is normal. */
  speed?: number
  /** Output codec (xAI provider only). */
  codec?: Codec
  /** Output sample rate in Hz (xAI provider only). */
  sampleRate?: number
}

const MARKER_RE = /🎤|✅|📝|🎯|🔊|🗣|🃏|🔇/g

/**
 * Strip everything that must not be spoken: markers, emoji and markdown-ish
 * decoration. Stage directions in parentheses are also removed so the learner
 * never hears "(You could say: ...)" read out loud in scenario mode.
 */
export function cleanSpokenText(text: string): string {
  return text
    .replace(MARKER_RE, ' ')
    .replace(/\((?:You could say|say)[^)]*\)/gi, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** File extension for a codec, so the cache holds a self-describing file. */
export function extensionFor(codec: Codec): string {
  if (codec === 'opus') return 'ogg' // Ogg-Opus container
  if (codec === 'ulaw' || codec === 'mulaw') return 'ulaw'
  return codec
}

function cachePathFor(text: string, voice: string, ext = 'ogg'): string {
  const hash = createHash('sha256').update(`${voice}|${text}`).digest('hex')
  return path.join(TTS_CACHE_DIR, `${hash}.${ext}`)
}

function isFresh(p: string): boolean {
  if (!existsSync(p)) return false
  try {
    return Date.now() - statSync(p).mtimeMs < TTS_CACHE_TTL_MS
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// xAI provider
// ---------------------------------------------------------------------------

/**
 * Synthesize speech through xAI and return the raw audio bytes.
 * Throws on transport/HTTP errors so the caller can fall back to text.
 */
export async function synthesizeXai(
  text: string,
  opts: SpeakOptions = {}
): Promise<{ audio: Buffer; codec: Codec; contentType: string }> {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY is not configured')

  const codec = (opts.codec ?? (TTS_CODEC as Codec)) as Codec
  if (!SUPPORTED_CODECS.includes(codec)) {
    throw new Error(`unsupported codec "${codec}" (allowed: ${SUPPORTED_CODECS.join(', ')})`)
  }
  const sampleRate = opts.sampleRate ?? TTS_SAMPLE_RATE
  if (!SUPPORTED_SAMPLE_RATES.includes(sampleRate as (typeof SUPPORTED_SAMPLE_RATES)[number])) {
    throw new Error(
      `unsupported sample_rate ${sampleRate} (allowed: ${SUPPORTED_SAMPLE_RATES.join(', ')})`
    )
  }

  const res = await fetch(XAI_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice_id: opts.voice ?? TTS_XAI_VOICE,
      language: TTS_LANGUAGE,
      speed: opts.speed ?? TTS_SPEED,
      output_format: { codec, sample_rate: sampleRate },
    }),
    signal: AbortSignal.timeout(XAI_TTS_TIMEOUT_MS),
  })

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`xAI TTS http ${res.status}${detail ? ': ' + detail : ''}`)
  }

  const audio = Buffer.from(await res.arrayBuffer())
  if (audio.length === 0) throw new Error('xAI TTS returned empty audio')
  return { audio, codec, contentType: res.headers.get('content-type') ?? '' }
}

/** True when the bytes start with an Ogg page header ("OggS"). */
export function isOggContainer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS'
}

/** True when an Ogg buffer carries an Opus stream ("OpusHead"). */
export function isOpusStream(buf: Buffer): boolean {
  return isOggContainer(buf) && buf.includes(Buffer.from('OpusHead', 'latin1'))
}


// ---------------------------------------------------------------------------
// Google provider (legacy — kept for TTS_PROVIDER=google rollback)
// ---------------------------------------------------------------------------

type GoogleTtsClient = {
  synthesizeSpeech(request: {
    input: { text: string }
    voice: { languageCode: string; name: string }
    audioConfig: { audioEncoding: string; speakingRate?: number }
  }): Promise<unknown>
}

let googleClientPromise: Promise<GoogleTtsClient> | null = null

async function loadGoogleClient(): Promise<GoogleTtsClient> {
  const { GOOGLE_APPLICATION_CREDENTIALS, TTS_ENDPOINT } = await import('./config.js')
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = GOOGLE_APPLICATION_CREDENTIALS
  }
  void TTS_ENDPOINT
  const mod = await import('@google-cloud/text-to-speech')
  const Ctor =
    (mod as unknown as { TextToSpeechClient?: new () => GoogleTtsClient }).TextToSpeechClient ??
    (mod as unknown as { default?: new () => GoogleTtsClient }).default
  if (!Ctor) throw new Error('@google-cloud/text-to-speech client unavailable')
  return new Ctor()
}

function ensureGoogleClient(): Promise<GoogleTtsClient> {
  if (!googleClientPromise) {
    googleClientPromise = loadGoogleClient().catch((e) => {
      googleClientPromise = null
      throw e
    })
  }
  return googleClientPromise
}

async function synthesizeGoogle(text: string, voice: string): Promise<Buffer> {
  const client = await ensureGoogleClient()
  const raw = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'en-GB', name: voice },
    audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate: TTS_SPEED },
  })
  const payload = (Array.isArray(raw) ? raw[0] : raw) as { audioContent?: unknown } | undefined
  const content = payload?.audioContent
  if (!content) throw new Error('Google TTS returned no audio content')
  return typeof content === 'string'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content as Uint8Array)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Voice id used by the active provider. */
export function activeVoice(override?: string): string {
  if (override) return override
  return TTS_PROVIDER === 'google' ? TTS_VOICE : TTS_XAI_VOICE
}

/**
 * Convert text to speech (British English) and return the cached file path.
 *
 * Uses a disk cache keyed by `sha256(voice | text)`. Returns `null` when audio
 * could not be produced, which makes the caller fall back to a text-only reply
 * with the 🔇 note (§3.2).
 */
export async function textToSpeech(text: string, opts: SpeakOptions = {}): Promise<string | null> {
  const spoken = cleanSpokenText(text)
  if (!spoken) return null

  const voice = activeVoice(opts.voice)
  const codec = (opts.codec ?? (TTS_CODEC as Codec)) as Codec
  const ext = TTS_PROVIDER === 'google' ? 'ogg' : extensionFor(codec)

  const cachePath = cachePathFor(spoken, `${TTS_PROVIDER}:${voice}:${codec}`, ext)
  if (isFresh(cachePath)) return cachePath

  try {
    mkdirSync(TTS_CACHE_DIR, { recursive: true })
    const audio =
      TTS_PROVIDER === 'google'
        ? await synthesizeGoogle(spoken, voice)
        : (await synthesizeXai(spoken, { ...opts, codec })).audio

    // Guard the Telegram contract: Ogg-Opus must really be Ogg-Opus.
    if (ext === 'ogg' && TTS_PROVIDER === 'xai' && codec === 'opus' && !isOpusStream(audio)) {
      logger.warn({ bytes: audio.length }, 'xAI opus payload is not an Ogg-Opus stream')
    }

    writeFileSync(cachePath, audio)
    logger.info(
      { provider: TTS_PROVIDER, voice, codec, bytes: audio.length },
      'TTS synthesized'
    )
    return cachePath
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn({ error: msg, provider: TTS_PROVIDER }, 'TTS synthesis failed')
    return null
  }
}

/** Exposed for tests: clears the memoised Google client. */
export function resetTtsClient(): void {
  googleClientPromise = null
}

