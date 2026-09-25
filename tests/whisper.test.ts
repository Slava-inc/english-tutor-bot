import { describe, it, expect } from 'vitest'
import { parseWhisperPayload } from '../src/whisper.js'
import { sanitizeForHistory, parseTutorResponse, hasAnyMarker } from '../src/response.js'
import {
  lowConfidenceWords,
  LOW_CONFIDENCE_LOGPROB,
} from '../src/processes/pronunciation.js'

describe('whisper payload parsing (§3.2, §5.1 B)', () => {
  it('reads the legacy {text} shape', () => {
    const r = parseWhisperPayload(JSON.stringify({ text: 'I went to London.' }))
    expect(r.ok).toBe(true)
    expect(r.text).toBe('I went to London.')
    expect(r.avgLogprob).toBeUndefined()
  })

  it('reads verbose_json with per-segment avg_logprob', () => {
    const raw = JSON.stringify({
      text: 'I went to the garage.',
      segments: [
        { text: ' I went to the', avg_logprob: -0.15 },
        { text: ' garage.', avg_logprob: -0.85 },
      ],
    })
    const r = parseWhisperPayload(raw)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('I went to the garage.')
    expect(r.avgLogprob).toBeCloseTo(-0.5, 5)
    expect(r.segments).toHaveLength(2)
  })

  it('averages only the segments that carry a score', () => {
    const raw = JSON.stringify({
      text: 'hello',
      segments: [{ text: ' hello', avg_logprob: -0.2 }, { text: ' there' }],
    })
    expect(parseWhisperPayload(raw).avgLogprob).toBeCloseTo(-0.2, 5)
  })

  it('treats an empty transcript as a failure', () => {
    const r = parseWhisperPayload(JSON.stringify({ text: '   ' }))
    expect(r.ok).toBe(false)
  })

  it('falls back to plain text for older proxies', () => {
    const r = parseWhisperPayload('just some words')
    expect(r.ok).toBe(true)
    expect(r.text).toBe('just some words')
  })

  it('handles an empty payload', () => {
    expect(parseWhisperPayload('').ok).toBe(false)
  })
})

describe('whisper-proxy verbose_json contract (§5.1 B)', () => {
  it('parses the proxy verbose_json shape and extracts avg_logprob', () => {
    // Exact shape returned by /home/deepseekclaw/whisper-proxy/server.cjs
    const raw = JSON.stringify({
      task: 'transcribe',
      language: 'en',
      duration: 2.98,
      text: 'you',
      segments: [
        {
          id: 0,
          start: 0,
          end: 2.98,
          text: 'you',
          avg_logprob: -0.8220942914485931,
          no_speech_prob: 0.34,
        },
      ],
    })
    const r = parseWhisperPayload(raw)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('you')
    expect(r.avgLogprob).toBeCloseTo(-0.822, 3)
    expect(r.segments).toHaveLength(1)
    expect(r.segments?.[0].text).toBe('you')
  })

  it('treats a silent clip (empty text, no segments) as a soft failure', () => {
    const raw = JSON.stringify({
      task: 'transcribe',
      language: 'en',
      duration: 3,
      text: '',
      segments: [],
    })
    const r = parseWhisperPayload(raw)
    expect(r.ok).toBe(false)
    expect(r.text).toBe('')
    expect(r.segments).toBeUndefined()
  })

  it('never throws on malformed or unexpected payloads', () => {
    for (const bad of ['', 'not json', '[]', '{"text":null}', '{"segments":"oops"}']) {
      expect(() => parseWhisperPayload(bad)).not.toThrow()
    }
    expect(parseWhisperPayload('[]').ok).toBe(false)
    expect(parseWhisperPayload('{"segments":"oops"}').ok).toBe(false)
  })

  it('a real low-confidence score crosses the mini-game threshold', () => {
    // Verified live against the running proxy (avg_logprob ≈ -0.822).
    const LIVE_SCORE = -0.8220942914485931
    expect(LIVE_SCORE).toBeLessThan(LOW_CONFIDENCE_LOGPROB)
    expect(
      lowConfidenceWords([{ text: 'I went to the garage', avg_logprob: LIVE_SCORE }])
    ).toContain('garage')
  })
})

describe('history sanitising (§3.3 item 4)', () => {
  it('strips every marker and label from stored history', () => {
    const raw = [
      '🎤 London is lovely in autumn.',
      '✅ Fix: I go → I went',
      '📝 Why: past time needs Past Simple.',
      '🎯 New: journey — поездка',
      '🔊 British: schedule = /ˈʃedjuːl/ — sh sound',
      '🗣 Next: What did you see?',
    ].join('\n')
    const clean = sanitizeForHistory(raw)
    expect(clean).not.toContain('🎤')
    expect(clean).not.toContain('✅')
    expect(clean).not.toContain('📝')
    expect(clean).not.toContain('🎯')
    expect(clean).not.toContain('🔊')
    expect(clean).not.toContain('🗣')
    expect(clean).toContain('London is lovely in autumn.')
  })

  it('keeps plain prose unchanged', () => {
    expect(sanitizeForHistory('Hello! How are you today?')).toBe('Hello! How are you today?')
  })

  it('collapses multi-line spoken blocks into one line', () => {
    const clean = sanitizeForHistory('🎤 First sentence.\n🎤 Second sentence.')
    expect(clean).toBe('First sentence. Second sentence.')
  })
})

describe('scenario-mode response parsing', () => {
  it('parses a scenario reply without a 🎯/🔊 block', () => {
    const raw = [
      '🎤 Certainly, let me check those dates for you.',
      '✅ Fix: I want book → I would like to book',
      '📝 Why: after "would like" use the bare infinitive.',
      '🗣 Next: Would you prefer a twin or a double?',
    ].join('\n')
    const p = parseTutorResponse(raw)
    expect(p.spoken).toContain('let me check those dates')
    expect(p.fixes).toHaveLength(1)
    expect(p.newWords).toHaveLength(0)
    expect(p.british).toHaveLength(0)
    expect(p.next).toContain('twin or a double')
    expect(hasAnyMarker(raw)).toBe(true)
  })

  it('handles a multi-line Fix block and a Full review heading', () => {
    const raw = [
      '🎤 That is the end of our interview.',
      '✅ Fix: I have 25 year → I am 25 years old',
      '✅ Fix: I am working since 2019 → I have worked since 2019',
      '📝 Full review: watch the Present Perfect with "since".',
    ].join('\n')
    const p = parseTutorResponse(raw)
    expect(p.fixes).toHaveLength(2)
    expect(p.why).toContain('Present Perfect')
  })

  it('falls back to 🗣 as the spoken text when 🎤 is missing', () => {
    const p = parseTutorResponse('✅ Fix: a → b\n🗣 Next: Tell me more!')
    expect(p.spoken).toBe('Tell me more!')
    expect(p.fixes).toHaveLength(1)
  })

  it('ignores the 🔇 marker line and detects missing markers', () => {
    const p = parseTutorResponse('🔇 audio unavailable')
    expect(p.spoken).toBe('')
    expect(hasAnyMarker('Just plain text here')).toBe(false)
  })
})
