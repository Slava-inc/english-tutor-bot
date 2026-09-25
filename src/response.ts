// ============================================================================
// Parser for the tutor's structured response (marker-based).
// ============================================================================

export interface ParsedTutorResponse {
  spoken: string // 🎤 — what the bot says aloud (goes to TTS)
  fixes: Array<{ from: string | null; to: string | null }> // ✅ Fix blocks
  why: string // 📝 Why explanation
  newWords: Array<{ word: string; translation: string | null }> // 🎯 New
  british: Array<{ word: string; ipa: string; comment: string }> // 🔊 British
  next: string // 🗣 Next question
}

/** Every marker the tutor prompt may emit. */
export const MARKERS = ['🎤', '✅', '📝', '🎯', '🔊', '🗣', '🔇'] as const

const MARKER_RE = /^\s*(?:🎤|✅|📝|🎯|🔊|🗣|🔇)/
const LABELLED_RE =
  /^\s*(?:🎤|✅|📝|🎯|🔊|🗣|🔇)\s*(?:Fix|Why|New|British|Next|Full review|Spoken)?\s*:?\s*/i

/**
 * Strip all markers from a text so it can be safely replayed to the model as
 * conversation history (§3.3 item 4) or spoken by TTS.
 */
export function sanitizeForHistory(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(LABELLED_RE, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}


/**
 * Split a marker-structured response into logical blocks keyed by type.
 * Markers order/format may vary, so we scan line-by-line and group content
 * under the most recent marker header.
 */
export function parseTutorResponse(raw: string): ParsedTutorResponse {
  const out: ParsedTutorResponse = {
    spoken: '',
    fixes: [],
    why: '',
    newWords: [],
    british: [],
    next: '',
  }

  let block: 'spoken' | 'fix' | 'why' | 'new' | 'british' | 'next' | 'other' = 'other'

  const lines = raw.split(/\r?\n/)
  for (const lineRaw of lines) {
    const line = lineRaw.trim()
    if (!line) continue

    if (/^🎤\s*(?:Spoken)?\s*:?/i.test(line)) {
      block = 'spoken'
      out.spoken = appendLine(out.spoken, stripMarker(line, '🎤', 'Spoken'))
      continue
    }
    if (/^✅\s*(?:Fix)?\s*:?/i.test(line)) {
      block = 'fix'
      pushFix(out, line.replace(/^✅\s*(?:Fix)?\s*:?\s*/i, '').trim())
      continue
    }
    if (/^📝\s*(?:Why|Full review)?\s*:?/i.test(line)) {
      block = 'why'
      out.why = appendLine(out.why, stripMarker(line, '📝', 'Why|Full review'))
      continue
    }
    if (/^🎯\s*(?:New)?\s*:?/i.test(line)) {
      block = 'new'
      pushWords(out, stripMarker(line, '🎯', 'New'))
      continue
    }
    if (/^🔊\s*(?:British)?\s*:?/i.test(line)) {
      block = 'british'
      pushBritish(out, stripMarker(line, '🔊', 'British'))
      continue
    }
    if (/^🗣\s*(?:Next)?\s*:?/i.test(line)) {
      block = 'next'
      out.next = appendLine(out.next, stripMarker(line, '🗣', 'Next'))
      continue
    }
    if (/^🔇/.test(line)) {
      block = 'other'
      continue
    }

    // Continuation of the current block
    appendToBlock(out, block, line)
  }

  out.spoken = cleanOut(out.spoken)
  out.why = cleanOut(out.why)
  out.next = cleanOut(out.next)

  // Marker-free prose (greetings, /start copy, degraded model output) is spoken.
  if (!out.spoken && raw.trim() && !hasAnyMarker(raw)) {
    out.spoken = cleanOut(raw)
  } else if (!out.spoken && out.next) {
    // The model forgot the 🎤 block: speak the follow-up question rather than
    // staying silent (§4.3 — a missing block must never break the bot).
    out.spoken = out.next
  } else if (!out.spoken && out.fixes.length) {
    out.spoken = out.fixes.map((f) => f.to).filter(Boolean).join(' / ')
  }

  return out
}

/** True when the reply contains at least one structural marker. */
export function hasAnyMarker(raw: string): boolean {
  return raw.split(/\r?\n/).some((l) => MARKER_RE.test(l))
}


// --- helpers ---

function appendToBlock(
  out: ParsedTutorResponse,
  block: string,
  line: string
): void {
  switch (block) {
    case 'spoken':
      out.spoken = appendLine(out.spoken, line)
      break
    case 'fix':
      pushFix(out, line)
      break
    case 'why':
      out.why = appendLine(out.why, line)
      break
    case 'new':
      pushWords(out, line)
      break
    case 'british':
      pushBritish(out, line)
      break
    case 'next':
      out.next = appendLine(out.next, line)
      break
    default:
      // Content outside any marker: keep it so nothing is lost when plain text.
      out.spoken = appendLine(out.spoken, line)
  }
}

function appendLine(s: string, add: string): string {
  const glued =
    add.startsWith('.') ||
    add.startsWith(',') ||
    add.startsWith('—') ||
    add.startsWith('–')
  return s ? s + (glued ? '' : ' ') + add : add
}

function stripAfterPrefix(line: string, prefix: string): string {
  let rest = line
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length)
  return rest.replace(/^\s*:?\s*/, '').trim()
}

/**
 * Strip an emoji marker plus an optional English label (single label or an
 * alternation such as `Why|Full review`) and an optional colon.
 */
function stripMarker(line: string, emoji: string, label: string): string {
  const esc = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lab = label ? `(?:${label})?` : ''
  const re = new RegExp(`^${esc}\\s*${lab}\\s*:?\\s*`, 'i')
  return line.replace(re, '').trim()
}

function pushFix(
  out: ParsedTutorResponse,
  text: string
): void {
  if (!text) return
  const parts = text.split(/(?:→|->|=>)/).map((s) => s.trim())
  if (parts.length >= 2) {
    out.fixes.push({ from: cleanQuotes(parts[0]), to: cleanQuotes(parts.slice(1).join(' ')) })
  } else {
    out.fixes.push({ from: null, to: cleanQuotes(text) })
  }
}

function pushWords(
  out: ParsedTutorResponse,
  text: string
): void {
  const items = text
    .split(/;|•|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
  for (const it of items) {
    let dash = it.indexOf('—')
    if (dash === -1) dash = it.indexOf('–')
    if (dash !== -1) {
      out.newWords.push({
        word: cleanWordTok(it.slice(0, dash).trim()),
        translation: it.slice(dash + 1).trim(),
      })
    } else {
      out.newWords.push({ word: cleanWordTok(it), translation: null })
    }
  }
}

function cleanWordTok(s: string): string {
  return s.replace(/\*\*/g, '').replace(/\/(.*?)\//, '$1').trim()
}

function pushBritish(
  out: ParsedTutorResponse,
  text: string
): void {
  if (!text) return
  const wordMatch = text.match(/^([A-Za-z'’-]+)/)
  const ipaMatch = text.match(/\/([^/]+)\//)
  const word = wordMatch ? wordMatch[1] : ''
  const ipa = ipaMatch ? ipaMatch[1] : ''
  if (!word && !ipa) return
  out.british.push({
    word,
    ipa: ipa ? `/${ipa}/` : '',
    comment: cleanOut(text.replace(/^[\s\S]*?[—–\-]\s*/, '')),
  })
}

function cleanQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '').trim()
}

function cleanOut(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

