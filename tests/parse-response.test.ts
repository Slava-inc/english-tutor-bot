import { describe, it, expect } from 'vitest'
import { parseTutorResponse } from '../src/response.js'

describe('parseTutorResponse', () => {
  it('parses a full marked reply', () => {
    const raw = [
      '🎤 Let me tell you about my last journey to London. It was brilliant!',
      '✅ Fix: I go to London yesterday → I went to London yesterday',
      '📝 Why: yesterday = past time → Past Simple (went).',
      '🎯 New: journey — поездка; trip — короткая поездка',
      '🔊 British: schedule = /ˈʃedjuːl/ — starts with "sh".',
      '🗣 Next: Tell me more! What did you see?',
    ].join('\n')
    const p = parseTutorResponse(raw)
    expect(p.spoken).toContain('journey to London')
    expect(p.fixes).toHaveLength(1)
    expect(p.fixes[0].from).toContain('go to London')
    expect(p.fixes[0].to).toContain('went to London')
    expect(p.why).toContain('Past Simple')
    expect(p.newWords.length).toBeGreaterThanOrEqual(2)
    expect(p.newWords[0].word).toBe('journey')
    expect(p.british[0].word).toBe('schedule')
    expect(p.next).toContain('What did you see')
  })

  it('handles a plain text reply (no markers) as spoken', () => {
    const p = parseTutorResponse('Hello! Lovely to meet you. How are you today?')
    expect(p.spoken).toContain('How are you today?')
    expect(p.fixes).toHaveLength(0)
  })

  it('skips absent blocks', () => {
    const p = parseTutorResponse('🎤 Nice! \n🗣 And you?')
    expect(p.spoken).toBe('Nice!')
    expect(p.fixes).toHaveLength(0)
    expect(p.next).toContain('And you?')
  })
})
