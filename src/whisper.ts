import { readFileSync } from 'fs'
import { WHISPER_URL, WHISPER_MODEL, WHISPER_TIMEOUT_MS } from './config.js'
import { logger } from './logger.js'

export interface WhisperSegment {
  text: string
  avg_logprob?: number
}

export interface WhisperResult {
  text: string
  ok: boolean
  error?: string
  /** Mean segment confidence reported by faster-whisper (null = not provided). */
  avgLogprob?: number
  /** Per-segment detail, when the proxy supports it (Level B, §5.1). */
  segments?: WhisperSegment[]
}

/**
 * Send an OGG/MP3 audio buffer to the local whisper-proxy (OpenAI-compatible
 * /v1/audio/transcriptions multipart endpoint) and return the recognized text.
 *
 * We deliberately build our own multipart body instead of relying on
 * undici's FormData because the proxy runs on plain HTTP and the shape must
 * match its parser (fields: `file`, `model`, `language`).
 */
export async function transcribeAudio(audio: Uint8Array, filename = 'voice.ogg'): Promise<WhisperResult> {
  const boundary = '----tutor' + Math.random().toString(16).slice(2) + Date.now().toString(16)

  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []

  const push = (s: string): void => {
    parts.push(encoder.encode(s))
  }

  // file field
  push(`--${boundary}\r\n`)
  push(
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
  )
  push('Content-Type: audio/ogg\r\n\r\n')
  parts.push(new Uint8Array(audio))
  push('\r\n')

  // model field
  push(`--${boundary}\r\n`)
  push('Content-Disposition: form-data; name="model"\r\n\r\n')
  push(`${WHISPER_MODEL}\r\n`)

  // language field — English practice, so always pin the language (§3.2 item 1)
  push(`--${boundary}\r\n`)
  push('Content-Disposition: form-data; name="language"\r\n\r\n')
  push('en\r\n')

  // ask the proxy for segment confidence when it supports it (Level B, §5.1)
  push(`--${boundary}\r\n`)
  push('Content-Disposition: form-data; name="response_format"\r\n\r\n')
  push('verbose_json\r\n')

  // close
  push(`--${boundary}--\r\n`)

  const body = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0))
  let offset = 0
  for (const p of parts) {
    body.set(p, offset)
    offset += p.length
  }

  try {
    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    })

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 500)
      logger.warn({ status: res.status, errText }, 'whisper proxy http error')
      return { text: '', ok: false, error: `whisper http ${res.status}` }
    }

    const raw = (await res.text()).trim()
    const parsed = parseWhisperPayload(raw)
    if (!parsed.text) {
      return { text: '', ok: false, error: 'whisper returned empty text' }
    }
    return parsed
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn({ error: msg }, 'whisper proxy request failed')
    return { text: '', ok: false, error: msg }
  }
}

/**
 * Accept both the legacy `{text}` reply and an OpenAI-style verbose_json reply
 * with per-segment `avg_logprob` values.
 */
export function parseWhisperPayload(raw: string): WhisperResult {
  if (!raw) return { text: '', ok: false, error: 'empty payload' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // The proxy may answer with plain text (older builds).
    return { text: raw, ok: true }
  }
  if (typeof data === 'string') return { text: data.trim(), ok: true }

  const obj = data as {
    text?: unknown
    segments?: unknown
  }
  const text = typeof obj?.text === 'string' ? obj.text.trim() : ''
  const rawSegments = Array.isArray(obj?.segments) ? obj.segments : []
  const segments: WhisperSegment[] = rawSegments
    .filter((s): s is { text?: unknown; avg_logprob?: unknown } => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      text: typeof s.text === 'string' ? s.text.trim() : '',
      avg_logprob:
        typeof s.avg_logprob === 'number' && Number.isFinite(s.avg_logprob)
          ? s.avg_logprob
          : undefined,
    }))
    .filter((s) => s.text.length > 0)

  const scored = segments.filter((s) => typeof s.avg_logprob === 'number')
  const avgLogprob = scored.length
    ? scored.reduce((sum, s) => sum + (s.avg_logprob ?? 0), 0) / scored.length
    : undefined

  return {
    text,
    ok: text.length > 0,
    avgLogprob,
    segments: segments.length ? segments : undefined,
  }
}

// Small helper used by tests / dev to download local file as buffer.
export function readAudioFile(filePath: string): Uint8Array {
  return new Uint8Array(readFileSync(filePath))
}
