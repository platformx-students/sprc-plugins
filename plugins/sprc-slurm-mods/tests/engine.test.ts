// The mod against a fake cluster: process.run answered by the test's hook,
// which sits beneath the plugin where the host would be.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SINFO =
  'sprc00|mixed|gpu:h100_nvl:2|gpu:h100_nvl:0(IDX:N/A)|60/68/0/128|53248|1500000|\n' +
  'sprc01|allocated|gpu:h100_nvl:2|gpu:h100_nvl:2(IDX:0-1)|128/0/0/128|434176|1500000|\n'

const row = (id: string, user: string, st: string, name: string, extra = '') =>
  `${id}|${user}|${st}|4:58|45:00|cpu=8,mem=12G,node=1${extra}|${st === 'PD' ? 'Priority' : 'None'}|normal|main|${st === 'R' ? 'sprc01' : ''}|2026-10-01T16:26:44|${name}|`

const sacctRow = (id: string, name: string, state = 'COMPLETED', exit = '0:0', elapsed = '00:10:00') =>
  `${id}|${name}|${state}|${exit}|${elapsed}|00:45:00|8|00:40:00|12G|3000M|cpu=8,mem=12G,node=1|x|sprc01|me`

type Cluster = {
  queue: string[]
  sacct: string[]
  cluster: string
  calls: string[][]
  toasts: string[]
  prompts: string[]
  bashOutput: Record<string, string>
  /** Files the mod may read (scripts a command runs). */
  files: Record<string, string>
  /** Tools the mod registered. */
  tools: string[]
  /** What the next sbatch puts in the queue. */
  onBash?: (command: string) => void
}

function fakeCluster(on: On, c: Cluster) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { USER: 'me' })
  on('tool.call', ($, e) => {
    const command = (e as { command?: string }).command ?? ''
    c.onBash?.(command)
    const out = c.bashOutput[command] ?? ''
    return { result: out, text: out } as never
  })
  // The host side of the rest of what the mod calls.
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    c.tools.push(e.name)
    return { value: { tool: `mcp__sprc-slurm-mods__${e.name}` } }
  })
  on('session.cwd', () => ({ value: '/home/me/proj' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    c.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const path = (e as { path?: string }).path ?? ''
    if (path in c.files) return { value: c.files[path] } as never
    throw new Error('ENOENT')
  })
  on('prompt.submit', ($, e) => {
    c.prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, ...answer(e.argv, e.init?.timeoutMs) } }))
  function answer(argv: readonly string[], timeoutMs?: number) {
    c.calls.push([...argv])
    if (timeoutMs !== undefined && timeoutMs > 600_000) throw new Error('timeoutMs over ten minutes')
    const [cmd] = argv
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    const has = (a: string) => argv.includes(a)
    const pick = (ids: string) => ids.split(',')
    if (cmd === 'hostname') return ok('sprlab005\n')
    if (cmd === 'scontrol' && argv[1] === 'show' && argv[2] === 'config') return ok(`ClusterName             = ${c.cluster}\n`)
    if (cmd === 'squeue' && has('-j') && has('%u')) {
      const id = argv[argv.indexOf('-j') + 1]!
      return ok(c.queue.filter(l => l.startsWith(`${id}|`) || l.startsWith(`${id}_`)).map(l => l.split('|')[1] + '\n').join(''))
    }
    // Fields by position in row(): 0 id, 1 user, 10 submit, 11 name.
    const mine = () => c.queue.filter(l => l.split('|')[1] === 'me')
    if (cmd === 'squeue' && has('%F|%V')) {
      const ids = pick(argv[argv.indexOf('-j') + 1]!)
      return ok(mine().filter(l => ids.includes(l.split('|')[0]!)).map(l => `${l.split('|')[0]}|${l.split('|')[10]}\n`).join(''))
    }
    if (cmd === 'squeue' && has('%F|%j|%o|%V')) {
      return ok(mine().map(l => { const f = l.split('|'); return `${f[0]}|${f[11]}|/home/me/proj/${f[11]}.sh|${f[10]}\n` }).join(''))
    }
    if (cmd === 'squeue' && has('%F')) {
      const lines = c.queue.filter(l => !has('--me') || l.split('|')[1] === 'me')
      return ok(lines.map(l => /^\d+/.exec(l)![0] + '\n').join(''))
    }
    if (cmd === 'squeue') return ok(c.queue.join('\n') + '\n')
    if (cmd === 'sinfo') return ok(SINFO)
    if (cmd === 'sacct') {
      const ids = pick(argv[argv.indexOf('-j') + 1]!)
      return ok(c.sacct.filter(l => ids.some(id => l.startsWith(`${id}|`) || l.startsWith(`${id}_`) || l.startsWith(`${id}.`))).join('\n') + '\n')
    }
    if (cmd === 'scontrol') return { exitCode: 1, stdout: '', stderr: 'Invalid job id' }
    return { exitCode: 127, stdout: '', stderr: `no ${cmd}` }
  }
}

function newCluster(): Cluster {
  return {
    queue: [row('80240', 'me', 'R', 'campaign-a'), row('80255', 'me', 'PD', 'campaign-b'), row('80263', 'other', 'PD', 'someone', ',gres/gpu=1')],
    sacct: [],
    cluster: 'sprc',
    calls: [],
    toasts: [],
    prompts: [],
    bashOutput: {},
    files: {},
    tools: [],
  }
}

const T0 = Date.parse('2026-10-01T17:00:00Z')
// squeue's submit times (local, no zone): one well after T0 in any zone, one long before.
const NEW = '2026-10-03T00:00:00'
const OLD = '2026-09-01T00:00:00'
const at = (line: string, submit: string) => line.replace('2026-10-01T16:26:44', submit)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = ($: any) => $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: false })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bash = ($: any, command: string, extra: object = {}) => $.tool.call({ tool: 'Bash', command, ...extra } as never)
const text = (r: unknown) => String((r as { result?: unknown }).result)

describe('on a fake cluster', () => {
  test('sprc_status reports free GPUs and my jobs, not others\' names', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    const out = text(await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_status' } as never))
    expect(out).toContain('2/4 GPUs free for a default GPU job')
    expect(out).toContain('80240 R')
    expect(out).toContain('behind higher-priority jobs')
    expect(out).not.toContain('someone')
  })

  test('commands that worked before the mod still work: poll loops and interactive scavenger', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    const loop = 'while squeue -h -j 5 | grep -q .; do sleep 30; done; sacct -j 5'
    expect(JSON.stringify(await bash($, loop, { run_in_background: true }))).not.toContain('deny')
    expect(JSON.stringify(await bash($, 'salloc --qos=scavenger --gpus=1'))).not.toContain('deny')
  })

  test('GPU launchers on the login node are still blocked', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    expect(JSON.stringify(await bash($, 'torchrun --nproc-per-node=2 train.py'))).toContain('login node')
  })

  test('another Slurm cluster gets nothing', async ($, on) => {
    const c = { ...newCluster(), cluster: 'elsewhere' }
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    expect(c.calls.some(x => x[0] === 'squeue' || x[0] === 'sinfo')).toBe(false)
    expect(JSON.stringify(await bash($, 'torchrun train.py'))).not.toContain('login node')
  })

  test('jobs from one sbatch loop are one group: one message once all have ended', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    const cmd = 'for s in 1 2 3 4; do sbatch run.sh $s; done'
    c.bashOutput[cmd] = [1, 2, 3, 4].map(i => `Submitted batch job 9100${i}`).join('\n')
    c.onBash = command => {
      if (command === cmd) for (const i of [1, 2, 3, 4]) c.queue.push(row(`9100${i}`, 'me', 'PD', `sweep-${i}`))
    }
    const r = await bash($, cmd)
    expect(JSON.stringify(r)).toContain('Following 91001–91004 as a group')

    // Two end: nothing is said yet.
    c.queue = c.queue.filter(l => !/^9100[12]\|/.test(l))
    c.sacct.push(sacctRow('91001', 'sweep-1'), sacctRow('91002', 'sweep-2', 'FAILED', '1:0', '00:00:30'))
    await clock.advance(31_000)
    expect(c.prompts).toEqual([])

    // The rest end: one wake with all four.
    c.queue = c.queue.filter(l => !/^9100[34]\|/.test(l))
    c.sacct.push(sacctRow('91003', 'sweep-3'), sacctRow('91004', 'sweep-4'))
    await clock.advance(31_000)
    expect(c.prompts.length).toBe(1)
    expect(c.prompts[0]).toContain('4 jobs ended (91001–91004): 3 COMPLETED, 1 FAILED')
    expect(c.prompts[0]).toContain('91002 FAILED exit 1:0')
    expect(c.toasts.some(t => t.includes('4 jobs ended: 3 ok, 1 failed'))).toBe(true)
    // One sacct call per poll, not one per job.
    expect(c.calls.filter(x => x[0] === 'sacct').length).toBeLessThanOrEqual(2)
  })

  test('an array job is reported once, summarised over its tasks', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    const cmd = 'sbatch --array=1-10 sweep.sh'
    c.bashOutput[cmd] = 'Submitted batch job 900'
    c.onBash = command => {
      if (command === cmd) c.queue.push(row('900_1', 'me', 'R', 'sw'), row('900_2', 'me', 'R', 'sw'), row('900_[3-10]', 'me', 'PD', 'sw'))
    }
    await bash($, cmd)
    // Tasks come and go; the pending range shrinks. None of that is an end.
    c.queue = c.queue.filter(l => !l.startsWith('900_1|') && !l.startsWith('900_[')).concat(row('900_3', 'me', 'R', 'sw'), row('900_[4-10]', 'me', 'PD', 'sw'))
    await clock.advance(31_000)
    expect(c.prompts).toEqual([])
    expect(c.toasts.some(t => t.startsWith('▶ job 900 started'))).toBe(true)

    c.queue = c.queue.filter(l => !l.startsWith('900_'))
    for (let i = 1; i <= 10; i++) c.sacct.push(sacctRow(`900_${i}`, 'sw', i === 7 ? 'OUT_OF_MEMORY' : 'COMPLETED', i === 7 ? '0:125' : '0:0'))
    await clock.advance(31_000)
    expect(c.prompts.length).toBe(1)
    expect(c.prompts[0]).toContain('array 900 "sw" (10 tasks: 9 COMPLETED, 1 OUT_OF_MEMORY)')
    expect(c.prompts[0]).toContain('900_7 OUT_OF_MEMORY')
    expect(c.prompts[0]).toContain('--mem=')
  })

  test('JID=$(sbatch --parsable …) prints nothing, and the job is still followed', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    const cmd = 'JID=$(sbatch --parsable job.sh)'
    c.onBash = command => {
      if (command === cmd) c.queue.push(row('95001', 'me', 'PD', 'quiet'))
    }
    const r = await bash($, cmd)
    expect(JSON.stringify(r)).toContain('Following 95001')
  })

  test('there is no blocking wait tool: every submission is followed instead', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    expect(c.tools).toContain('sprc_follow')
    expect(c.tools).not.toContain('sprc_wait')
  })

  test('sbatch after a heredoc whose body has a stray quote is followed', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    const cmd = "python3 - <<'EOF'\nprint(\"it's done\")\nEOF\ncd /home/me/proj && sbatch --parsable fig.sbatch"
    c.bashOutput[cmd] = "it's done\n96001"
    c.onBash = command => {
      if (command === cmd) c.queue.push(at(row('96001', 'me', 'PD', 'fig'), NEW))
    }
    expect(JSON.stringify(await bash($, cmd))).toContain('Following 96001')
  })

  test('a wrapper script that calls sbatch silently is followed', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    c.files['/home/me/proj/e2e/submit.sh'] = '#!/bin/sh\nJID=$(sbatch --parsable run.sbatch)\n'
    const cmd = 'JOB_NAME=x sh e2e/submit.sh --go'
    c.onBash = command => {
      if (command === cmd) c.queue.push(at(row('96002', 'me', 'PD', 'x'), NEW))
    }
    expect(JSON.stringify(await bash($, cmd))).toContain('Following 96002')
  })

  test("sbatch's line printed by any command is followed only for a job submitted while it ran", async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    c.queue.push(at(row('96003', 'me', 'PD', 'made'), NEW), at(row('70001', 'me', 'R', 'old'), OLD))
    c.bashOutput['make submit'] = 'Submitted batch job 96003'
    c.bashOutput['tail logs/run.out'] = 'Submitted batch job 70001'
    expect(JSON.stringify(await bash($, 'make submit'))).toContain('Following 96003')
    expect(JSON.stringify(await bash($, 'tail logs/run.out'))).not.toContain('Following')
  })

  test('a background command that submits is followed from the queue, and reported once', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    const cmd = 'sleep 120; sbatch train.sh'
    const r = await bash($, cmd, { run_in_background: true })
    expect(JSON.stringify(r)).toContain('followed as they reach the queue')
    // Someone else's session's job (another name) is not adopted; this one is.
    c.queue.push(at(row('96004', 'me', 'PD', 'train'), NEW), at(row('96005', 'me', 'PD', 'unrelated'), NEW))
    await clock.advance(31_000)
    expect(text(await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_status' } as never))).toContain('96004')
    c.queue = c.queue.filter(l => !l.startsWith('96004|'))
    c.sacct.push(sacctRow('96004', 'train'))
    await clock.advance(31_000)
    await clock.advance(31_000)
    expect(c.prompts.length).toBe(1)
    expect(c.prompts[0]).toContain('96004')
    expect(c.prompts[0]).not.toContain('96005')
  })

  test('following someone else\'s job is refused, and an ended one answers at once', async ($, on) => {
    const c = newCluster()
    fakeCluster(on, c)
    mock.clock(on, { now: T0 })
    await start($)
    expect(text(await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_follow', job_id: '80263' } as never))).toContain('not yours')
    c.sacct.push(sacctRow('70000', 'old'))
    expect(text(await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_follow', job_id: '70000' } as never))).toContain('already ended')
  })
})
