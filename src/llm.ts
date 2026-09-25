import OpenAI from 'openai'
import { DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL } from './config.js'
import { logger } from './logger.js'

let client: OpenAI | null = null

/**
 * Test seam: when set, `chatCompletion` returns whatever this function yields
 * instead of calling DeepSeek. Used by tests/e2e-dialog.test.ts and scripts.
 */
export type LlmMock = (
  req: LlmRequest
) => string | null | Promise<string | null>

let mock: LlmMock | null = null

export function setLlmMock(fn: LlmMock | null): void {
  mock = fn
}

export function isLlmMocked(): boolean {
  return mock !== null
}

function getClient(): OpenAI {
  if (!client) {
    if (!DEEPSEEK_API_KEY) {
      throw new Error(
        'DEEPSEEK_API_KEY not found. Set it in .env (see .env.example).'
      )
    }
    client = new OpenAI({ baseURL: DEEPSEEK_BASE_URL, apiKey: DEEPSEEK_API_KEY })
  }
  return client
}

export interface LlmRequest {
  system: string // role/system instructions
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  userMessage: string
}

/** The most recent request handed to `chatCompletion` — handy for assertions. */
let lastRequest: LlmRequest | null = null

export function getLastLlmRequest(): LlmRequest | null {
  return lastRequest
}

/**
 * Call DeepSeek chat completions. Returns the assistant text or null on failure.
 * When a mock is installed via `setLlmMock` it short-circuits the HTTP call.
 */
export async function chatCompletion(req: LlmRequest): Promise<string | null> {
  lastRequest = req
  if (mock) {
    const mocked = await mock(req)
    return mocked
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
  ]
  for (const h of req.history) {
    if (h.role === 'system') continue // only one system slot
    messages.push({ role: h.role, content: h.content })
  }
  messages.push({ role: 'user', content: req.userMessage })

  try {
    const resp = await getClient().chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 700,
    })
    return resp.choices[0]?.message?.content?.trim() ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn({ error: msg.slice(0, 400) }, 'DeepSeek completion failed')
    return null
  }
}
