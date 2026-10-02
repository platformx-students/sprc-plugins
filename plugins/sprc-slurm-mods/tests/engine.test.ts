// The mod against a fake cluster: process.run answered by the test's hook,
// which sits beneath the plugin where the host would be.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SINFO =
  'sprc00|mixed|gpu:h100_nvl:2|gpu:h100_nvl:0(IDX:N/A)|60/68/0/128|53248|1500000|\n' +
  'sprc01|allocated|gpu:h100_nvl:2|gpu:h100_nvl:2(IDX:0-1)|128/0/0/128|434176|1500000|\n'

let queue =
  '80240|me|R|4:58|45:00|cpu=8,mem=12G,node=1,billing=8|None|normal|main|sprc01|2026-10-01T16:26:44|campaign-a|\n' +
  '80255|me|PD|0:00|45:00|cpu=8,mem=12G,node=1|Priority|normal|main||2026-10-01T17:10:31|campaign-b|\n' +
  '80263|other|PD|0:00|2:30:00|cpu=16,mem=128G,node=1,gres/gpu=1|Resources|normal|main||N/A|someone|\n'

export const logs: string[] = []
let cluster = 'sprc'
export const toasts: string[] = []

function fakeCluster(on: On, calls: string[][]) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { USER: 'me' })
  mock.clock(on, { now: Date.parse('2026-10-01T17:00:00Z') })
  on('tool.call', () => ({ result: 'ran' }))
  // The host side of the rest of what the mod calls.
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__sprc-slurm-mods__${e.name}` } }))
  on('session.cwd', () => ({ value: '/home/me/proj' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, ...answer(e.argv) } }))
  function answer(argv: readonly string[]) {
    const e = { argv }
    calls.push([...e.argv])
    const [cmd] = e.argv
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    if (cmd === 'hostname') return ok('sprlab005\n')
    if (cmd === 'scontrol' && e.argv[1] === 'show' && e.argv[2] === 'config') return ok(`ClusterName             = ${cluster}\n`)
    if (cmd === 'squeue' && e.argv.includes('--me')) return ok('sprc01\n')
    if (cmd === 'squeue' && e.argv.includes('-j')) {
      const id = e.argv[e.argv.indexOf('-j') + 1]
      return ok(queue.split('\n').filter(l => l.startsWith(`${id}|`)).map(l => l.split('|')[1] + '\n').join(''))
    }
    if (cmd === 'squeue') return ok(queue)
    if (cmd === 'sinfo') return ok(SINFO)
    if (cmd === 'mybudget') return { exitCode: 1, stdout: 'This account is not enrolled', stderr: '' }
    if (cmd === 'sacct')
      return ok('80240|campaign-a|COMPLETED|0:0|00:10:00|00:45:00|8|00:40:00|12G|3000M|cpu=8,mem=12G,node=1|x|sprc01\n')
    if (cmd === 'scontrol') return { exitCode: 1, stdout: '', stderr: 'Invalid job id' }
    return { exitCode: 127, stdout: '', stderr: `no ${cmd}` }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = ($: any) => $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: false })

describe('on a fake cluster', () => {
  test('sprc_status reports free GPUs and my jobs', async ($, on) => {
    const calls: string[][] = []
    fakeCluster(on, calls)
    await start($)
    const r = await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_status' } as never)
    const text = String((r as { result?: unknown }).result)
    expect(logs).toEqual([])
    expect(text).toContain('2/4 GPUs free for a default GPU job')
    expect(text).toContain('80240 R')
    expect(text).toContain('waiting behind higher-priority jobs')
    expect(text).not.toContain('someone') // other users' job names stay out
  })

  test('the Bash guard denies interactive scavenger', async ($, on) => {
    fakeCluster(on, [])
    await start($)
    const r = await $.tool.call({ tool: 'Bash', command: 'salloc --qos=scavenger --gpus=1' } as never)
    expect(JSON.stringify(r)).toContain('batch-only')
  })

  test('another Slurm cluster gets nothing', async ($, on) => {
    cluster = 'elsewhere'
    try {
      const calls: string[][] = []
      fakeCluster(on, calls)
      await start($)
      expect(calls.some(c => c[0] === 'squeue' || c[0] === 'sinfo')).toBe(false)
      const r = await $.tool.call({ tool: 'Bash', command: 'salloc --qos=scavenger --gpus=1' } as never)
      expect(JSON.stringify(r)).not.toContain('batch-only')
    } finally {
      cluster = 'sprc'
    }
  })

  test('following someone else\'s job is refused', async ($, on) => {
    fakeCluster(on, [])
    await start($)
    const r = await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_follow', job_id: '80263' } as never)
    expect(String((r as { result?: unknown }).result)).toContain('not yours')
  })

  test('a followed job that leaves the queue lands in finished with advice', async ($, on) => {
    const calls: string[][] = []
    fakeCluster(on, calls)
    await start($)
    await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_follow', job_id: '80240' } as never)
    queue = queue.split('\n').filter(l => !l.startsWith('80240')).join('\n')
    const r = await $.tool.call({ tool: 'mcp__sprc-slurm-mods__sprc_status' } as never)
    const text = String((r as { result?: unknown }).result)
    expect(text).toContain('job 80240 (campaign-a) COMPLETED')
    expect(text).toContain('--mem=4G')
    expect(toasts).toContain('✓ job 80240 COMPLETED (00:10:00)')
  })
})
