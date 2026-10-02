import { describe, expect, test } from 'claude-code/testing'

import { checkBash, segments, submittedJobs } from '../hooks/guards'
import type { GuardContext } from '../hooks/guards'
import {
  buildReport,
  durationSeconds,
  expandNodes,
  gpuTotals,
  hasJob,
  parseSacct,
  parseScontrol,
  parseSinfo,
  parseSqueue,
} from '../hooks/slurm'

const ctx: GuardContext = {
  cwd: '/home/me/proj',
  allocatedNodes: new Set(['sprc02']),
  isLoginNode: true,
  waitTool: 'mcp__sprc-slurm-mods__sprc_wait',
}
const rules = (cmd: string, c = ctx) => checkBash(cmd, c).map(f => f.rule)

describe('guards', () => {
  test('scavenger is batch-only', () => {
    expect(rules('salloc --qos=scavenger --gpus=1')).toEqual(['scavenger-interactive'])
    expect(rules('srun -q scavenger --pty bash')).toEqual(['scavenger-interactive'])
    expect(rules('sbatch --qos=scavenger job.sbatch')).toEqual([])
  })
  test('sbatch from node-local scratch', () => {
    expect(rules('cd /tmp/x && sbatch job.sbatch')).toEqual(['sbatch-from-tmp'])
    expect(rules('sbatch job.sbatch', { ...ctx, cwd: '/tmp' })).toEqual(['sbatch-from-tmp'])
    expect(rules('sbatch --chdir=/home/me job.sbatch', { ...ctx, cwd: '/tmp' })).toEqual([])
    expect(rules('sbatch /tmp/job.sbatch')).toEqual([])
    // A cd this cannot resolve leaves the directory unknown, so no block.
    expect(rules('cd ~/proj && sbatch job.sbatch', { ...ctx, cwd: '/tmp/x' })).toEqual([])
    expect(rules('cd $HOME && sbatch job.sbatch', { ...ctx, cwd: '/tmp/x' })).toEqual([])
    expect(rules('sbatch -D out job.sbatch', { ...ctx, cwd: '/tmp/x' })).toEqual([])
  })
  test('ssh needs an allocation on that node', () => {
    expect(rules('ssh sprc01 nvidia-smi')).toEqual(['ssh-without-allocation'])
    expect(rules('ssh sprc02 nvidia-smi')).toEqual([])
    expect(rules('ssh sprc01', { ...ctx, allocatedNodes: null })).toEqual([])
    // Admins are exempt on the nodes, so this never blocks.
    expect(checkBash('ssh sprc01 nvidia-smi', ctx).map(f => f.level)).toEqual(['note'])
  })
  test('GPU launches on the login node', () => {
    expect(rules('torchrun --nproc-per-node=2 train.py')).toEqual(['gpu-work-on-login-node'])
    expect(rules('CUDA_VISIBLE_DEVICES=0 accelerate launch train.py')).toEqual(['gpu-work-on-login-node'])
    expect(rules('srun --gpus=2 torchrun train.py')).toEqual([])
    expect(rules('python analyze.py')).toEqual([])
    expect(rules('accelerate config')).toEqual([])
    expect(rules('torchrun train.py', { ...ctx, isLoginNode: false })).toEqual([])
  })
  test('poll loops and sacct --json', () => {
    expect(rules('while squeue -j 5 | grep -q 5; do sleep 30; done')).toEqual(['poll-loop'])
    expect(rules('watch -n 10 squeue --me')).toEqual(['poll-loop'])
    expect(rules('squeue --me; sleep 5')).toEqual([])
    expect(rules('sacct -j 5 --json')).toEqual(['sacct-json-mem'])
  })
  test('quoting and comments', () => {
    expect(segments(`echo "a; b" && sbatch 'x y'.sh # sbatch`)).toEqual([['echo', 'a; b'], ['sbatch', 'x y.sh']])
  })
  test('submitted job ids', () => {
    expect(submittedJobs('Submitted batch job 123\nSubmitted batch job 124')).toEqual(['123', '124'])
    expect(submittedJobs('salloc: Granted job allocation 77')).toEqual(['77'])
    expect(submittedJobs('82335\n', true)).toEqual(['82335'])
    expect(submittedJobs('82335;sprc\n', true)).toEqual(['82335'])
    expect(submittedJobs('82335\n')).toEqual([])
  })
})

describe('parsers', () => {
  test('durations', () => {
    expect(durationSeconds('45:00')).toBe(2700)
    expect(durationSeconds('4:00:00')).toBe(14400)
    expect(durationSeconds('1-02:00:00')).toBe(93600)
    expect(durationSeconds('01:02.500')).toBe(62.5)
    expect(Number.isNaN(durationSeconds('UNLIMITED'))).toBe(true)
  })
  test('node lists', () => {
    expect(expandNodes('sprc[00-01,03]')).toEqual(['sprc00', 'sprc01', 'sprc03'])
    expect(expandNodes('sprc02')).toEqual(['sprc02'])
    expect(expandNodes('')).toEqual([])
  })
  test('sinfo dedupes partitions', () => {
    const nodes = parseSinfo(
      'sprc00|mixed|gpu:h100_nvl:2|gpu:h100_nvl:1(IDX:0)|60/68/0/128|53248|1500000|\n' +
        'sprc00|mixed|gpu:h100_nvl:2|gpu:h100_nvl:1(IDX:0)|60/68/0/128|53248|1500000|\n',
    )
    expect(nodes).toEqual([
      { name: 'sprc00', state: 'mixed', gpus: 2, gpusUsed: 1, cpusAlloc: 60, cpusTotal: 128, memAllocMb: 53248, memTotalMb: 1500000 },
    ])
  })
  test('squeue keeps a | in the job name', () => {
    const [j] = parseSqueue('5|me|R|1:00|10:00|cpu=4,mem=8G,gres/gpu=1|None|normal|main|sprc01|2026-10-01T10:00:00|a|b|\n')
    expect(j?.name).toBe('a|b')
    expect(j?.gpus).toBe(1)
  })
  test('scontrol fields', () => {
    const f = parseScontrol('JobId=5 JobName=x y JobState=RUNNING Reason=None TRES=cpu=8,mem=12G StdOut=/h/o.out')
    expect(f['JobName']).toBe('x y')
    expect(f['TRES']).toBe('cpu=8,mem=12G')
    expect(f['StdOut']).toBe('/h/o.out')
  })
  test('efficiency report and advice', () => {
    const rows = parseSacct(
      '9|train|COMPLETED|0:0|00:20:00|04:00:00|16|01:00:00|64G||billing=16,cpu=16,mem=64G,node=1,gres/gpu=1|2026-10-01T12:00:00|sprc01\n' +
        '9.batch|batch|COMPLETED|0:0|00:20:00||16|01:00:00||6000M|cpu=16,mem=64G,node=1|2026-10-01T12:00:00|sprc01\n',
    )
    const r = buildReport('9', rows, 0)!
    expect(r.gpus).toBe(1)
    expect(Math.round((r.memEff ?? 0) * 100)).toBe(9)
    expect(r.advice.length).toBe(3) // mem, time, cpu
    expect(r.advice[0]).toContain('--mem=8G')
    expect(r.advice[1]).toContain('--time=30')
  })
  test('free GPUs need the CPUs and memory a default GPU job takes', () => {
    const node = { name: 'n', state: 'mixed', gpus: 2, gpusUsed: 0, cpusTotal: 128, memAllocMb: 0, memTotalMb: 1500000 }
    expect(gpuTotals([{ ...node, cpusAlloc: 0 }]).usable).toBe(2)
    expect(gpuTotals([{ ...node, cpusAlloc: 100 }]).usable).toBe(0) // 28 free < 32
    expect(gpuTotals([{ ...node, cpusAlloc: 80 }]).usable).toBe(1)
    expect(gpuTotals([{ ...node, cpusAlloc: 0, memAllocMb: 1200000 }]).usable).toBe(0)
    expect(gpuTotals([{ ...node, cpusAlloc: 0, state: 'drained' }]).usable).toBe(0)
  })
  test('array and het jobs match their parent id', () => {
    expect(hasJob([{ id: '123_4' }], '123')).toBe(true)
    expect(hasJob([{ id: '123+0' }], '123')).toBe(true)
    expect(hasJob([{ id: '1234' }], '123')).toBe(false)
  })
  test('a zero MaxRSS is unmeasured, not zero', () => {
    const r = buildReport('9', parseSacct('9|t|COMPLETED|0:0|00:00:45|00:02:00|4|00:00:00|256M|0|cpu=4,mem=256M|x|sprc00|me\n'), 0)!
    expect(r.memEff).toBe(undefined)
    expect(r.user).toBe('me')
  })
  test('OOM asks for more memory', () => {
    const rows = parseSacct('9|t|OUT_OF_MEMORY|0:125|00:01:00|01:00:00|4|00:03:00|8G|8100M|cpu=4,mem=8G|x|sprc01\n')
    expect(buildReport('9', rows, 0)!.advice[0]).toContain('--mem=12G')
  })
})
