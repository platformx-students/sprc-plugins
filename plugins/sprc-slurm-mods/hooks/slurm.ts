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

type SacctRow = Record<string, string>
const SACCT_COLUMNS = SACCT_FIELDS.split(',') as readonly string[]

export function parseSacct(stdout: string): SacctRow[] {
  return stdout
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const f = l.split('|')
      const row: Record<string, string> = {}
      SACCT_COLUMNS.forEach((c, i) => (row[c] = f[i] ?? ''))
      return row
    })
}

/** "95605_3" / "95605_[3-200]" / "123+0" / "123.batch" -> "95605" / "95605" / "123" / "123" */
export function parentId(id: string): string {
  return /^\d+/.exec(id)?.[0] ?? id
}

/** "95605_[3-5,9]%4" -> 4 tasks; anything else -> 1 */
function taskCount(id: string): number {
  const m = /_\[([^\]]+)\]/.exec(id)
  if (!m) return 1
  let n = 0
  for (const r of m[1]!.replace(/%\d+$/, '').split(',')) {
    const [a, b] = r.split('-').map(Number)
    n += b === undefined ? 1 : Math.max(1, b - a! + 1)
  }
  return n
}

type Task = {
  id: string
  name: string
  user: string
  state: string
  exitCode: string
  count: number
  elapsed: number
  limit: number
  cpus: number
  totalCpu: number
  reqMemMb: number
  maxRssMb: number
  gpus: number
}

function tasksOf(rows: readonly SacctRow[]): Task[] {
  const byTask = new Map<string, Task>()
  for (const r of rows) {
    const jobId = r['JobID'] ?? ''
    const taskId = jobId.split('.')[0]!
    let t = byTask.get(taskId)
    if (!jobId.includes('.')) {
      const tres = parseTres(r['AllocTRES'] ?? '')
      t = {
        id: taskId,
        name: r['JobName'] ?? '',
        user: r['User'] ?? '',
        state: (r['State'] ?? '').split(' ')[0]!,
        exitCode: r['ExitCode'] ?? '',
        count: taskCount(taskId),
        elapsed: durationSeconds(r['Elapsed'] ?? ''),
        limit: durationSeconds(r['Timelimit'] ?? ''),
        cpus: Number(r['NCPUS']) || 0,
        totalCpu: durationSeconds(r['TotalCPU'] ?? ''),
        reqMemMb: memMb(r['ReqMem'] ?? ''),
        maxRssMb: t?.maxRssMb ?? NaN,
        gpus: Number(tres['gres/gpu'] ?? 0) || 0,
      }
      byTask.set(taskId, t)
    }
    const v = memMb(r['MaxRSS'] ?? '')
    // 0 means the 30 s sampler never ran (a short job), not 0 bytes.
    if (Number.isFinite(v) && v > 0) {
      if (!t) {
        t = { id: taskId, maxRssMb: v } as Task
        byTask.set(taskId, t)
      } else if (!(t.maxRssMb >= v)) t.maxRssMb = v
    }
  }
  return [...byTask.values()].filter(t => t.state !== undefined)
}

/** Right-sizing for the next submission, from what the job (or every task of it) used. */
function advise(a: {
  states: ReadonlySet<string>
  elapsed: number
  limit: number
  cpus: number
  cpuEff?: number
  reqMemMb: number
  maxRssMb: number
  memEff?: number
  timeEff?: number
}): string[] {
  const advice: string[] = []
  // A job that ran under two minutes says little about what it needs.
  const isMeasured = a.elapsed >= 120
  if (a.states.has('OUT_OF_MEMORY') || (a.memEff !== undefined && a.memEff > 0.92)) {
    const want = Math.ceil(((Number.isFinite(a.maxRssMb) ? a.maxRssMb : a.reqMemMb) * 1.5) / 1024)
    advice.push(`memory was the limit: request --mem=${want}G`)
  } else if (isMeasured && a.memEff !== undefined && a.memEff < 0.5 && a.reqMemMb >= 8192) {
    advice.push(`peak mem ${formatMem(a.maxRssMb)} of ${formatMem(a.reqMemMb)}: --mem=${Math.max(4, Math.ceil((a.maxRssMb * 1.3) / 1024))}G is enough`)
  }
  if (a.states.has('TIMEOUT')) {
    advice.push('hit its walltime: raise --time, or checkpoint and --requeue')
  } else if (isMeasured && a.states.size === 1 && a.states.has('COMPLETED') && a.timeEff !== undefined && a.timeEff < 0.35 && a.limit >= 3600) {
    advice.push(`ran ${formatDuration(a.elapsed)} of a ${formatDuration(a.limit)} limit: --time=${Math.ceil((a.elapsed * 1.5) / 900) * 15} backfills sooner`)
  }
  if (a.cpuEff !== undefined && a.cpuEff < 0.25 && a.cpus >= 8 && a.elapsed > 300) {
    advice.push(`CPU use ${Math.round(a.cpuEff * 100)}% of ${a.cpus} cores: --cpus-per-task=${Math.max(2, Math.ceil(a.cpus * a.cpuEff * 1.5))} would do`)
  }
  return advice
}

/** The larger of two measurements, either of which may be NaN (unknown). */
function most(a: number, b: number): number {
  return Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b)
}

/**
 * One report for job `id` from its sacct rows: a plain job, or an array
 * job summarised over all its tasks (state counts, the failures, and the
 * peak use of any task, so the advice fits every task).
 */
export function buildReport(id: string, rows: readonly SacctRow[], endedAt: number): JobReport | null {
  // A task id ("123_4") reports that task alone; a job id, all of its tasks.
  const tasks = tasksOf(rows.filter(r => (id.includes('_') ? (r['JobID'] ?? '').split('.')[0] === id : parentId(r['JobID'] ?? '') === id)))
  if (!tasks.length) return null
  const counts: Record<string, number> = {}
  let n = 0
  let elapsed = NaN
  let limit = NaN
  let maxRssMb = NaN
  let reqMemMb = NaN
  let cpuUsed = 0
  let cpuHeld = 0
  for (const t of tasks) {
    counts[t.state] = (counts[t.state] ?? 0) + t.count
    n += t.count
    elapsed = most(elapsed, t.elapsed)
    limit = most(limit, t.limit)
    maxRssMb = most(maxRssMb, t.maxRssMb)
    reqMemMb = most(reqMemMb, t.reqMemMb)
    if (t.elapsed > 0 && t.cpus > 0 && Number.isFinite(t.totalCpu)) {
      cpuUsed += t.totalCpu
      cpuHeld += t.elapsed * t.cpus
    }
  }
  const first = tasks[0]!
  const states = new Set(Object.keys(counts))
  const failed = tasks.filter(t => isBad(t.state)).map(t => ({ id: t.id, state: t.state, exitCode: t.exitCode }))
  const cpuEff = cpuHeld > 0 ? cpuUsed / cpuHeld : undefined
  const memEff = reqMemMb > 0 && Number.isFinite(maxRssMb) ? maxRssMb / reqMemMb : undefined
  const timeEff = limit > 0 && Number.isFinite(elapsed) ? elapsed / limit : undefined
  return {
    id,
    name: first.name,
    user: first.user || undefined,
    state: states.size === 1 ? first.state : 'MIXED',
    counts,
    tasks: n,
    isArray: tasks.some(t => t.id.includes('_')),
    failed: failed.slice(0, 10),
    exitCode: first.exitCode,
    elapsed: formatDuration(elapsed),
    elapsedS: elapsed,
    limit: formatDuration(limit),
    cpus: first.cpus,
    gpus: first.gpus,
    reqMem: formatMem(reqMemMb),
    maxRss: Number.isFinite(maxRssMb) ? formatMem(maxRssMb) : '?',
    cpuEff,
    memEff,
    timeEff,
    advice: advise({ states, elapsed, limit, cpus: first.cpus, cpuEff, reqMemMb, maxRssMb, memEff, timeEff }),
    endedAt,
  }
}

/** Reports for several jobs from one sacct call; a job sacct has not finished recording is left out. */
export async function fetchReports(run: Run, ids: readonly string[], now: number): Promise<Map<string, JobReport>> {
  const out = new Map<string, JobReport>()
  if (!ids.length) return out
  // Text sacct, not --json: --json omits mem-used on this cluster.
  const r = await run(['sacct', '-j', ids.join(','), '-n', '-P', '-o', SACCT_FIELDS])
  if (r.exitCode !== 0) return out
  const rows = parseSacct(r.stdout)
  for (const id of ids) {
    const report = buildReport(parentId(id), rows, now)
    if (report && Object.keys(report.counts).every(s => TERMINAL_STATES.has(s))) out.set(report.id, report)
  }
  return out
}

export async function fetchReport(run: Run, id: string, now: number): Promise<JobReport | null> {
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

/** "85353,85354,85355,85360" -> "85353–85355, 85360" */
export function idRanges(ids: readonly string[]): string {
  const nums = [...new Set(ids)].map(Number).sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < nums.length; ) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++
    out.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]))
    i = j + 1
  }
  return out.join(', ')
}

function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(', ')
}

function useText(r: JobReport): string {
  // Under two minutes the samples say nothing worth the tokens.
  if (!(r.elapsedS >= 120)) return ''
  return [
    r.memEff !== undefined ? `peak mem ${r.maxRss}/${r.reqMem}` : '',
    r.cpuEff !== undefined && r.cpus ? `CPU ${pct(r.cpuEff)} of ${r.cpus}` : '',
    r.timeEff !== undefined ? `${pct(r.timeEff)} of ${r.limit} limit` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One line for one job: `job 85353 "train" COMPLETED in 12m · peak mem 3G/16G · ...` */
export function reportLine(r: JobReport): string {
  const what = r.isArray ? `array ${r.id} "${r.name}" (${r.tasks} tasks: ${countsText(r.counts)})` : `job ${r.id} "${r.name}" ${r.state}`
  const exit = !r.isArray && isBad(r.state) ? ` exit ${r.exitCode}` : ''
  const use = useText(r)
  return `${what}${exit} ${r.isArray ? 'longest' : 'in'} ${r.elapsed}${use ? ` · ${use}` : ''}`
}

export type FailedLog = { id: string; path: string }

/**
 * The message for a set of jobs that have all ended: one line per job up to
 * a few, then counts; failures with their log; advice not already given.
 */
export function endMessage(reports: readonly JobReport[], logs: readonly FailedLog[], seenAdvice: Set<string>): string {
  const lines: string[] = []
  const bad = reports.filter(r => r.failed.length > 0)
  if (reports.length <= 3) {
    lines.push(`[sprc] Ended: ${reports.map(reportLine).join('\n  ')}`)
  } else {
    const counts: Record<string, number> = {}
    for (const r of reports) for (const [s, n] of Object.entries(r.counts)) counts[s] = (counts[s] ?? 0) + n
    const longest = Math.max(...reports.map(r => r.elapsedS).filter(Number.isFinite))
    lines.push(`[sprc] ${reports.length} jobs ended (${idRanges(reports.map(r => r.id))}): ${countsText(counts)}; longest ${formatDuration(longest)}.`)
    for (const r of bad.slice(0, 5)) lines.push(`  ${reportLine(r)}`)
    if (bad.length > 5) lines.push(`  … ${bad.length - 5} more with failures: ${idRanges(bad.slice(5).map(r => r.id))}`)
  }
  const failedTasks = bad.flatMap(r => r.failed)
  if (failedTasks.length) {
    const shown = failedTasks.slice(0, 5).map(t => {
      const log = logs.find(l => l.id === t.id || l.id === parentId(t.id))
      return `${t.id} ${t.state} exit ${t.exitCode}${log ? ` log ${log.path}` : ''}`
    })
    lines.push(`  Failed: ${shown.join('; ')}${failedTasks.length > 5 ? `; +${failedTasks.length - 5} more` : ''}`)
  }
  const advice = [...new Set(reports.flatMap(r => r.advice))].filter(a => !seenAdvice.has(a))
  for (const a of advice) seenAdvice.add(a)
  if (advice.length) lines.push(`  Right-sizing: ${advice.slice(0, 3).join('; ')}`)
  return lines.join('\n')
}
