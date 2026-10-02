// Slurm queries and parsers. Everything here takes a `run` function so the
// parsers are testable without a cluster; the hooks module passes
// `$.process.run`.

import type { JobReport, JobRow, NodeRow, Snapshot } from '../types'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<RunResult>

const SINFO_FIELDS = 'NodeList:|,StateLong:|,Gres:|,GresUsed:|,CPUsState:|,AllocMem:|,Memory:|'
// Name goes last so a `|` in a job name cannot shift the other columns.
const SQUEUE_FIELDS =
  'JobID:|,UserName:|,StateCompact:|,TimeUsed:|,TimeLimit:|,tres-alloc:|,Reason:|,QOS:|,Partition:|,NodeList:|,StartTime:|,Name:|'

export const SACCT_FIELDS =
  'JobID,JobName,State,ExitCode,Elapsed,Timelimit,NCPUS,TotalCPU,ReqMem,MaxRSS,AllocTRES,End,NodeList,User'

// ---- parsing helpers ---------------------------------------------------

/** "gpu:h100_nvl:2" or "gpu:h100_nvl:1(IDX:0)" -> 2 / 1 */
export function gresCount(gres: string): number {
  let total = 0
  for (const part of gres.split(',')) {
    const m = /gpu(?::[\w.-]+)?:(\d+)/.exec(part)
    if (m) total += Number(m[1])
  }
  return total
}

/** "cpu=8,mem=12G,node=1,gres/gpu=1" -> { cpu: "8", mem: "12G", ... } */
export function parseTres(tres: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of tres.split(',')) {
    const i = kv.indexOf('=')
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

/** "[D-]HH:MM:SS", "MM:SS", "MM:SS.mmm", "UNLIMITED" -> seconds (NaN if unknown) */
export function durationSeconds(s: string): number {
  if (!s || s === 'UNLIMITED' || s === 'Partition_Limit' || s === 'INVALID') return NaN
  let days = 0
  let rest = s
  const dash = s.indexOf('-')
  if (dash >= 0) {
    days = Number(s.slice(0, dash))
    rest = s.slice(dash + 1)
  }
  const parts = rest.split(':').map(Number)
  if (parts.some(Number.isNaN)) return NaN
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  if (parts.length === 2 && dash < 0) {
    // MM:SS
  } else if (parts.length === 1) {
    secs = parts[0]! * 60 // bare minutes, as sbatch --time takes them
  }
  return days * 86400 + secs
}

export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs)) return '?'
  secs = Math.max(0, Math.round(secs))
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${secs}s`
}

/** "12G", "500M", "123456K", "12Gn" -> MiB (NaN if unknown) */
export function memMb(s: string): number {
  const m = /^([\d.]+)([KMGT]?)/i.exec(s.trim())
  if (!m) return NaN
  const n = Number(m[1])
  switch ((m[2] ?? '').toUpperCase()) {
    case 'K':
      return n / 1024
    case 'G':
      return n * 1024
    case 'T':
      return n * 1024 * 1024
    case 'M':
      return n
    default:
      return n / (1024 * 1024) // bytes
  }
}

export function formatMem(mb: number): string {
  if (!Number.isFinite(mb)) return '?'
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)}G`
  return mb > 0 && mb < 1 ? '<1M' : `${Math.round(mb)}M`
}

/** "sprc[00-01,03],sprc05" -> ["sprc00","sprc01","sprc03","sprc05"] */
export function expandNodes(list: string): string[] {
  const out: string[] = []
  const re = /([^,[\]]+)(?:\[([^\]]+)\])?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list)) !== null) {
    const prefix = m[1]!
    if (!m[2]) {
      if (prefix && prefix !== '(null)') out.push(prefix)
      continue
    }
    for (const range of m[2].split(',')) {
      const [a, b] = range.split('-')
      if (b === undefined) {
        out.push(prefix + a)
        continue
      }
      const width = a!.length
      for (let i = Number(a); i <= Number(b); i++) out.push(prefix + String(i).padStart(width, '0'))
    }
  }
  return out
}

// ---- cluster snapshot --------------------------------------------------

export function parseSinfo(stdout: string): NodeRow[] {
  const seen = new Map<string, NodeRow>()
  for (const line of stdout.split('\n')) {
    const f = line.split('|')
    if (f.length < 7 || !f[0]) continue
    const name = f[0].trim()
    if (seen.has(name)) continue // one row per partition the node is in
    const [alloc, , , total] = (f[4] ?? '').split('/').map(Number)
    seen.set(name, {
      name,
      state: (f[1] ?? '').trim(),
      gpus: gresCount(f[2] ?? ''),
      gpusUsed: gresCount((f[3] ?? '').replace(/\(IDX:[^)]*\)/g, '')),
      cpusAlloc: alloc ?? 0,
      cpusTotal: total ?? 0,
      memAllocMb: Number(f[5]) || 0,
      memTotalMb: Number(f[6]) || 0,
    })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function parseSqueue(stdout: string): JobRow[] {
  const rows: JobRow[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const f = line.split('|')
    if (f.length < 12) continue
    const tres = parseTres(f[5] ?? '')
    rows.push({
      id: f[0]!.trim(),
      user: f[1]!.trim(),
      state: f[2]!.trim(),
      elapsed: f[3]!.trim(),
      limit: f[4]!.trim(),
      gpus: Number(tres['gres/gpu'] ?? 0) || 0,
      cpus: Number(tres['cpu'] ?? 0) || 0,
      mem: tres['mem'] ?? '?',
      reason: f[6]!.trim(),
      qos: f[7]!.trim(),
      partition: f[8]!.trim(),
      nodes: f[9]!.trim(),
      start: f[10]!.trim(),
      name: f.slice(11).join('|').replace(/\|$/, '').trim(),
    })
  }
  return rows
}

export async function fetchSnapshot(run: Run, user: string, now: number): Promise<Snapshot> {
  const [si, sq] = await Promise.all([
    run(['sinfo', '-h', '-N', '-O', SINFO_FIELDS]),
    run(['squeue', '-h', '-a', '-O', SQUEUE_FIELDS]),
  ])
  if (si.exitCode !== 0 || sq.exitCode !== 0) {
    return {
      at: now,
      error: (si.stderr || sq.stderr || 'sinfo/squeue failed').trim().split('\n')[0],
      nodes: [],
      mine: [],
      others: { running: 0, pending: 0, gpusRunning: 0, gpusPending: 0 },
    }
  }
  const jobs = parseSqueue(sq.stdout)
  const mine = jobs.filter(j => j.user === user)
  const others = { running: 0, pending: 0, gpusRunning: 0, gpusPending: 0 }
  for (const j of jobs) {
    if (j.user === user) continue
    if (j.state === 'R' || j.state === 'CG') {
      others.running++
      others.gpusRunning += j.gpus
    } else if (j.state === 'PD') {
      others.pending++
      others.gpusPending += j.gpus
    }
  }
  return { at: now, nodes: parseSinfo(si.stdout), mine, others }
}

// What a GPU job gets per GPU when it asks for nothing else: slurm.conf's
// DefCpuPerGPU=32, times DefMemPerCPU=12000.
export const GPU_SHARE = { cpus: 32, memMb: 32 * 12000 }

/** Idle GPUs on one node that a default 1-GPU job could actually start on. */
export function nodeUsable(n: NodeRow): number {
  if (/drain|down|fail|maint|reserved|inval/i.test(n.state)) return 0
  const byCpu = Math.floor((n.cpusTotal - n.cpusAlloc) / GPU_SHARE.cpus)
  const byMem = Math.floor((n.memTotalMb - n.memAllocMb) / GPU_SHARE.memMb)
  return Math.max(0, Math.min(n.gpus - n.gpusUsed, byCpu, byMem))
}

/**
 * `idle`: GPUs no job holds. `usable`: idle GPUs a default GPU job could
 * actually get, which excludes nodes that are down/drained or lack the CPUs
 * or memory that go with a GPU (a node full of CPU jobs strands its GPUs).
 */
export function gpuTotals(nodes: readonly NodeRow[]): { total: number; used: number; idle: number; usable: number } {
  let total = 0
  let used = 0
  let usable = 0
  for (const n of nodes) {
    total += n.gpus
    used += n.gpusUsed
    usable += nodeUsable(n)
  }
  return { total, used, idle: total - used, usable }
}

/** Whether job `id` (or, for an array or het job, any of its parts) is in `rows`. */
export function hasJob(rows: readonly { id: string }[], id: string): boolean {
  return rows.some(j => j.id === id || j.id.startsWith(`${id}_`) || j.id.startsWith(`${id}+`))
}

// ---- one job -----------------------------------------------------------

/** `scontrol show job -o ID` -> key/value fields (first record). */
export function parseScontrol(stdout: string): Record<string, string> {
  const line = stdout.split('\n').find(l => l.includes('JobId=')) ?? ''
  const out: Record<string, string> = {}
  // Values may contain spaces only in a few fields (Command, Comment); keys
  // are CamelCase words followed by '='.
  const re = /(?:^|\s)([A-Za-z][\w:/]*)=(.*?)(?=\s[A-Za-z][\w:/]*=|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out[m[1]!] = m[2]!
  return out
}

export async function fetchScontrol(run: Run, id: string): Promise<Record<string, string> | null> {
  const r = await run(['scontrol', 'show', 'job', '-o', id])
  if (r.exitCode !== 0) return null
  const f = parseScontrol(r.stdout)
  return f['JobId'] ? f : null
}

type SacctRow = Record<(typeof SACCT_COLUMNS)[number], string>
const SACCT_COLUMNS = SACCT_FIELDS.split(',') as readonly string[]

export function parseSacct(stdout: string): SacctRow[] {
  return stdout
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const f = l.split('|')
      const row: Record<string, string> = {}
      SACCT_COLUMNS.forEach((c, i) => (row[c] = f[i] ?? ''))
      return row as SacctRow
    })
}

/** Builds the efficiency report from sacct rows of one job (allocation + steps). */
export function buildReport(id: string, rows: readonly SacctRow[], endedAt: number): JobReport | null {
  const main = rows.find(r => r['JobID'] === id) ?? rows.find(r => !r['JobID']!.includes('.'))
  if (!main) return null
  const elapsed = durationSeconds(main['Elapsed']!)
  const limit = durationSeconds(main['Timelimit']!)
  const cpus = Number(main['NCPUS']) || 0
  const totalCpu = durationSeconds(main['TotalCPU']!)
  const reqMemMb = memMb(main['ReqMem']!)
  let maxRssMb = NaN
  for (const r of rows) {
    const v = memMb(r['MaxRSS'] ?? '')
    // 0 means the 30 s sampler never ran (a short job), not 0 bytes.
    if (Number.isFinite(v) && v > 0 && !(maxRssMb >= v)) maxRssMb = v
  }
  const tres = parseTres(main['AllocTRES'] ?? '')
  const gpus = Number(tres['gres/gpu'] ?? 0) || 0
  const state = (main['State'] ?? '').split(' ')[0]!
  const cpuEff = elapsed > 0 && cpus > 0 && Number.isFinite(totalCpu) ? totalCpu / (elapsed * cpus) : undefined
  const memEff = reqMemMb > 0 && Number.isFinite(maxRssMb) ? maxRssMb / reqMemMb : undefined
  const timeEff = limit > 0 && Number.isFinite(elapsed) ? elapsed / limit : undefined

  const advice: string[] = []
  if (state === 'OUT_OF_MEMORY' || (memEff !== undefined && memEff > 0.92)) {
    const want = Math.ceil(((Number.isFinite(maxRssMb) ? maxRssMb : reqMemMb) * 1.5) / 1024)
    advice.push(`memory was the limit: next time request --mem=${want}G`)
  } else if (memEff !== undefined && memEff < 0.5 && reqMemMb >= 8192) {
    const want = Math.max(4, Math.ceil((maxRssMb * 1.3) / 1024))
    advice.push(`peak memory ${formatMem(maxRssMb)} of ${formatMem(reqMemMb)} requested: --mem=${want}G is enough`)
  }
  if (state === 'TIMEOUT') {
    advice.push('hit its walltime: raise --time, or checkpoint and use --requeue so it resumes')
  } else if (state === 'COMPLETED' && timeEff !== undefined && timeEff < 0.35 && limit >= 3600) {
    const want = Math.ceil((elapsed * 1.5) / 900) * 15 // round up to 15 min
    advice.push(`ran ${formatDuration(elapsed)} of a ${formatDuration(limit)} limit: --time=${want} backfills sooner`)
  }
  if (cpuEff !== undefined && cpuEff < 0.25 && cpus >= 8 && elapsed > 300) {
    const want = Math.max(2, Math.ceil(cpus * cpuEff * 1.5))
    advice.push(`CPU use ${Math.round(cpuEff * 100)}% of ${cpus} cores: --cpus-per-task=${want} would do`)
  }

  return {
    id,
    name: main['JobName'] ?? '',
    user: main['User'] || undefined,
    state,
    exitCode: main['ExitCode'] ?? '',
    elapsed: main['Elapsed'] ?? '',
    limit: main['Timelimit'] ?? '',
    nodes: main['NodeList'] ?? '',
    cpus,
    gpus,
    reqMem: Number.isFinite(reqMemMb) ? formatMem(reqMemMb) : main['ReqMem'] ?? '?',
    maxRss: Number.isFinite(maxRssMb) ? formatMem(maxRssMb) : '?',
    cpuEff,
    memEff,
    timeEff,
    advice,
    endedAt,
  }
}

export async function fetchReport(run: Run, id: string, now: number): Promise<JobReport | null> {
  // Text sacct, not --json: --json omits mem-used on this cluster.
  const r = await run(['sacct', '-j', id, '-n', '-P', '-o', SACCT_FIELDS])
  if (r.exitCode !== 0) return null
  return buildReport(id, parseSacct(r.stdout), now)
}

export async function tailFile(run: Run, path: string, lines: number): Promise<string[]> {
  if (!path || path === '(null)') return []
  const r = await run(['tail', '-n', String(lines), path])
  if (r.exitCode !== 0) return [`(cannot read ${path}: ${r.stderr.trim().split('\n')[0] ?? 'error'})`]
  return r.stdout.replace(/\r/g, '').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '')
}

export const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'OUT_OF_MEMORY',
  'NODE_FAIL',
  'PREEMPTED',
  'BOOT_FAIL',
  'DEADLINE',
])

export function isBad(state: string): boolean {
  return state !== 'COMPLETED' && TERMINAL_STATES.has(state)
}

export function pct(x: number | undefined): string {
  return x === undefined ? '–' : `${Math.round(x * 100)}%`
}

export function reportLine(r: JobReport): string {
  const eff = [
    r.cpuEff !== undefined ? `CPU ${pct(r.cpuEff)}` : '',
    r.memEff !== undefined ? `mem ${r.maxRss}/${r.reqMem} (${pct(r.memEff)})` : '',
    r.timeEff !== undefined ? `time ${pct(r.timeEff)} of limit` : '',
  ].filter(Boolean)
  return `job ${r.id} (${r.name}) ${r.state} exit ${r.exitCode} after ${r.elapsed}${eff.length ? ' · ' + eff.join(' · ') : ''}`
}
