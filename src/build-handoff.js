import { getGitContext } from './git-context.js'

const TASK_MAX = 800
const TURN_MAX = 600
const LAST_ASSISTANT_MAX = 1200 // last assistant msg gets more room — it's the active work surface

function trunc(str, max) {
  if (!str) return ''
  str = str.trim()
  if (str.length <= max) return str
  return str.slice(0, max) + '…'
}

export function buildHandoff(source, parsed) {
  const { cwd, uuid, sessionId, startCommit, branch: parsedBranch, task, turns, filePath } = parsed
  const id = uuid || sessionId || 'unknown'
  const TOOL_NAMES = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
  const toolName = TOOL_NAMES[source] || source

  const git = cwd ? getGitContext(cwd, startCommit) : null
  const branch = git?.branch || parsedBranch || null

  const lines = []

  // ── Directive first — models process top-down ──────────────────────────
  const article = /^[aeiou]/i.test(toolName) ? 'an' : 'a'
  lines.push(`You're inheriting context from ${article} ${toolName} session (summarized below). Read it to get oriented, then STOP and wait for my direction. Do not open the transcript, read project files, or take any action until I explicitly ask.`)
  if (cwd) lines.push(`Work in: ${cwd}`)
  if (branch) lines.push(`Branch: ${branch}`)
  lines.push('')

  // ── What was the goal ──────────────────────────────────────────────────
  lines.push('Task:')
  lines.push(`  ${trunc(task, TASK_MAX) || '(not found)'}`)

  // ── Git state — the ground truth of what's been done ───────────────────
  if (git) {
    if (git.log) {
      lines.push('')
      lines.push(startCommit ? 'Commits since session started:' : 'Recent commits:')
      git.log.split('\n').forEach(l => lines.push(`  ${l}`))
    }
    if (git.status) {
      lines.push('')
      lines.push('Uncommitted changes:')
      git.status.split('\n').forEach(l => lines.push(`  ${l}`))
    }
  }

  // ── Conversation context — last exchange is most valuable ──────────────
  if (turns.length) {
    lines.push('')
    lines.push(`Recent conversation (${turns.length} messages):`)
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      const label = turn.role === 'user' ? 'User' : toolName
      // Give the last assistant message more space — it's what was in-flight
      const isLastAssistant = turn.role === 'assistant' && i === turns.length - 1
      const max = isLastAssistant ? LAST_ASSISTANT_MAX : TURN_MAX
      lines.push(`  ${label}: ${trunc(turn.text, max)}`)
    }
  }

  // ── Session file pointer for deep context ──────────────────────────────
  if (filePath) {
    lines.push('')
    lines.push(`Full ${toolName} transcript (open only if I ask you to dig deeper): ${filePath}`)
  }

  return lines.join('\n')
}

const SUMMARY_MAX = 1500 // ancestor end-state summaries get more room than a normal turn

// Combine a primary/tail session with a user-curated list of ancestor sessions
// (oldest→newest). The tail gets the full single-session handoff; each ancestor
// contributes a compact block (task + end-state summary + last exchange + a
// transcript pointer) so the thread's arc survives without inlining whole files.
export function buildChainHandoff(source, primary, ancestors) {
  const base = buildHandoff(source, primary)
  if (!ancestors || !ancestors.length) return base

  const TOOL_NAMES = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
  const toolName = TOOL_NAMES[source] || source

  const span = (a) => [a.firstTs, a.lastTs]
    .filter(Boolean)
    .map(t => String(t).slice(0, 16).replace('T', ' '))
    .join(' – ')

  const lines = [base, '', '## Prior sessions in this thread (chain context — open these transcripts only if I ask)']
  for (const a of ancestors) {
    const id = a.uuid || a.sessionId || 'unknown'
    const range = span(a)
    lines.push('')
    lines.push(`### ${id}${range ? `  (${range})` : ''}`)
    if (a.task) lines.push(`Original task: ${trunc(a.task, TASK_MAX)}`)
    if (a.finalSummary) lines.push(`End-state summary: ${trunc(a.finalSummary, SUMMARY_MAX)}`)
    const lastUser = [...a.turns].reverse().find(t => t.role === 'user')
    const lastAsst = [...a.turns].reverse().find(t => t.role === 'assistant')
    if (lastUser || lastAsst) {
      lines.push('Last exchange:')
      if (lastUser) lines.push(`  User: ${trunc(lastUser.text, TURN_MAX)}`)
      if (lastAsst) lines.push(`  ${toolName}: ${trunc(lastAsst.text, TURN_MAX)}`)
    }
    if (a.filePath) lines.push(`Transcript: ${a.filePath}`)
  }
  return lines.join('\n')
}
