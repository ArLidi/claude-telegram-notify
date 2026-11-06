#!/usr/bin/env node
// Claude Code hook -> Telegram.
// Wired to Stop, StopFailure, Notification and PreToolUse:AskUserQuestion.
// Never throws and always exits 0 so a broken notifier can't break a session.
//
// Payload shapes, taken from the CLI's own schemas (v2.1.273):
//   Stop          { stop_hook_active, last_assistant_message? }
//   StopFailure   { error, error_details?, last_assistant_message? }
//   Notification  { message, title?, notification_type }

import { readFileSync, existsSync, statSync, realpathSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const CONFIG_PATH = path.join(CONFIG_DIR, 'telegram-notify.json')
const LOG_PATH = path.join(CONFIG_DIR, 'telegram-notify.log')

const MAX_BODY = 1200 // Telegram caps a message at 4096 chars; leave room for the header.
const MAX_CAPTION = 900 // Telegram caps a document caption at 1024.

// notification_type -> header. Anything not listed still sends, with a plain bell.
const NOTIFICATION_LABELS = {
  permission_prompt: '🔐 Нужен доступ',
  worker_permission_prompt: '🔐 Нужен доступ (фоновый агент)',
  idle_prompt: '💤 Claude ждёт вас',
  agent_needs_input: '❓ Агенту нужен ответ',
  agent_completed: '🤖 Фоновый агент закончил',
  quota_auto_resume_fired: '▶️ Лимит сброшен, работа продолжена',
  quota_auto_resume_stale: '⏸ Автовозобновление устарело',
  quota_auto_resume_disabled: '⏸ Автовозобновление отключено',
  model_refusal_fallback: '🔀 Переключение модели',
}

// StopFailure `error` -> header. Covers all 13 values the CLI can emit.
const FAILURE_LABELS = {
  rate_limit: '🚧 Упёрся в лимит запросов',
  overloaded: '🌡 Модель перегружена',
  billing_error: '💳 Проблема с оплатой',
  account_on_hold: '⛔ Аккаунт заморожен',
  max_output_tokens: '✂️ Упёрся в лимит вывода',
  authentication_failed: '🔑 Ошибка авторизации',
  oauth_org_not_allowed: '🔑 Организация не разрешена',
  verification_required: '🔑 Требуется верификация',
  cloud_credential_error: '🔑 Ошибка облачных ключей',
  model_not_found: '❔ Модель не найдена',
  invalid_request: '⚠️ Некорректный запрос',
  server_error: '💥 Ошибка сервера',
  unknown: '❌ Неизвестная ошибка',
}

function log(msg) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// A mistyped number in the config must not silently disable the limit it names:
// Number('many') is NaN, and every `x > NaN` / `x <= NaN` comparison is false.
function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback
}

function loadConfig() {
  let cfg = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (e) {
      log(`config parse failed: ${e.message}`)
    }
  }
  const planDirs =
    Array.isArray(cfg.planDirs) && cfg.planDirs.length ? cfg.planDirs : [path.join(CONFIG_DIR, 'plans')]
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || cfg.botToken || '',
    chatId: String(process.env.TELEGRAM_CHAT_ID || cfg.chatId || ''),
    // Skip the Stop ping for turns shorter than this (seconds). 0 = notify always.
    minTurnSeconds: num(cfg.minTurnSeconds, 0),
    events: { stop: true, failure: true, notification: true, question: true, ...(cfg.events || {}) },
    // Follow a finished turn with the plan files it linked to.
    sendPlans: cfg.sendPlans !== false,
    // Only files under these roots are ever read and sent. Everything else in the
    // message is ignored — an assistant message can name any path on the machine.
    planDirs,
    planInlineMaxChars: num(cfg.planInlineMaxChars, 3000),
    planMaxBytes: num(cfg.planMaxBytes, 1_000_000),
    planMaxFiles: num(cfg.planMaxFiles, 3),
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(s, n = MAX_BODY) {
  const t = String(s).trim()
  if (t.length <= n) return t
  // slice() counts UTF-16 units, so a cut can land between the two halves of an
  // astral character (any emoji). The orphaned half becomes U+FFFD in a multipart
  // caption and a bare \ud83d in JSON, which the Bot API rejects outright.
  let cut = n
  const last = t.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return `${t.slice(0, cut)}…`
}

function header(label, project) {
  return `<b>${label}</b> — <code>${esc(project)}</code>`
}

// Last resort only: the transcript is written asynchronously and can lag behind
// the turn that just ended, so last_assistant_message is always preferred.
const transcriptCache = new Map()

function transcriptTail(transcriptPath) {
  if (transcriptCache.has(transcriptPath)) return transcriptCache.get(transcriptPath)
  const out = { text: '', turnStartedAt: null }
  transcriptCache.set(transcriptPath, out)
  if (!transcriptPath || !existsSync(transcriptPath)) return out
  let lines
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  } catch (e) {
    log(`transcript read failed: ${e.message}`)
    return out
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!out.text && entry.type === 'assistant') {
      const content = entry.message?.content
      const parts = Array.isArray(content)
        ? content.filter((c) => c?.type === 'text').map((c) => c.text)
        : typeof content === 'string'
          ? [content]
          : []
      const text = parts.join('\n').trim()
      if (text) out.text = text
    }
    if (entry.type === 'user' && !entry.isMeta) {
      out.turnStartedAt = entry.timestamp || null
      break // Everything older belongs to a previous turn.
    }
  }
  return out
}

// The one source of the turn's final text. build() and the plan step must agree:
// if they disagree, a notification can quote a plan link the plan step never sees.
function assistantText(input) {
  return input.last_assistant_message || transcriptTail(input.transcript_path).text || ''
}

function turnWasTooShort(input, cfg) {
  if (!(cfg.minTurnSeconds > 0)) return false
  const { turnStartedAt } = transcriptTail(input.transcript_path)
  if (!turnStartedAt) return false
  const elapsed = (Date.now() - new Date(turnStartedAt).getTime()) / 1000
  return Number.isFinite(elapsed) && elapsed < cfg.minTurnSeconds
}

function questionText(toolInput) {
  const qs = toolInput?.questions
  if (!Array.isArray(qs)) return ''
  return qs
    .map((q) => {
      const opts = (q.options || []).map((o) => `• ${o.label}`).join('\n')
      return [q.question, opts].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

// --- plan attachments -------------------------------------------------------

// Windows paths compare case-insensitively; POSIX ones do not.
function samePathCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isInside(root, target) {
  const rel = path.relative(samePathCase(root), samePathCase(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// Containment is checked on the resolved path, not the spelling: a symlink or
// junction inside planDirs would otherwise export any file on the machine.
function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Markdown links first, then bare absolute paths that ended up outside a link.
function extractPaths(text) {
  const found = []
  const push = (v) => {
    const t = (v || '').trim().replace(/^<|>$/g, '')
    if (t) found.push(t)
  }
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) push(m[1])
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"'<>|*?]+\.md/g)) push(m[0])
  for (const m of text.matchAll(/(?:^|\s)(\/[^\s"'<>|*?]+\.md)/g)) push(m[1])
  return found
}

// Resolve the message's file references down to plan files we are willing to send.
function collectPlans(message, cfg) {
  const out = []
  const seen = new Set()
  const roots = cfg.planDirs.map((root) => realOrSelf(path.resolve(root)))
  for (const raw of extractPaths(message)) {
    // Checked before any filesystem work, so planMaxFiles: 0 really means none.
    if (out.length >= cfg.planMaxFiles) break
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue // http://, file://, …
    let abs
    try {
      abs = realOrSelf(path.resolve(raw))
    } catch {
      continue
    }
    const key = samePathCase(abs)
    if (seen.has(key)) continue
    seen.add(key)

    if (path.extname(abs).toLowerCase() !== '.md') continue
    if (!roots.some((root) => isInside(root, abs))) continue

    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > cfg.planMaxBytes) {
      log(`plan skipped, ${stat.size} bytes over planMaxBytes: ${abs}`)
      continue
    }

    let body
    try {
      body = readFileSync(abs, 'utf8')
    } catch (e) {
      log(`plan read failed ${abs}: ${e.message}`)
      continue
    }
    if (!body.trim()) continue

    out.push({ absPath: abs, name: path.basename(abs), body })
  }
  return out
}

function build(input, cfg) {
  const event = input.hook_event_name || process.argv[2] || ''
  const project = path.basename(input.cwd || process.cwd())

  if (event === 'Stop') {
    if (!cfg.events.stop) return null
    if (turnWasTooShort(input, cfg)) return null
    const text = assistantText(input)
    return `${header('✅ Claude закончил', project)}\n\n${esc(clip(text || '(без текстового ответа)'))}`
  }

  if (event === 'StopFailure') {
    if (!cfg.events.failure) return null
    const label = FAILURE_LABELS[input.error] || FAILURE_LABELS.unknown
    const parts = [`Ход прерван: <code>${esc(input.error || 'unknown')}</code>`]
    if (input.error_details) parts.push(esc(clip(input.error_details, 600)))
    if (input.last_assistant_message) {
      parts.push(`\n<i>Последнее сообщение:</i>\n${esc(clip(input.last_assistant_message, 400))}`)
    }
    return `${header(label, project)}\n\n${parts.join('\n')}`
  }

  if (event === 'Notification') {
    if (!cfg.events.notification) return null
    const label = NOTIFICATION_LABELS[input.notification_type] || '🔔 Уведомление'
    const body = [input.title, input.message].filter(Boolean).join('\n')
    return `${header(label, project)}\n\n${esc(clip(body || 'Нужно ваше внимание'))}`
  }

  if (event === 'PreToolUse') {
    if (!cfg.events.question) return null
    const q = questionText(input.tool_input)
    if (!q) return null
    return `${header('❓ Вопрос от Claude', project)}\n\n${esc(clip(q))}`
  }

  return null
}

async function call(cfg, method, body, isForm) {
  const url = `https://api.telegram.org/bot${cfg.botToken}/${method}`
  const init = isForm
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(url, init)
  if (!res.ok) log(`telegram ${method} ${res.status}: ${clip(await res.text(), 300)}`)
  return res.ok
}

function sendMessage(cfg, text, { html = true } = {}) {
  return call(cfg, 'sendMessage', {
    chat_id: cfg.chatId,
    text,
    ...(html ? { parse_mode: 'HTML' } : {}),
    disable_web_page_preview: true,
  })
}

function sendDocument(cfg, plan) {
  const form = new FormData()
  form.append('chat_id', cfg.chatId)
  form.append('caption', `📋 ${plan.name}\n\n${clip(plan.body, MAX_CAPTION)}`)
  form.append('document', new Blob([plan.body], { type: 'text/markdown' }), plan.name)
  return call(cfg, 'sendDocument', form, true)
}

// Short plans read better inline; long ones go as a file so one plan stays one
// notification instead of four.
function sendPlan(cfg, plan) {
  if (plan.body.length <= cfg.planInlineMaxChars) {
    return sendMessage(cfg, `📋 ${plan.name}\n\n${plan.body}`, { html: false })
  }
  return sendDocument(cfg, plan)
}

async function main() {
  const cfg = loadConfig()
  if (!cfg.botToken || !cfg.chatId) {
    log('missing botToken/chatId — run telegram-setup.mjs')
    return
  }
  let input = {}
  try {
    input = JSON.parse(readStdin() || '{}')
  } catch (e) {
    log(`stdin parse failed: ${e.message}`)
  }
  const text = build(input, cfg)
  if (!text) return
  await sendMessage(cfg, text)

  if (!cfg.sendPlans) return
  const event = input.hook_event_name || process.argv[2] || ''
  if (event !== 'Stop' && event !== 'StopFailure') return
  const source = assistantText(input)
  if (!source) return
  for (const plan of collectPlans(source, cfg)) {
    await sendPlan(cfg, plan)
  }
}

main().catch((e) => log(`fatal: ${e?.stack || e}`))
