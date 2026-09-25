// ============================================================================
// English Tutor — Telegram entry point (grammy)
// ============================================================================

import { Bot } from 'grammy'
import { mkdirSync } from 'fs'
import { TELEGRAM_BOT_TOKEN, PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'
import { closeDb } from './db.js'
import { registerHandlers } from './handlers.js'

mkdirSync(PROJECT_ROOT + '/data', { recursive: true })

let bot: Bot | null = null

async function start(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is empty. Copy .env.example to .env and fill it.')
    process.exit(1)
  }

  bot = new Bot(TELEGRAM_BOT_TOKEN)
  registerHandlers(bot)

  bot.catch((err) => {
    const em = (err.error as unknown as { message?: string })?.message ?? 'unknown'
    logger.warn({ error: em }, 'bot handler error')
  })

  await bot.init()
  logger.info(`English Tutor online as @${bot.botInfo.username}`)
  await bot.start({ drop_pending_updates: true })
}

function shutdown(): void {
  bot?.stop()
  closeDb()
  process.exit(0)
}

start().catch((e) => {
  logger.error({ error: String(e) }, 'fatal startup error')
  process.exit(1)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
