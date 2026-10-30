// Checks on Bash commands before they run. Pure: the hook passes in what it
// knows about the session and the cluster.
//
// `reject` findings are commands that would silently break or hurt other
// users, and that Slurm itself does not refuse: blocking them never costs a
// working command. Anything Slurm refuses on its own (interactive scavenger,
// say) is left to Slurm, whose message stays in step with the policy.
// `note` findings never block; they ride along as context for the model.

export type Finding = { level: 'reject' | 'note'; rule: string; message: string }

export type GuardContext = {
  /** The session's working directory, where a bare command runs; '' = unknown. */
  cwd: string
  /** The person's home directory, for `~` and `$HOME`; '' or absent = unknown. */
  home?: string
  /** Nodes where this user holds a running allocation right now; null = unknown. */
  allocatedNodes: ReadonlySet<string> | null
  /** True when the session runs on the login node (sprlab005). */
  isLoginNode: boolean
  /**
   * The text of batch scripts the hook could read, by the path as written in
   * the command; a script's own `#SBATCH --chdir` settles where it runs.
   */
  scripts?: ReadonlyMap<string, string>
}

/**
 * The command line without its heredoc bodies: `<<EOF` (or `<<-EOF`, `<<'EOF'`,
 * `<<"EOF"`) keeps its own line and drops every line up to the delimiter.
 * A body is data, and an apostrophe or `"""` inside one would otherwise open
 * a quote that swallows every command after it, `sbatch` included.
 */
export function stripHeredocs(command: string): string {
  const out: string[] = []
  let body: string[] = []
  const pending: { word: string; tabs: boolean; runs: boolean }[] = []
  for (const line of command.split('\n')) {
    if (pending.length) {
      // A body fed to a local shell or interpreter is commands run here: keep it.
      if (pending[0]!.runs) out.push(line)
      else body.push(line)
      const d = pending[0]!
      if ((d.tabs ? line.replace(/^\t+/, '') : line) === d.word) {
        pending.shift()
        if (!pending.length) body = []
      }
      continue
    }
    out.push(line)
    // <<EOF, <<-EOF, <<'EOF', <<"EOF" and <<\EOF.
    for (const m of line.matchAll(/(?<!<)<<(-?)\s*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      const before = line.slice(0, m.index)
      if (!isLiteralCode(before)) continue
      pending.push({ word: m[3]!, tabs: m[1] === '-', runs: runsHere(before) })
    }
  }
  // No terminator: not a heredoc after all, so nothing is hidden (fail closed).
  return [...out, ...body].join('\n')
}

// Shells that run a heredoc fed to them as commands on this host. Another language's body
// (python, perl) is not shell and cannot be read as commands; srun and ssh run elsewhere.
const SHELLS = /^(bash|sh|zsh|dash|ksh|eval|source|\.)$/
const WRAPPERS = /^(env|time|nohup|sudo|exec|command|-[A-Za-z-]+)$/

/** Whether the command a `<<` belongs to (the last simple command before it) is a shell run here. */
function runsHere(before: string): boolean {
  const seg = before.split(/\|\||&&|[;|&(]/).pop() ?? ''
  const words = seg.trim().split(/\s+/).filter(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const cmd = words.map(w => w.split('/').pop() ?? '').find(w => !WRAPPERS.test(w)) ?? ''
  return SHELLS.test(cmd)
}

/** Whether text ending here is outside quotes, a comment and `$(( ))`, so a `<<` that follows is a heredoc. */
function isLiteralCode(before: string): boolean {
  let quote: string | null = null
  let arith = 0
  for (let i = 0; i < before.length; i++) {
    const c = before[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') i++
      continue
    }
    if (c === '\\') i++
    else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(before[i - 1]!))) return false
    else if (before.startsWith('$((', i)) (arith++, (i += 2))
    else if (before.startsWith('((', i)) (arith++, i++)
    else if (before.startsWith('))', i) && arith) (arith--, i++)
  }
  return !quote && !arith
}

/**
 * Splits a command line into simple commands on ;, &&, ||, |, newlines. Quote-aware.
 * `skipHeredocs` is for spotting submissions only: the guards always parse the raw
 * command, so a heredoc misread can never hide a command from them.
 */
export function segments(command: string, skipHeredocs = false): string[][] {
  if (skipHeredocs) command = stripHeredocs(command)
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSeg = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') endSeg()
    else if (c === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i++
      endSeg()
    } else {
      word += c
      hasWord = true
    }
  }
  endSeg()
  return out
}

/** Drops leading VAR=value assignments, wrappers like `env`, `time`, `nohup`, and shell keywords (`do`, `then`). */
function head(words: readonly string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (/^(env|time|nohup|exec|command|do|then|else|elif|if|while|until|!|\{)$/.test(w)) i++
    else if (w === 'timeout' || w === 'xargs') {
      // Their options (some take a value), then timeout's duration: the command follows.
      const takesValue = w === 'timeout' ? /^(-s|-k|--signal|--kill-after)$/ : /^(-[nLPIdaSsE]|--max-args|--max-procs|--replace|--delimiter|--arg-file)$/
      i++
      while (i < words.length && words[i]!.startsWith('-')) i += takesValue.test(words[i]!) ? 2 : 1
      if (w === 'timeout') i++
    } else break
  }
  return words.slice(i)
}

/**
 * Where a path lands from `dir`: absolute as is, `~`/`$HOME` from `home`,
 * relative joined to `dir`. '' when it cannot tell (an unknown start, another
 * variable, `cd -`).
 */
export function resolvePath(dir: string, target: string | undefined, home = ''): string {
  let t = target ?? (home || '')
  if (t === '~' || t === '$HOME' || t === '${HOME}') t = home
  else if (/^(~|\$HOME|\$\{HOME\})\//.test(t)) t = home ? `${home}/${t.replace(/^[^/]+\//, '')}` : ''
  if (!t || t === '-' || t.includes('$') || t.startsWith('~')) return ''
  if (!t.startsWith('/')) {
    if (!dir) return ''
    t = `${dir}/${t}`
  }
  const parts: string[] = []
  for (const p of t.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

function base(word: string | undefined): string {
  return (word ?? '').split('/').pop() ?? ''
}

/** Value of a long/short option in either `--opt=v`, `--opt v`, `-o v` or `-ov` form. */
function option(words: readonly string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === `--${long}`) return words[i + 1]
    if (w.startsWith(`--${long}=`)) return w.slice(long.length + 3)
    if (short && w === `-${short}`) return words[i + 1]
    if (short && w.startsWith(`-${short}`) && w.length > 2 && !w.startsWith('--')) return w.slice(2)
  }
  return undefined
}

// sbatch options that take no value; any other short option takes the next word.
const SBATCH_FLAGS = /^(--parsable|--wait|-W|--hold|-H|--requeue|--no-requeue|--test-only|--exclusive|--quiet|-Q|--verbose|-v+|--overcommit|-O|--contiguous|--spread-job|--use-min-nodes|--ignore-pbs|--get-user-env|--export-file|--no-kill|-k|--oversubscribe|-s)$/

/** The batch script an sbatch command line names, or undefined (none, or --wrap). */
export function sbatchScript(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (w === '--wrap' || w.startsWith('--wrap=')) return undefined
    if (w.startsWith('--')) {
      if (!w.includes('=') && !SBATCH_FLAGS.test(w)) i++
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      if (w.length === 2 && !SBATCH_FLAGS.test(w)) i++
      continue
    }
    return w
  }
  return undefined
}

/** An `#SBATCH` directive's value from a script's header. */
function directive(text: string | undefined, long: string, short: string): string | undefined {
  if (!text) return undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('#!') || !line.trim()) continue
    if (!line.startsWith('#')) break // directives end at the first command
    const m = /^#SBATCH\s+(.*)$/.exec(line)
    if (m) {
      const v = option(m[1]!.trim().split(/\s+/), long, short)
      if (v !== undefined) return v
    }
  }
  return undefined
}

const HEAVY = /^(torchrun|deepspeed|accelerate|vllm|sglang|python[\d.]*)$/
const SCRATCH_DIRS = /^\/(tmp|var\/tmp|dev\/shm)(\/|$)/

/**
 * Findings for the command with its heredoc bodies skipped: a body is a file's
 * text (`cat > job.sbatch <<EOF … torchrun … EOF`), not commands run here, and
 * a quote inside one would otherwise hide every line after it. Stripping fails
 * closed: a `<<` in quotes, a comment or arithmetic is not a heredoc, and one
 * whose terminator never comes keeps its lines.
 */
export function checkBash(command: string, ctx: GuardContext): Finding[] {
  return checkSegments(segments(command, true), ctx)
}

function checkSegments(segs: string[][], ctx: GuardContext): Finding[] {
  const findings: Finding[] = []
  let cwd = ctx.cwd

  for (let s = 0; s < segs.length; s++) {
    const words = head(segs[s]!)
    const cmd = base(words[0])
    if (!cmd) continue

    // A relative, ~ or $VAR target is not resolved here: the directory becomes unknown.
    if (cmd === 'cd' || cmd === 'pushd') cwd = resolvePath(cwd, words[1], ctx.home)

    if (cmd === 'sbatch') {
      const script = sbatchScript(words)
      const chdir = option(words, 'chdir', 'D') ?? (script !== undefined ? directive(ctx.scripts?.get(script), 'chdir', 'D') : undefined)
      const workdir = chdir ? (chdir.startsWith('/') ? chdir : '') : cwd
      if (workdir && SCRATCH_DIRS.test(workdir)) {
        findings.push({
          level: 'reject',
          rule: 'sbatch-from-tmp',
          message: `sbatch would run with working directory ${workdir}, which is node-local: the compute node cannot see the login node's copy, so the job starts in an empty directory and fails or writes output nowhere you can read. Stage the script and data under /home, /projects or /data and submit from there.`,
        })
      }
    }

    // A note, not a block: admins are exempt from pam_slurm_adopt, and the
    // node's own refusal already explains itself to everyone else.
    if (cmd === 'ssh' && ctx.allocatedNodes) {
      const target = words.slice(1).find(w => !w.startsWith('-') && /^(\S+@)?sprc\d+/.test(w))
      const node = target?.replace(/^\S+@/, '').replace(/\..*$/, '')
      if (node && !ctx.allocatedNodes.has(node)) {
        const held = [...ctx.allocatedNodes]
        findings.push({
          level: 'note',
          rule: 'ssh-without-allocation',
          message: `If ssh ${node} was refused: compute nodes admit only users with a running job there, and you have none on ${node}${held.length ? ` (you do on ${held.join(', ')})` : ''}. Get an allocation first (salloc), or ssh to a node your job is on.`,
        })
      }
    }

    if (ctx.isLoginNode && HEAVY.test(cmd)) {
      const isLaunch =
        cmd === 'torchrun' ||
        cmd === 'deepspeed' ||
        (cmd === 'accelerate' && words[1] === 'launch') ||
        ((cmd === 'vllm' || cmd === 'sglang') && words[1] === 'serve') ||
        (cmd.startsWith('python') && words.includes('-m') && /^(torch\.distributed\.(run|launch)|vllm\.entrypoints|sglang\.launch_server)/.test(words[words.indexOf('-m') + 1] ?? ''))
      const wrapped = segs.slice(0, s).some(p => /^(srun|salloc|sbatch)$/.test(base(head(p)[0])))
      if (isLaunch && !wrapped) {
        findings.push({
          level: 'reject',
          rule: 'gpu-work-on-login-node',
          message: `\`${words.slice(0, 3).join(' ')}\` would run on the login node sprlab005, which has no GPUs and is shared by everyone. Run it through sbatch, or inside an salloc/srun allocation.`,
        })
      }
    }

    if (cmd === 'sacct' && words.includes('--json')) {
      findings.push({
        level: 'note',
        rule: 'sacct-json-mem',
        message: 'Note: on this cluster sacct --json omits memory used (MaxRSS). For efficiency numbers use text sacct (-P -o ...MaxRSS...) or the sprc_job tool.',
      })
    }
  }

  return findings
}

/**
 * The batch scripts a command line submits, each with the path to read it
 * at (following `cd` to absolute directories; '' where it cannot tell).
 */
export function sbatchScripts(command: string, cwd: string, home = ''): { script: string; path: string }[] {
  const out: { script: string; path: string }[] = []
  // The same reading as checkBash: heredoc bodies are text, not commands.
  for (const segs of [segments(command, true)]) {
    let dir = cwd
    for (const seg of segs) {
      const words = head(seg)
      const cmd = base(words[0])
      if (cmd === 'cd' || cmd === 'pushd') dir = resolvePath(dir, words[1], home)
      if (cmd !== 'sbatch') continue
      const script = sbatchScript(words)
      if (script === undefined || out.some(o => o.script === script)) continue
      out.push({ script, path: resolvePath(dir, script, home) })
    }
  }
  return out
}

/**
 * The scripts a command line runs, each with the path to read it at: `bash x.sh`,
 * `sh`/`zsh`/`source`/`.`, `./x.sh` or any path run as a command, and
 * `python x.py`. A wrapper like these may call sbatch itself.
 */
export function scriptsRun(command: string, cwd: string, home = ''): string[] {
  const out: string[] = []
  const at = (p: string) => resolvePath(cwd, p, home)
  for (const seg of segments(command, true)) {
    const words = head(seg)
    const cmd = base(words[0])
    if (cmd === 'cd' || cmd === 'pushd') cwd = resolvePath(cwd, words[1], home)
    let script: string | undefined
    if (/^(bash|sh|zsh|source|\.)$/.test(cmd) || /^python[\d.]*$/.test(cmd)) {
      if (words.some(w => w === '-c' || w === '-m' || w === '-')) continue
      script = words.slice(1).find(w => !w.startsWith('-'))
    } else if (words[0]?.includes('/')) {
      script = words[0]
    }
    if (script) {
      const path = at(script)
      if (path) out.push(path)
    }
  }
  return [...new Set(out)]
}

/** Whether a command line runs sbatch (also inside `$( )`, a loop or a pipeline). */
export function runsSbatch(command: string): boolean {
  return (
    segments(command, true).some(words => base(head(words)[0]) === 'sbatch') ||
    // Inside a backquote or `$( )` (also within double quotes), `eval`, or `sh -c "…"`.
    /(`|\$\(|\beval\s+["']?|\b(?:ba|z)?sh\s+-c\s+["']?)\s*sbatch\b/.test(command)
  )
}

/**
 * Job ids a Bash result announced: "Submitted batch job 123", or a bare
 * "123" / "123;cluster" line from sbatch --parsable.
 */
export function submittedJobs(output: string, isParsable = false): string[] {
  const ids = new Set<string>()
  if (isParsable) for (const m of output.matchAll(/^(\d+)(?:;\S+)?$/gm)) ids.add(m[1]!)
  for (const m of output.matchAll(/Submitted batch job (\d+)/g)) ids.add(m[1]!)
  return [...ids]
}
