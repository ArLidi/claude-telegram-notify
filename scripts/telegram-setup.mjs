#!/usr/bin/env node
// One-time setup: node telegram-setup.mjs <bot-token> [chat-id]
// Without a chat id it reads the bot's recent updates and picks the latest chat,
// so you just message the bot once first.

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const CONFIG_PATH = path.join(CONFIG_DIR, 'telegram-notify.json')

const token = (process.argv[2] || '').trim()
let chatId = (process.argv[3] || '').trim()

if (!token) {
  console.error('Usage: node telegram-setup.mjs <bot-token> [chat-id]')
  process.exit(1)
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json())

const me = await api('getMe')
if (!me.ok) {
  console.error(`Bad token: ${me.description || 'getMe failed'}`)
  process.exit(1)
}
console.log(`Bot: @${me.result.username}`)

if (!chatId) {
  const updates = await api('getUpdates', { limit: 100 })
  const chats = new Map()
  for (const u of updates.result || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.edited_message?.chat
    if (chat) chats.set(String(chat.id), chat)
  }
  if (chats.size === 0) {
    console.error(`No chats found. Open https://t.me/${me.result.username}, send /start, then re-run.`)
    process.exit(1)
  }
  const entries = [...chats.entries()]
  chatId = entries[entries.length - 1][0]
  const chat = entries[entries.length - 1][1]
  console.log(`Chat: ${chatId} (${chat.username || chat.title || chat.first_name || 'unknown'})`)
  if (entries.length > 1) {
    console.log(`Other chats seen: ${entries.slice(0, -1).map(([id]) => id).join(', ')}`)
  }
}

const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
const config = {
  ...existing,
  botToken: token,
  chatId,
  minTurnSeconds: existing.minTurnSeconds ?? 0,
  events: existing.events ?? { stop: true, failure: true, notification: true, question: true },
}
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
console.log(`Saved ${CONFIG_PATH}`)

const test = await api('sendMessage', {
  chat_id: chatId,
  text: '✅ Claude Code подключён к этому чату.',
})
console.log(test.ok ? 'Test message sent.' : `Test failed: ${test.description}`)
