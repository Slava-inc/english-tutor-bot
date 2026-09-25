import path from 'path'
import { fileURLToPath } from 'url'
import { config as loadDotenv } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Project root = directory that contains package.json (parent of src/config.ts)
export const PROJECT_ROOT = path.resolve(__dirname, '..')

// Load .env from project root
loadDotenv({ path: path.join(PROJECT_ROOT, '.env') })

function get(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function getNum(name: string, fallback: number): number {
  const v = Number(get(name, String(fallback)))
  return Number.isFinite(v) ? v : fallback
}

// --- Telegram ---
export const TELEGRAM_BOT_TOKEN = get('TELEGRAM_BOT_TOKEN')
export const ALLOWED_USER_IDS = get('ALLOWED_USER_IDS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)

// --- DeepSeek ---
export const DEEPSEEK_API_KEY = get('DEEPSEEK_API_KEY')
export const DEEPSEEK_MODEL = get('DEEPSEEK_MODEL', 'deepseek-chat')
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// --- Whisper (STT) ---
export const WHISPER_URL = get(
  'WHISPER_URL',
  'http://127.0.0.1:3011/v1/audio/transcriptions'
)
export const WHISPER_MODEL = get('WHISPER_MODEL', 'small')
export const WHISPER_TIMEOUT_MS = getNum('WHISPER_TIMEOUT_MS', 300000)

// --- Google TTS (legacy provider, kept for TTS_PROVIDER=google rollback) ---
// NOTE: `GOOGLE_APPLICATION_CREDENTIALS` is only consulted when TTS_PROVIDER=google.
// Set it explicitly in your .env; the fallback below is a generic placeholder path.
export const GOOGLE_APPLICATION_CREDENTIALS = get(
  'GOOGLE_APPLICATION_CREDENTIALS',
  './secrets/google-speech-key.json'
)
export const TTS_VOICE = get('TTS_VOICE', 'en-GB-Neural2-F')
export const TTS_ENDPOINT = get('TTS_ENDPOINT')

// --- Text-to-speech (xAI Voice, prototype) -----------------------------------
// Verified live against https://api.x.ai/v1/tts:
//   codec `opus` returns a real Ogg-Opus container (OggS/OpusHead) — exactly the
//   format Telegram voice notes require, so no ffmpeg transcoding is needed.
//   Accepted codecs: mp3 | wav | pcm | opus | mulaw | ulaw | alaw
//   Accepted sample rates: 8000, 16000, 22050, 24000, 44100, 48000
//   British voices: leo, rex, eve
export const XAI_API_KEY = get('XAI_API_KEY')
export const XAI_TTS_URL = get('XAI_TTS_URL', 'https://api.x.ai/v1/tts')
export const XAI_TTS_TIMEOUT_MS = getNum('XAI_TTS_TIMEOUT_MS', 60000)

/** Which TTS backend to use: 'xai' (prototype) or 'google' (legacy). */
export const TTS_PROVIDER = get('TTS_PROVIDER', 'xai')
/** BCP-47 tag; `en-GB` is accepted by the xAI endpoint. */
export const TTS_LANGUAGE = get('TTS_LANGUAGE', 'en-GB')
/** xAI voice id (leo|rex|eve are British) or Google voice name, per provider. */
export const TTS_XAI_VOICE = get('TTS_XAI_VOICE', 'leo')
/** Speech speed multiplier; 1.0 is normal. Mirrors Google's speakingRate 0.95. */
export const TTS_SPEED = getNum('TTS_SPEED', 0.95)
/** Output codec for the xAI provider. `opus` is Telegram-native. */
export const TTS_CODEC = get('TTS_CODEC', 'opus')
/** Output sample rate for the xAI provider (Hz). */
export const TTS_SAMPLE_RATE = getNum('TTS_SAMPLE_RATE', 24000)

// --- Storage: SQLite ---
const DB_ENV = get('DB_PATH', './data/tutor.db')
export const DB_PATH = path.isAbsolute(DB_ENV) ? DB_ENV : path.join(PROJECT_ROOT, DB_ENV)
// "data" dir created next to the db file, one level up when db file is direct
export const DATA_DIR = path.dirname(DB_PATH)

// --- Storage: TTS cache ---
const TTS_ENV = get('TTS_CACHE_DIR', './data/tts-cache')
export const TTS_CACHE_DIR = path.isAbsolute(TTS_ENV)
  ? TTS_ENV
  : path.join(PROJECT_ROOT, TTS_ENV)
export const TTS_CACHE_TTL_MS = getNum('TTS_CACHE_TTL_MS', 7 * 24 * 60 * 60 * 1000)

// --- Context ---
export const MAX_HISTORY_TURNS = getNum('MAX_HISTORY_TURNS', 20)
export const MAX_HISTORY_TOKENS = getNum('MAX_HISTORY_TOKENS', 3000)
export const SESSION_IDLE_MS = getNum('SESSION_IDLE_MS', 4 * 60 * 60 * 1000)
export const SESSION_MAX_TURNS = getNum('SESSION_MAX_TURNS', 15)

// --- Logging ---
export const LOG_LEVEL = get('LOG_LEVEL', 'info')
export const NODE_ENV = get('NODE_ENV', 'production')
