import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

// Claude Code stores each session as ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// (the directory name is the cwd with '/' replaced by '-'). Records are one JSON
// object per line; user/assistant turns nest their content under `message`, and
// every record carries cwd/sessionId/gitBranch.
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Claude injects wrapper messages for slash commands and local command output
// (e.g. <command-name>, <local-command-caveat>); these aren't real user turns.
const COMMAND_SCAFFOLD = /^<(command-|local-command-)/

function extractContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
  }
  return ''
}

// Cheaply read session metadata (cwd/branch) from the first record that has it,
// without parsing the whole transcript.
function readSessionMeta(filePath) {
  let cwd = null
  let branch = null
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (!cwd && obj.cwd) cwd = obj.cwd
      if (!branch && obj.gitBranch) branch = obj.gitBranch
      if (cwd && branch) break
    }
  } catch {}
  return { cwd, branch }
}

export function parseClaudeSession(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter(l => l.trim())

  const turns = []
  let cwd = null
  let branch = null
  let sessionId = null
  let firstTs = null
  let lastTs = null
  let finalSummary = ''   // text of the LAST compaction summary — this session's end-state
  let task = ''           // first *real* (non-summary) user prompt

  for (const line of lines) {
    let obj
    try { obj = JSON.parse(line) } catch { continue }

    if (!cwd && obj.cwd) cwd = obj.cwd
    if (!branch && obj.gitBranch) branch = obj.gitBranch
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId
    if (obj.timestamp) { if (!firstTs) firstTs = obj.timestamp; lastTs = obj.timestamp }

    // Skip subagent/sidechain records — they're not part of the main thread.
    if (obj.isSidechain) continue

    const message = obj.message
    if (obj.type === 'user' && message) {
      const text = extractContent(message.content)
      // Skip slash-command scaffolding and empty (tool-result-only) user turns.
      if (!text || COMMAND_SCAFFOLD.test(text)) continue
      if (obj.isCompactSummary) finalSummary = text    // last one wins
      else if (!task) task = text                       // first non-summary prompt
      turns.push({ role: 'user', text })
    } else if (obj.type === 'assistant' && message) {
      const text = extractContent(message.content)
      if (text) turns.push({ role: 'assistant', text })
    }
  }

  const uuid = basename(filePath, '.jsonl')
  // Fully-compacted session with no real user turn: fall back to first user turn (the summary).
  if (!task) task = turns.find(t => t.role === 'user')?.text || ''

  return {
    sessionId: sessionId || uuid,
    uuid,
    cwd,
    branch,
    startCommit: null,
    task,
    turns,
    firstTs,
    lastTs,
    finalSummary,
  }
}

export function findClaudeSessions(filterDir = null) {
  let projectDirs
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    return []
  }

  const sessions = []
  for (const name of projectDirs) {
    const dir = join(PROJECTS_DIR, name)
    let files
    try { files = readdirSync(dir) } catch { continue }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, f)
      let mtime = 0
      try { mtime = statSync(path).mtimeMs } catch {}

      // cwd is stored in the transcript, so --dir filtering is supported.
      const { cwd } = filterDir ? readSessionMeta(path) : { cwd: null }
      if (filterDir && cwd !== filterDir) continue

      sessions.push({ path, mtime, cwd })
    }
  }

  return sessions.sort((a, b) => b.mtime - a.mtime)
}

export function findClaudeSessionById(id) {
  // Session files are named <uuid>.jsonl; tolerate a stray ses_ prefix.
  const normalized = id.replace(/^ses_/, '')
  let projectDirs
  try { projectDirs = readdirSync(PROJECTS_DIR) } catch { return null }

  for (const name of projectDirs) {
    const path = join(PROJECTS_DIR, name, `${normalized}.jsonl`)
    try {
      statSync(path)
      return path
    } catch {}
  }
  return null
}

export function getLastClaudeSession(filterDir = null) {
  const sessions = findClaudeSessions(filterDir)
  return sessions[0]?.path || null
}
