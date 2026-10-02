// Checks on Bash commands before they run. Pure: the hook passes in what it
// knows about the session and the cluster.
//
// `reject` findings are things the cluster itself would refuse or that
// silently break (so blocking them never costs a working command).
// `nudge` findings are wasteful patterns with a better path in this mod.
// `note` findings never block; they ride along as context for the model.

export type Finding = { level: 'reject' | 'nudge' | 'note'; rule: string; message: string }

export type GuardContext = {
  /** The session's working directory, where a bare command runs; '' = unknown. */
  cwd: string
  /** Nodes where this user holds a running allocation right now; null = unknown. */
  allocatedNodes: ReadonlySet<string> | null
  /** True when the session runs on the login node (sprlab005). */
  isLoginNode: boolean
  /** Name of the wait tool to point at. */
  waitTool: string
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

/** Drops leading VAR=value assignments and wrappers like `env`, `time`, `nohup`. */
function head(words: readonly string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (w === 'env' || w === 'time' || w === 'nohup' || w === 'exec' || w === 'command') i++
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

    if (cmd === 'salloc' || cmd === 'srun') {
      const qos = option(words, 'qos', 'q')
      if (qos === 'scavenger') {
        findings.push({
          level: 'reject',
          rule: 'scavenger-interactive',
          message: `${cmd} --qos=scavenger is rejected on sprc: scavenger is batch-only. Submit it with sbatch --qos=scavenger (and make it checkpoint/requeue), or use the default QoS for an interactive session.`,
        })
      }
    }

    if (cmd === 'sbatch') {
      const chdir = option(words, 'chdir', 'D')
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

  // Sleep-and-poll loops burn turns and tokens; the wait tool blocks once.
  const text = command.replace(/\s+/g, ' ')
  const polls = /\b(squeue|sacct|scontrol)\b/.test(text)
  const sleeps = /\bsleep\s+\d+/.test(text) || /\bwatch\b/.test(text)
  const loops = /\b(while|until|for)\b/.test(text) || /\bwatch\b/.test(text)
  if (polls && sleeps && loops) {
    findings.push({
      level: 'nudge',
      rule: 'poll-loop',
      message: `Don't poll Slurm in a sleep loop. Call ${ctx.waitTool} with the job id: it waits (up to 10 min per call) and returns when the job changes state. To be told when a long job finishes, call sprc_follow instead and stop.`,
    })
  }

  return findings
}

/**
 * Job ids a Bash result announced ("Submitted batch job 123", "Granted job
 * allocation 123", or a bare "123" / "123;cluster" line from sbatch --parsable).
 */
export function submittedJobs(output: string, isParsable = false): string[] {
  const ids = new Set<string>()
  if (isParsable) for (const m of output.matchAll(/^(\d+)(?:;\S+)?$/gm)) ids.add(m[1]!)
  for (const m of output.matchAll(/Submitted batch job (\d+)/g)) ids.add(m[1]!)
  for (const m of output.matchAll(/Granted job allocation (\d+)/g)) ids.add(m[1]!)
  return [...ids]
}
