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

/** Splits a command line into simple commands on ;, &&, ||, |, newlines. Quote-aware. */
export function segments(command: string): string[][] {
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
    else break
  }
  return words.slice(i)
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

export function checkBash(command: string, ctx: GuardContext): Finding[] {
  const findings: Finding[] = []
  let cwd = ctx.cwd
  const segs = segments(command)

  for (let s = 0; s < segs.length; s++) {
    const words = head(segs[s]!)
    const cmd = base(words[0])
    if (!cmd) continue

    // A relative, ~ or $VAR target is not resolved here: the directory becomes unknown.
    if (cmd === 'cd' || cmd === 'pushd') cwd = words[1]?.startsWith('/') ? words[1] : ''

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
export function sbatchScripts(command: string, cwd: string): { script: string; path: string }[] {
  const out: { script: string; path: string }[] = []
  for (const seg of segments(command)) {
    const words = head(seg)
    const cmd = base(words[0])
    if (cmd === 'cd' || cmd === 'pushd') cwd = words[1]?.startsWith('/') ? words[1] : ''
    if (cmd !== 'sbatch') continue
    const script = sbatchScript(words)
    if (script === undefined) continue
    out.push({ script, path: script.startsWith('/') ? script : cwd && !/^[~$]/.test(script) ? `${cwd}/${script}` : '' })
  }
  return out
}

/** Whether a command line runs sbatch (also inside `$( )`, a loop or a pipeline). */
export function runsSbatch(command: string): boolean {
  return segments(command).some(words => base(head(words)[0]) === 'sbatch') || /`\s*sbatch\b/.test(command)
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
