import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tutor-tts-'))
  process.env.TTS_CACHE_DIR = path.join(dir, 'cache')
  process.env.TTS_PROVIDER = 'xai'
  process.env.TTS_XAI_VOICE = 'leo'
  process.env.TTS_LANGUAGE = 'en-GB'
  process.env.TTS_CODEC = 'opus'
  process.env.TTS_SAMPLE_RATE = '24000'
  process.env.TTS_SPEED = '0.95'
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.XAI_TTS_URL = 'https://api.x.ai/v1/tts'
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** A minimal but structurally valid Ogg-Opus payload (OggS + OpusHead). */
function fakeOggOpus(size = 2048): Buffer {
  const buf = Buffer.alloc(size, 0x11)
  buf.write('OggS', 0, 'latin1')
  buf.write('OpusHead', 28, 'latin1')
  return buf
}

/** Stub global fetch with a scripted response. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => handler(String(url), init))
  )
}

function audioResponse(bytes: Buffer, contentType = 'audio/opus'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

describe('speech: xAI provider (§4)', () => {
  it('sends the verified request shape and writes an Ogg-Opus file', async () => {
    const SPEECH = await import('../src/speech.js')
    const ogg = fakeOggOpus()
    let seenBody: Record<string, unknown> | null = null
    let seenUrl = ''
    let seenAuth = ''

    stubFetch((url, init) => {
      seenUrl = url
      seenAuth = String((init.headers as Record<string, string>).Authorization)
      seenBody = JSON.parse(String(init.body))
      return audioResponse(ogg)
    })

    const file = await SPEECH.textToSpeech('Hello there, lovely to meet you.')
    expect(file).toBeTruthy()
    expect(file!.endsWith('.ogg')).toBe(true)
    expect(existsSync(file!)).toBe(true)
    expect(readFileSync(file!)).toEqual(ogg)

    expect(seenUrl).toBe('https://api.x.ai/v1/tts')
    expect(seenAuth).toBe('Bearer xai-test-key')

    // Body shape verified live against api.x.ai
    expect(seenBody).toMatchObject({
      text: 'Hello there, lovely to meet you.',
      voice_id: 'leo',
      language: 'en-GB',
      speed: 0.95,
      output_format: { codec: 'opus', sample_rate: 24000 },
    })
  })

  it('reuses the disk cache instead of calling the API twice', async () => {
    const SPEECH = await import('../src/speech.js')
    let calls = 0
    stubFetch(() => {
      calls++
      return audioResponse(fakeOggOpus())
    })

    const first = await SPEECH.textToSpeech('Cache me please.')
    const second = await SPEECH.textToSpeech('Cache me please.')
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('keys the cache by voice, so different voices do not collide', async () => {
    const SPEECH = await import('../src/speech.js')
    let calls = 0
    stubFetch(() => {
      calls++
      return audioResponse(fakeOggOpus())
    })

    const leo = await SPEECH.textToSpeech('Same words.', { voice: 'leo' })
    const rex = await SPEECH.textToSpeech('Same words.', { voice: 'rex' })
    expect(leo).not.toBe(rex)
    expect(calls).toBe(2)
  })

  it('strips markers and stage directions before synthesis', async () => {
    const SPEECH = await import('../src/speech.js')
    let sent = ''
    stubFetch((_url, init) => {
      sent = JSON.parse(String(init.body)).text
      return audioResponse(fakeOggOpus())
    })

    await SPEECH.textToSpeech('🎤 Hello! (You could say: hi there) ✅ Fix: a → b')
    expect(sent).toBe('Hello! Fix: a → b')
    expect(sent).not.toContain('🎤')
    expect(sent).not.toContain('You could say')
  })

  it('returns null for empty or marker-only text without calling the API', async () => {
    const SPEECH = await import('../src/speech.js')
    let calls = 0
    stubFetch(() => {
      calls++
      return audioResponse(fakeOggOpus())
    })

    expect(await SPEECH.textToSpeech('')).toBeNull()
    expect(await SPEECH.textToSpeech('   ')).toBeNull()
    expect(await SPEECH.textToSpeech('🎤 ✅ 📝 🔊')).toBeNull()
    expect(calls).toBe(0)
  })
})


  it('falls back to null on an HTTP error so the caller can send text (§3.2)', async () => {
    const SPEECH = await import('../src/speech.js')
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'Incorrect API key provided.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
    )

    expect(await SPEECH.textToSpeech('This will fail.')).toBeNull()
  })

  it('falls back to null on a network/timeout error', async () => {
    const SPEECH = await import('../src/speech.js')
    stubFetch(() => {
      throw new Error('fetch failed: ETIMEDOUT')
    })
    expect(await SPEECH.textToSpeech('Network down.')).toBeNull()
  })

  it('falls back to null when the API returns empty audio', async () => {
    const SPEECH = await import('../src/speech.js')
    stubFetch(() => audioResponse(Buffer.alloc(0)))
    expect(await SPEECH.textToSpeech('Silence please.')).toBeNull()
  })

  it('rejects an unsupported codec before making a request', async () => {
    const SPEECH = await import('../src/speech.js')
    let calls = 0
    stubFetch(() => {
      calls++
      return audioResponse(fakeOggOpus())
    })

    await expect(SPEECH.synthesizeXai('test', { codec: 'ogg' as never })).rejects.toThrow(
      /unsupported codec/
    )
    expect(calls).toBe(0)
  })

  it('rejects an unsupported sample rate before making a request', async () => {
    const SPEECH = await import('../src/speech.js')
    await expect(SPEECH.synthesizeXai('test', { sampleRate: 12345 })).rejects.toThrow(
      /unsupported sample_rate/
    )
  })

  it('honours a custom voice, speed and codec per call', async () => {
    const SPEECH = await import('../src/speech.js')
    let body: Record<string, unknown> = {}
    stubFetch((_url, init) => {
      body = JSON.parse(String(init.body))
      return audioResponse(fakeOggOpus())
    })

    await SPEECH.textToSpeech('Tuning please.', { voice: 'rex', speed: 1.2, codec: 'mp3' })
    expect(body.voice_id).toBe('rex')
    expect(body.speed).toBe(1.2)
    expect(body.output_format).toMatchObject({ codec: 'mp3' })
  })

describe('speech: payload guards', () => {
  it('detects Ogg containers and Opus streams', async () => {
    const SPEECH = await import('../src/speech.js')
    const opus = fakeOggOpus()
    expect(SPEECH.isOggContainer(opus)).toBe(true)
    expect(SPEECH.isOpusStream(opus)).toBe(true)

    const notOgg = Buffer.from('ID3\x03\x00\x00\x00mp3data')
    expect(SPEECH.isOggContainer(notOgg)).toBe(false)
    expect(SPEECH.isOpusStream(notOgg)).toBe(false)

    // Ogg container but a non-Opus codec (e.g. Vorbis).
    const vorbis = Buffer.alloc(512, 0x22)
    vorbis.write('OggS', 0, 'latin1')
    vorbis.write('\x01vorbis', 28, 'latin1')
    expect(SPEECH.isOggContainer(vorbis)).toBe(true)
    expect(SPEECH.isOpusStream(vorbis)).toBe(false)
  })

  it('handles short buffers without throwing', async () => {
    const SPEECH = await import('../src/speech.js')
    for (const b of [Buffer.alloc(0), Buffer.from('Ogg'), Buffer.from([0x4f])]) {
      expect(() => SPEECH.isOggContainer(b)).not.toThrow()
      expect(SPEECH.isOggContainer(b)).toBe(false)
    }
  })

  it('maps codecs to sensible file extensions', async () => {
    const SPEECH = await import('../src/speech.js')
    expect(SPEECH.extensionFor('opus')).toBe('ogg')
    expect(SPEECH.extensionFor('mp3')).toBe('mp3')
    expect(SPEECH.extensionFor('wav')).toBe('wav')
    expect(SPEECH.extensionFor('ulaw')).toBe('ulaw')
    expect(SPEECH.extensionFor('mulaw')).toBe('ulaw')
  })

  it('exposes the enum values verified against the live API', async () => {
    const SPEECH = await import('../src/speech.js')
    expect([...SPEECH.SUPPORTED_CODECS]).toEqual([
      'mp3',
      'wav',
      'pcm',
      'opus',
      'mulaw',
      'ulaw',
      'alaw',
    ])
    expect([...SPEECH.SUPPORTED_SAMPLE_RATES]).toEqual([8000, 16000, 22050, 24000, 44100, 48000])
    expect([...SPEECH.BRITISH_VOICES]).toEqual(['leo', 'rex', 'eve'])
    // `ogg` is NOT a codec — the API rejects it with 422.
    expect(SPEECH.SUPPORTED_CODECS).not.toContain('ogg')
  })

  it('selects the provider voice unless overridden', async () => {
    const SPEECH = await import('../src/speech.js')
    expect(SPEECH.activeVoice()).toBe('leo')
    expect(SPEECH.activeVoice('rex')).toBe('rex')
  })
})

describe('speech: text cleaning', () => {
  it('removes markers, stage directions and emphasis', async () => {
    const SPEECH = await import('../src/speech.js')
    expect(SPEECH.cleanSpokenText('🎤 Hello! ✅ Fix: a → b')).toBe('Hello! Fix: a → b')
    expect(SPEECH.cleanSpokenText('🎤 Hi! (You could say: how are you?)')).toBe('Hi!')
    expect(SPEECH.cleanSpokenText('**bold** and __under__ and `code`')).toBe(
      'bold and under and code'
    )
    expect(SPEECH.cleanSpokenText('🗣 Next: What did you see?')).toBe('Next: What did you see?')
  })

  it('collapses whitespace and trims', async () => {
    const SPEECH = await import('../src/speech.js')
    expect(SPEECH.cleanSpokenText('  hello   \n\n  world  ')).toBe('hello world')
    expect(SPEECH.cleanSpokenText('🎤   ')).toBe('')
  })
})
