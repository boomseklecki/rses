import { spawn, spawnSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'

export function launchWithHandoff(tool, handoff, cwd, passthroughArgs = []) {
  // opencode uses `opencode run <message>`, claude/codex accept prompt as bare arg
  const args = tool === 'opencode'
    ? ['run', ...passthroughArgs, handoff]
    : [...passthroughArgs, handoff]
  const opts = {
    stdio: 'inherit',
    cwd: cwd || process.cwd(),
    // Detach from our process so the tool gets a clean TTY
    shell: false,
  }

  const child = spawn(tool, args, opts)

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      const installHints = {
        claude: '  Install: npm i -g @anthropic-ai/claude-code',
        codex: '  Install: npm i -g @openai/codex',
        opencode: '  Install: see https://github.com/opencode-ai/opencode',
      }
      console.error(`\nError: '${tool}' not found on PATH. Is it installed?`)
      console.error(installHints[tool] || `  Install ${tool} and ensure it's on your PATH.`)
      process.exit(1)
    }
    throw err
  })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

// ── aoe delivery ─────────────────────────────────────────────────────────────
// Create an aoe-managed structured session for `agent` and seed it with the
// handoff via `aoe acp prompt <id> -` (stdin). rses stays the synthesis layer;
// aoe owns session lifecycle — the daily-driver path.

function aoeSessionIds() {
  const r = spawnSync('aoe', ['acp', 'ps', '--json'], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return []
  try {
    const rows = JSON.parse(r.stdout)
    const list = Array.isArray(rows) ? rows : (rows.sessions || [])
    return list.map(s => s.id || s.session_id || s.sessionId || s.acp_session_id).filter(Boolean)
  } catch { return [] }
}

// `aoe add --structured-view` spawns the ACP worker asynchronously; a prompt sent
// before it registers fails with "session not found on the daemon". Poll `aoe acp
// ps` until the worker is alive.
function waitForAoeWorker(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = spawnSync('aoe', ['acp', 'ps', '--json'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout) {
      try {
        const rows = JSON.parse(r.stdout)
        const list = Array.isArray(rows) ? rows : (rows.sessions || [])
        if (list.some(s => (s.session_id || s.id) === sessionId && s.alive !== false)) return true
      } catch { /* keep polling */ }
    }
    process.stdout.write('.')
    spawnSync('sleep', ['0.5'])
  }
  return false
}

// Poll the session's tmux pane until the agent's native TUI shows its ready prompt.
// A fixed sleep raced opencode's startup and dropped the handoff keystrokes.
function waitForTerminalReady(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ls = spawnSync('tmux', ['ls'], { encoding: 'utf8' })
    // aoe's tmux session name embeds only the FIRST 8 chars of the session id
    // (e.g. `aoe_<title>_dcc77fa9`), so match that prefix, not the full id.
    const line = (ls.stdout || '').split('\n').find(l => l.includes(sessionId.slice(0, 8)))
    if (line) {
      const tm = line.split(':')[0]
      const cap = spawnSync('tmux', ['capture-pane', '-t', tm, '-p'], { encoding: 'utf8' })
      if (/Ask anything|ctrl\+p commands|esc interrupt/.test(cap.stdout || '')) return true
    }
    process.stdout.write('.')
    spawnSync('sleep', ['1'])
  }
  return false
}

export function launchViaAoe(agent, handoff, { dir, title, structured } = {}) {
  const cwd = dir || process.cwd()
  const t = title || 'rses handoff'
  const before = new Set(aoeSessionIds())

  // Terminal view (default) runs the agent's own native TUI — no aoe ACP layer,
  // which is where the binding/render bugs live. `--tool` sets the real tool;
  // `--structured` opts into aoe's ACP-rendered structured view instead.
  const add = spawnSync('aoe',
    structured
      ? ['add', cwd, '--tool', agent, '--structured-view', '--title', t]
      : ['add', cwd, '--tool', agent, '--title', t],
    { encoding: 'utf8' })
  if (add.error) {
    if (add.error.code === 'ENOENT') {
      console.error("\nError: 'aoe' not found on PATH. Install it, or drop --via-aoe.")
      process.exit(1)
    }
    throw add.error
  }
  if (add.status !== 0) {
    console.error(`\naoe add failed (exit ${add.status}):\n${(add.stderr || add.stdout || '').trim()}`)
    process.exit(add.status || 1)
  }

  // New session id: `aoe add` prints "ID: <id>" (16-hex, not a UUID). Parse that
  // first; fall back to an `aoe acp ps` diff if the output format ever changes.
  const out = add.stdout || ''
  let sessionId = (out.match(/^\s*ID:\s*(\S+)/m) || [])[1] || null
  if (!sessionId) sessionId = aoeSessionIds().find(id => !before.has(id)) || null
  if (!sessionId) {
    console.error('\nCreated the aoe session but could not determine its id. Check `aoe acp ps`, then seed manually:')
    console.error('  aoe acp prompt <session-id> -   # paste the handoff on stdin')
    process.exit(1)
  }

  if (structured) {
    // ACP: the worker spawns async — wait for it to register, then deliver via stdin.
    process.stdout.write(`  Waiting for aoe worker ${sessionId} to register`)
    if (!waitForAoeWorker(sessionId, 20000)) {
      console.error(`\n\nSession ${sessionId} was created but its worker didn't register in time.`)
      console.error(`Seed it manually once it's up:  aoe acp prompt ${sessionId} -`)
      process.exit(1)
    }
    console.log(' ready.')
    console.log(`\n  Seeding aoe session ${sessionId} with the handoff...\n`)
    const seed = spawnSync('aoe', ['acp', 'prompt', sessionId, '-'], {
      input: handoff,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    if (seed.status !== 0) {
      console.error(`\naoe acp prompt failed (exit ${seed.status}).`)
      process.exit(seed.status || 1)
    }
    console.log(`\n  Done — structured session ${sessionId} seeded. Open it in the aoe dashboard (or: aoe acp attach ${sessionId}).\n`)
  } else {
    // Terminal: a throwaway send auto-starts the TUI (no attach/TTY needed); wait
    // until its prompt is ready before seeding.
    process.stdout.write(`  Starting ${agent}'s TUI`)
    spawnSync('aoe', ['send', sessionId, ' '], { encoding: 'utf8' })
    if (!waitForTerminalReady(sessionId, 30000)) {
      console.error(`\nSession ${sessionId} is up but ${agent}'s TUI didn't become ready in time — seed it manually.`)
      process.exit(1)
    }
    console.log(' ready — seeding.')

    // Pasting a large handoff as keystrokes into the TUI is unreliable — they drop.
    // Write it to a file in the cwd (so the agent can read it without a permission
    // prompt) and send a short instruction to read it.
    const handoffFile = join(cwd, `.rses-handoff-${sessionId}.md`)
    try {
      writeFileSync(handoffFile, handoff, 'utf8')
    } catch (e) {
      console.error(`\nCould not write handoff file ${handoffFile}: ${e.message}`)
      process.exit(1)
    }
    const msg = `Read the file ${handoffFile} — it is context handed off from a prior session. Get oriented from it, then STOP and wait for my direction; do not read other project files or take any action until I explicitly ask.`
    const seed = spawnSync('aoe', ['send', sessionId, msg], { encoding: 'utf8' })
    if (seed.status !== 0) {
      console.error(`\naoe send failed (exit ${seed.status}):\n${(seed.stderr || seed.stdout || '').trim()}`)
      console.error(`Seed it manually:  aoe send ${sessionId} "Read ${handoffFile} and get oriented"`)
      process.exit(seed.status || 1)
    }
    console.log(`\n  Done — terminal session ${sessionId} seeded (${agent}'s native TUI, context in ${handoffFile}). Open it in the aoe dashboard.\n`)
  }
}
