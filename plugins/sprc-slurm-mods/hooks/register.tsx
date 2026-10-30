import type { EngineInterface, PluginState, Register } from 'claude-code'

import type { Followed, JobReport, Notice, Snapshot } from '../types'
import { checkBash, runsSbatch, sbatchScripts, scriptsRun, submittedJobs } from './guards'
import type { Finding } from './guards'
import {
  TERMINAL_STATES,
  endMessage,
  expandNodes,
  fetchReport,
  fetchReports,
  fetchScontrol,
  fetchSnapshot,
  gpuTotals,
  hasJob,
  idRanges,
  isBad,
  nodeUsable,
  parentId,
  reportLine,
  tailFile,
} from './slurm'
import type { FailedLog, Run } from './slurm'

type $ = EngineInterface

const REF_snapshot = { plugin: 'sprc-slurm-mods', key: 'snapshot' } as const
const REF_followed = { plugin: 'sprc-slurm-mods', key: 'followed' } as const
const REF_finished = { plugin: 'sprc-slurm-mods', key: 'finished' } as const
const REF_outbox = { plugin: 'sprc-slurm-mods', key: 'outbox' } as const
const REF_isEnabled = { plugin: 'sprc-slurm-mods', key: 'isEnabled' } as const

// Slurm's own words and cluster phrases only: "job", "node" or "queue" alone
// mostly mean CI, Node.js or a web queue.
const SLURMY =
  /\b(slurm|sbatch|salloc|srun|squeue|sacct|sinfo|scancel|scontrol|gpus?|h100s?|sprc\w*|sprlab005|my jobs?|the queue|the cluster|compute nodes?|scavenger|expedite)\b/i

const JOB_ID = /^\d+(_\d+)?$/

// Reads within one dispatch see the state as it stood when the dispatch
// began, so a value written mid-hook reads stale. This module is the only
// writer of its values, so it keeps them here too: `get` answers from the
// cache, `put` writes both. A reload empties the cache; the next `get` loads
// from the host.
type S = PluginState['sprc-slurm-mods']
const mem: { [K in keyof S]?: S[K] } = {}
async function load<K extends keyof S>($: $, k: K): Promise<S[K]> {
  switch (k) {
    case 'snapshot':
      return ((await $.state.get(REF_snapshot)).value ?? null) as S[K]
    case 'followed':
      return ((await $.state.get(REF_followed)).value ?? []) as S[K]
    case 'finished':
      return ((await $.state.get(REF_finished)).value ?? []) as S[K]
    case 'outbox':
      return ((await $.state.get(REF_outbox)).value ?? []) as S[K]
    case 'isEnabled':
      return ((await $.state.get(REF_isEnabled)).value ?? false) as S[K]
  }
  throw new Error(`unknown state key ${String(k)}`)
}

async function get<K extends keyof S>($: $, k: K): Promise<S[K]> {
  if (!(k in mem)) mem[k] = await load($, k)
  return mem[k] as S[K]
}

async function put<K extends keyof S>($: $, k: K, fn: (v: S[K]) => S[K]): Promise<void> {
  const v = fn(await get($, k))
  mem[k] = v
  switch (k) {
    case 'snapshot':
      await $.state.set(REF_snapshot, v as S['snapshot'])
      break
    case 'followed':
      await $.state.set(REF_followed, v as S['followed'])
      break
    case 'finished':
      await $.state.set(REF_finished, v as S['finished'])
      break
    case 'outbox':
      await $.state.set(REF_outbox, v as S['outbox'])
      break
    case 'isEnabled':
      await $.state.set(REF_isEnabled, v as S['isEnabled'])
      break
  }
}

// Module-local; a reload starts these over.
const cfg = { pollMs: 30_000, guards: 'enforce', liveContext: true, wake: true }
let user = ''
let isLoginNode = false
let isPolling = false
let lastPollAt = 0
// What the prompt hook last attached, so an unchanged cluster is not re-sent.
let lastContext = { text: '', at: 0 }
// The main conversation's running turn, if any. Jobs one loop follows during
// one turn form a group and are reported together.
let mainTurn: { id: string } | null = null
let idleTurn = 0
// Said once per session (per loop): repeating them costs tokens and says nothing new.
const toldFollowing = new Set<string>()
const toldRules = new Set<string>()
const seenAdvice = new Set<string>()
// Background Bash commands that may submit jobs. The hook never sees their
// output, so each poll adopts the person's new jobs that match the command
// (by job name, script name, or --wrap) for a while after it started.
type Watch = { owner: string | undefined; group: string; top: number; since: number; until: number; text: string }
let watches: Watch[] = []
const WATCH_MS = 2 * 60 * 60_000

function runner($: $): Run {
  return (argv, init) => $.process.run(argv, { timeoutMs: init?.timeoutMs ?? 20_000 })
}

function groupKey(owner: string | undefined): string {
  return `${owner ?? 'main'}|${mainTurn?.id ?? `idle${idleTurn}`}`
}

function loopKey(owner: string | undefined): string {
  return owner ?? 'main'
}

// ---- following -----------------------------------------------------------

async function follow($: $, ids: readonly string[], owner: string | undefined, origin: Followed['origin'], inGroup?: string): Promise<string[]> {
  const since = await $.clock.now()
  const have = new Set((await get($, 'followed')).map(f => f.id))
  const fresh = [...new Set(ids.map(parentId))].filter(id => !have.has(id))
  if (!fresh.length) return []
  const group = inGroup ?? groupKey(owner)
  await put($, 'followed', list => [...list, ...fresh.map(id => ({ id, owner, group, origin, since }))])
  return fresh
}

/** Tells the right loop: the main conversation through its tool results or a woken turn, an agent by message. */
async function queueNotice($: $, owner: string | undefined, text: string): Promise<void> {
  const at = await $.clock.now()
  await put($, 'outbox', list => [...list, { owner, text, at }])
}

/** Notices for one loop, taken out of the outbox. */
async function takeNotices($: $, owner: string | undefined): Promise<string[]> {
  const box = await get($, 'outbox')
  const mine = box.filter(n => n.owner === owner)
  if (!mine.length) return []
  await put($, 'outbox', list => list.filter(n => n.owner !== owner))
  return mine.map(n => n.text)
}

/**
 * Delivers what is waiting in the outbox that its loop has not picked up
 * from a tool result: an idle main conversation is woken with one short
 * prompt (setting `wake`), an agent is sent a message, and an agent that is
 * gone hands its notice to the main conversation.
 */
async function deliver($: $): Promise<void> {
  const box = await get($, 'outbox')
  if (!box.length) return
  const now = await $.clock.now()
  const keep: Notice[] = []
  const toMain: string[] = []
  for (const n of box) {
    if (n.owner === undefined) toMain.push(n.text)
    // Give a running agent one poll to pick it up from a tool result.
    else if (now - n.at < cfg.pollMs - 1000) keep.push(n)
    else {
      const sent = await $.session.send({ to: { agentId: n.owner }, text: n.text }).catch(() => ({ isDelivered: false }))
      if (!sent.isDelivered) toMain.push(n.text)
    }
  }
  if (toMain.length && !mainTurn && cfg.wake) {
    await put($, 'outbox', () => keep)
    void $.prompt.submit({ text: toMain.join('\n') }).catch(err => $.ui.log(`sprc: wake failed: ${String(err)}`, { to: 'debug' }))
    return
  }
  // The main conversation is busy (its next tool result carries them) or
  // waking is off (the person's next prompt carries them).
  await put($, 'outbox', () => [...keep, ...toMain.map(text => ({ text, at: now }))])
}

/** Failed tasks' log paths, while scontrol still remembers them (a few minutes after the end). */
async function failedLogs(run: Run, reports: readonly JobReport[]): Promise<FailedLog[]> {
  const logs: FailedLog[] = []
  for (const t of reports.flatMap(r => r.failed).slice(0, 3)) {
    const f = await fetchScontrol(run, t.id).catch(() => null)
    const path = f?.['StdErr'] && f['StdErr'] !== f['StdOut'] ? f['StdErr'] : f?.['StdOut']
    if (path) logs.push({ id: t.id, path })
  }
  return logs
}

/**
 * Updates followed jobs from a fresh snapshot: start toasts, jobs gone from
 * the queue, their reports once sacct has them, and one notice per group
 * once every job of the group has ended.
 */
async function track($: $, snap: Snapshot): Promise<void> {
  const run = runner($)
  const now = snap.at
  let follows = await get($, 'followed')
  if (!follows.length) return

  const started: string[] = []
  follows = follows.map(f => {
    const rows = snap.mine.filter(j => parentId(j.id) === f.id)
    if (!f.started && rows.some(j => j.state === 'R')) {
      started.push(f.id)
      return { ...f, started: true }
    }
    if (!f.gone && f.since < now && !hasJob(snap.mine, f.id)) return { ...f, gone: now }
    return f
  })
  if (started.length) {
    const f = follows.find(x => x.id === started[0])!
    const nodes = [...new Set(snap.mine.filter(j => started.includes(parentId(j.id)) && j.state === 'R').map(j => j.nodes))]
    $.ui.toast(
      started.length === 1
        ? `▶ job ${f.id} started on ${nodes.join(', ')}`
        : `▶ ${started.length} jobs started (${idRanges(started)})`,
    )
  }

  // Reports for jobs that left the queue; sacct can lag the queue by a few
  // seconds, so a job it has not finished recording waits for the next poll
  // (up to five minutes, then it is reported as best known).
  const pending = follows.filter(f => f.gone && !f.report)
  if (pending.length) {
    const reports = await fetchReports(run, pending.map(f => f.id), now)
    follows = follows.map(f => {
      const report = reports.get(f.id)
      if (report) return { ...f, report }
      if (f.gone && !f.report && now - f.gone > 5 * 60_000) return { ...f, report: unknownReport(f.id, now) }
      return f
    })
  }

  // Groups whose every job has a report are done.
  const done = new Map<string, Followed[]>()
  for (const f of follows) done.set(f.group, [...(done.get(f.group) ?? []), f])
  const ended: Followed[] = []
  for (const [, members] of done) if (members.every(f => f.report)) ended.push(...members)
  await put($, 'followed', () => follows.filter(f => !ended.includes(f)))
  if (!ended.length) return

  const reports = ended.map(f => f.report!)
  await put($, 'finished', list => [...reports, ...list.filter(r => !reports.some(x => x.id === r.id))].slice(0, 20))

  const byLoop = new Map<string, Followed[]>()
  for (const f of ended) byLoop.set(loopKey(f.owner), [...(byLoop.get(loopKey(f.owner)) ?? []), f])
  for (const [, members] of byLoop) {
    const rs = members.map(f => f.report!)
    await queueNotice($, members[0]!.owner, endMessage(rs, await failedLogs(run, rs), seenAdvice))
  }

  const bad = reports.filter(r => r.failed.length || isBad(r.state)).length
  const left = follows.length - ended.length
  $.ui.toast(
    reports.length === 1
      ? `${bad ? '✗' : '✓'} job ${reports[0]!.id} ${reports[0]!.state} (${reports[0]!.elapsed})`
      : `${bad ? '✗' : '✓'} ${reports.length} jobs ended: ${reports.length - bad} ok${bad ? `, ${bad} failed` : ''}${left ? ` · ${left} still followed` : ''}`,
    { timeoutMs: 8000 },
  )
}

function unknownReport(id: string, now: number): JobReport {
  return {
    id,
    name: '',
    state: 'ENDED',
    counts: { ENDED: 1 },
    tasks: 1,
    isArray: false,
    failed: [],
    exitCode: '?',
    elapsed: '?',
    elapsedS: NaN,
    limit: '?',
    cpus: 0,
    gpus: 0,
    reqMem: '?',
    maxRss: '?',
    advice: [],
    endedAt: now,
  }
}

// ---- polling ---------------------------------------------------------------

/**
 * `isTimer`: a background tick. With nothing followed those run at a quarter
 * of the configured rate; anything that needs fresh data (a tool, /sprc, a
 * cluster-ish prompt) polls on its own.
 */
async function poll($: $, isTimer = false): Promise<void> {
  if (isPolling || !user) return
  const now = await $.clock.now()
  if (isTimer && now - lastPollAt < 4 * cfg.pollMs - 1000) {
    const isIdle = (await get($, 'followed')).length === 0 && (await get($, 'outbox')).length === 0 && !watches.length
    if (isIdle) return
  }
  isPolling = true
  lastPollAt = now
  try {
    const snap = await fetchSnapshot(runner($), user, now)
    await put($, 'snapshot', () => snap)
    if (!snap.error) {
      await adoptWatched($, now)
      await track($, snap)
    }
    await deliver($)
    await setStatus($, snap)
  } catch (err) {
    $.ui.log(`sprc poll failed: ${String(err)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

async function setStatus($: $, snap: Snapshot): Promise<void> {
  if (snap.error) {
    $.ui.status('sprc ▸ Slurm unreachable')
    return
  }
  const g = gpuTotals(snap.nodes)
  const follows = await get($, 'followed')
  let mine = ''
  if (follows.length) {
    const rows = snap.mine.filter(j => follows.some(f => f.id === parentId(j.id)))
    const r = rows.filter(j => j.state === 'R').length
    const pd = rows.filter(j => j.state === 'PD').length
    mine = ` · following ${follows.length}${r || pd ? ` (${r}R ${pd}PD)` : ''}`
  } else if (snap.mine.length) {
    mine = ` · you ${snap.mine.filter(j => j.state === 'R').length}R ${snap.mine.filter(j => j.state === 'PD').length}PD`
  }
  $.ui.status(`sprc ▸ ${g.usable}/${g.total} GPU free${g.idle > g.usable ? ` (+${g.idle - g.usable} stranded)` : ''}${mine} · queue ${snap.others.pending}`)
}

function summary(snap: Snapshot | null): string {
  if (!snap) return '[sprc] no data yet'
  if (snap.error) return `[sprc] Slurm unreachable (${snap.error})`
  const g = gpuTotals(snap.nodes)
  const free = snap.nodes.filter(n => nodeUsable(n) > 0).map(n => `${n.name} ${nodeUsable(n)}`)
  const r = snap.mine.filter(j => j.state === 'R').length
  const pd = snap.mine.filter(j => j.state === 'PD').length
  return `[sprc live] ${g.usable}/${g.total} GPUs free for a default GPU job${free.length ? ` (${free.join(', ')})` : ''}${g.idle > g.usable ? `; ${g.idle - g.usable} more idle but short of the 32 CPU + 375G a GPU gets by default` : ''}. You: ${r} running, ${pd} pending. Others: ${snap.others.running} running, ${snap.others.pending} pending.`
}

// ---- model tools -------------------------------------------------------------

/** "123, 124 125_3" -> ["123", "124", "125_3"]; null if any is not a job id. */
function jobIds(raw: unknown): string[] | null {
  const ids = String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
  return ids.length && ids.every(id => JOB_ID.test(id)) ? ids : null
}

async function registerTools($: $): Promise<void> {
  await $.tool.register({
    name: 'sprc_status',
    description:
      'Live state of the sprc Slurm cluster: free GPUs per node, your queued/running jobs with pending reasons explained, queue depth, what this session follows, and recently finished followed jobs.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'sprc_job',
    description:
      'One Slurm job (running, pending or finished; an array id summarises its tasks): state and pending reason explained, times, resources, log paths, the tail of its log, and for finished jobs CPU/memory/time use with right-sizing advice.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'A job id, e.g. "80240", or an array task, "80240_3".' },
        log_lines: { type: 'number', description: 'Trailing log lines to include (default 30, max 200).' },
        stderr: { type: 'boolean', description: 'Tail StdErr instead of StdOut (when they differ).' },
      },
      required: ['job_id'],
    },
  })
  await $.tool.register({
    name: 'sprc_follow',
    description:
      'Follow jobs you did not submit with sbatch in this session (sbatch submissions are followed automatically): when they have all ended you get one message with results, failures and log paths. stop=true unfollows.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'One or more job ids, comma- or space-separated.' },
        stop: { type: 'boolean' },
      },
      required: ['job_id'],
    },
  })
}

/**
 * Why job `id` cannot be followed, or null if it can: it must be yours and
 * still queued or running. An ended one is returned as its result, so the
 * caller learns it now instead of waiting on an end that never comes.
 */
async function followRefusal($: $, id: string): Promise<string | null> {
  const run = runner($)
  const q = await run(['squeue', '-h', '-j', id, '-o', '%u'])
  const owners = new Set(q.exitCode === 0 ? q.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [])
  if (owners.size) return owners.has(user) ? null : `${id}: not yours; only your own jobs can be followed.`
  const report = (await fetchReports(run, [id], await $.clock.now())).get(parentId(id))
  if (!report) return `${id}: not queued or running, and sacct has no finished record of it.`
  if (report.user && report.user !== user) return `${id}: not yours; only your own jobs can be followed.`
  return `${id} already ended: ${reportLine(report)}`
}

async function statusTool($: $): Promise<string> {
  await poll($)
  const snap = await get($, 'snapshot')
  const fin = await get($, 'finished')
  const follows = await get($, 'followed')
  const lines = [summary(snap)]
  // Bounded: a campaign of hundreds of jobs must not become hundreds of lines.
  const mine = snap?.mine ?? []
  const running = mine.filter(j => j.state !== 'PD')
  const pending = mine.filter(j => j.state === 'PD')
  for (const j of running.slice(0, 10)) {
    lines.push(`  ${j.id} ${j.state} "${j.name}" ${j.elapsed}/${j.limit} on ${j.nodes} · ${j.gpus} GPU ${j.cpus} CPU ${j.mem}`)
  }
  if (running.length > 10) lines.push(`  … ${running.length - 10} more running`)
  for (const j of pending.slice(0, 6)) {
    lines.push(`  ${j.id} PD "${j.name}" ${explainReason(j.reason)}${j.start !== 'N/A' ? ` · est. start ${j.start}` : ''} · ${j.gpus} GPU ${j.cpus} CPU ${j.mem} · qos ${j.qos}`)
  }
  if (pending.length > 6) {
    const why = new Map<string, number>()
    for (const j of pending.slice(6)) why.set(j.reason, (why.get(j.reason) ?? 0) + 1)
    lines.push(`  … ${pending.length - 6} more pending (${[...why].map(([k, n]) => `${explainReason(k)} ×${n}`).join(', ')})`)
  }
  if (follows.length) lines.push(`Following: ${idRanges(follows.map(f => f.id))}`)
  if (fin.length) {
    lines.push('Recently ended (followed):')
    for (const r of fin.slice(0, 5)) lines.push(`  ${reportLine(r)}`)
  }
  return lines.join('\n')
}

async function jobTool($: $, args: { job_id?: unknown; log_lines?: unknown; stderr?: unknown }): Promise<string> {
  const id = String(args.job_id ?? '').trim()
  if (!JOB_ID.test(id)) return `"${id}" is not a job id.`
  const run = runner($)
  const now = await $.clock.now()
  const fields = await fetchScontrol(run, id)
  const state = fields?.['JobState']
  const isPlainLive = !!state && !TERMINAL_STATES.has(state) && !fields?.['ArrayJobId']
  const report = isPlainLive ? null : await fetchReport(run, id, now)
  if (!fields && !report) return `Job ${id}: unknown to scontrol and sacct.`
  const out: string[] = []
  if (fields) {
    const f = fields
    out.push(`Job ${f['JobId']}${f['ArrayTaskId'] ? ` (array ${f['ArrayJobId']} task ${f['ArrayTaskId']})` : ''} "${f['JobName']}" ${f['JobState']}${f['Reason'] && f['Reason'] !== 'None' ? ` (${explainReason(f['Reason'])})` : ''}`)
    out.push(`  partition ${f['Partition']} · qos ${f['QOS']} · nodes ${f['NodeList'] || '-'} · TRES ${f['AllocTRES'] || f['ReqTRES'] || '?'}`)
    out.push(`  time ${f['RunTime']} of ${f['TimeLimit']} · submitted ${f['SubmitTime']} · start ${f['StartTime']}${f['EndTime'] !== 'Unknown' ? ` · end ${f['EndTime']}` : ''}${f['Restarts'] && f['Restarts'] !== '0' ? ` · requeued ${f['Restarts']}×` : ''}`)
    out.push(`  workdir ${f['WorkDir']} · command ${f['Command']}`)
    if (f['ExitCode'] && f['ExitCode'] !== '0:0') out.push(`  exit ${f['ExitCode']}`)
  }
  if (report && Object.keys(report.counts).every(s => TERMINAL_STATES.has(s))) {
    out.push(`Ended: ${reportLine(report)}`)
    if (report.failed.length) out.push(`  failed: ${report.failed.map(t => `${t.id} ${t.state} exit ${t.exitCode}`).join('; ')}`)
    out.push(`  right-sizing: ${report.advice.length ? report.advice.join('; ') : 'request looked about right'}`)
  } else if (report?.isArray) {
    out.push(`Array tasks so far: ${Object.entries(report.counts).map(([s, n]) => `${n} ${s}`).join(', ')}`)
  }
  const path = args.stderr ? fields?.['StdErr'] : fields?.['StdOut']
  if (path) {
    const n = Math.max(1, Math.min(200, Number(args.log_lines ?? 30) || 30))
    const log = await tailFile(run, path, n)
    out.push(`--- last ${log.length} lines of ${path} ---`, ...log)
  } else if (!fields) {
    out.push('(scontrol has forgotten this job, so its log path is unknown; the job script\'s --output says where)')
  }
  return out.join('\n')
}

async function followTool($: $, args: { job_id?: unknown; stop?: unknown }, owner: string | undefined): Promise<string> {
  const ids = jobIds(args.job_id)
  if (!ids) return `"${String(args.job_id ?? '')}" is not a job id (or a comma-separated list of them).`
  const parents = [...new Set(ids.map(parentId))]
  if (args.stop === true) {
    await put($, 'followed', list => list.filter(f => !parents.includes(f.id)))
    return `Stopped following ${idRanges(parents)}.`
  }
  const already = new Set((await get($, 'followed')).map(f => f.id))
  const out: string[] = []
  const ok: string[] = []
  for (const id of parents) {
    if (already.has(id)) continue
    const refusal = await followRefusal($, id)
    if (refusal) out.push(refusal)
    else ok.push(id)
  }
  await follow($, ok, owner, 'tool')
  const now = [...already].filter(id => parents.includes(id)).concat(ok)
  if (now.length) out.unshift(`Following ${idRanges(now)}: one message when they have all ended. End your turn or keep working; no need to poll.`)
  return out.join('\n')
}

// ---- explaining pending reasons -------------------------------------------

const REASONS: Record<string, string> = {
  Priority: 'behind higher-priority jobs',
  Resources: 'next in line, waiting for resources',
  Dependency: 'waiting on a dependency',
  DependencyNeverSatisfied: 'dependency failed; will never start (scancel it)',
  JobArrayTaskLimit: 'array throttle (%N) reached',
  QOSMaxGRESPerUser: 'at your QoS GPU limit',
  QOSMaxCpuPerUserLimit: 'at your QoS CPU limit (--qos=scavenger has none)',
  QOSMaxJobsPerUserLimit: 'at your QoS job-count limit',
  QOSGrpGRES: 'QoS group GPU limit reached',
  AssocGrpGRESMinutes: 'GPU-minutes budget exhausted',
  AssocGrpGRES: 'account GPU limit reached',
  ReqNodeNotAvail: 'requested node unavailable (drained or reserved)',
  BeginTime: 'held until its --begin time',
  JobHeldUser: 'held by you (scontrol release)',
  JobHeldAdmin: 'held by an admin',
  PartitionTimeLimit: '--time exceeds the partition limit; will never start',
  QOSMaxWallDurationPerJobLimit: '--time exceeds the QoS limit; will never start',
}

export function explainReason(reason: string): string {
  const key = reason.replace(/^\(|\)$/g, '')
  return REASONS[key] ?? key
}

// ---- the Bash hook's pieces --------------------------------------------------

/** The highest job id anyone has queued, so the ids sbatch hands out next are known to be above it. */
async function queueTop(run: Run): Promise<number> {
  const r = await run(['squeue', '-h', '-a', '-r', '-o', '%F'], { timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return Infinity
  return r.stdout.split('\n').reduce((m, l) => Math.max(m, Number(l.trim()) || 0), 0)
}

/** Your jobs above `floor`: what a command submitted when its output did not say. */
async function mineAbove(run: Run, floor: number): Promise<string[]> {
  if (!Number.isFinite(floor)) return []
  const r = await run(['squeue', '--me', '-h', '-r', '-o', '%F'], { timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return []
  return [...new Set(r.stdout.split('\n').map(l => l.trim()).filter(l => Number(l) > floor))]
}

/** What to do while followed jobs run, true to the `wake` setting. */
function resultsLine(): string {
  return cfg.wake
    ? 'end your turn or keep working, and the results start a new turn (or ride on your next tool result) when they are in.'
    : 'keep working, or end your turn: the results arrive with the next message (waking is off).'
}

/** Whether the command runs a script (bash x.sh, ./run, python x.py) whose text calls sbatch. */
async function runsSubmitScript($: $, command: string): Promise<boolean> {
  const cwd = await $.session.cwd()
  for (const path of scriptsRun(command, cwd).slice(0, 4)) {
    const text = await $.fs.read(path).catch(() => null)
    if (text !== null && /\bsbatch\b/.test(text.slice(0, 200_000))) return true
  }
  return false
}

/** Of `ids`, your jobs still queued that were submitted at or after `since` (ms). */
async function submittedSince(run: Run, ids: readonly string[], since: number): Promise<string[]> {
  const r = await run(['squeue', '--me', '-h', '-r', '-j', ids.join(','), '-o', '%F|%V'], { timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return []
  const ok = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    const [id, submit] = line.trim().split('|')
    const at = Date.parse(submit ?? '')
    if (id && Number.isFinite(at) && at >= since - 5000) ok.add(id)
  }
  return [...ok]
}

/**
 * Adopts the person's new jobs for each background command still watched: above
 * the queue top when it started, submitted after it started, and named by it
 * (job name or script file name in its text, or a --wrap job from a --wrap command).
 */
async function adoptWatched($: $, now: number): Promise<void> {
  watches = watches.filter(w => w.until > now)
  if (!watches.length) return
  const r = await runner($)(['squeue', '--me', '-h', '-r', '-o', '%F|%j|%o|%V'], { timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return
  const rows = r.stdout.split('\n').map(l => l.trim().split('|')).filter(c => c.length >= 4)
  for (const w of watches) {
    const ids = rows
      .filter(([id, name, cmd, submit]) => {
        if (!(Number(id) > w.top) || !(Date.parse(submit!) >= w.since - 5000)) return false
        const file = (cmd ?? '').split('/').pop() ?? ''
        return (name !== '' && name !== 'wrap' && w.text.includes(name!)) || (file.length > 2 && w.text.includes(file)) || (name === 'wrap' && w.text.includes('--wrap'))
      })
      .map(([id]) => id!)
    if (ids.length) await follow($, ids, w.owner, 'sbatch', w.group)
  }
}

async function guardFindings($: $, command: string): Promise<Finding[]> {
  let allocated: Set<string> | null = null
  if (/\bssh\b/.test(command) && /\bsprc\d+/.test(command)) {
    const r = await $.process.run(['squeue', '--me', '-h', '-t', 'R', '-o', '%N']).catch(() => null)
    if (r && r.exitCode === 0) allocated = new Set(r.stdout.split('\n').flatMap(l => expandNodes(l.trim())))
  }
  const cwd = await $.session.cwd()
  // A script's own #SBATCH --chdir settles where it runs, so read the scripts named.
  const scripts = new Map<string, string>()
  for (const { script, path } of sbatchScripts(command, cwd)) {
    if (!path || scripts.has(script)) continue
    const text = await $.fs.read(path).catch(() => null)
    if (text !== null) scripts.set(script, text.slice(0, 20_000))
  }
  return checkBash(command, { cwd, allocatedNodes: allocated, isLoginNode, scripts })
}

function why(err: { kind: string; message?: string }): string {
  return err.message ? `${err.kind}: ${err.message}` : err.kind
}

// ---- hooks -------------------------------------------------------------------

export const register: Register = (on, options) => {
  cfg.pollMs = Math.max(10, Number(options['pollSeconds'] ?? 30)) * 1000
  cfg.guards = String(options['guards'] ?? 'enforce')
  cfg.liveContext = options['liveContext'] !== false
  cfg.wake = options['wake'] !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Only on the sprc cluster: another site's Slurm, or no Slurm, gets nothing.
    const probe = await $.process.run(['scontrol', 'show', 'config'], { timeoutMs: 5000 }).catch(() => null)
    if (!probe || probe.exitCode !== 0 || !/^ClusterName\s*=\s*sprc\s*$/m.test(probe.stdout)) {
      await put($, 'isEnabled', () => false)
      return started
    }
    user = (await $.env.get('USER')) ?? ''
    const host = await $.process.run(['hostname', '-s']).catch(() => null)
    isLoginNode = (host?.stdout.trim() ?? '') === 'sprlab005'
    await put($, 'isEnabled', () => true)

    await $.command.register({
      name: 'sprc',
      description: 'sprc cluster summary and followed jobs: /sprc, /sprc follow <ids>, /sprc unfollow <ids>',
      argumentHint: '[follow <ids> | unfollow <ids>]',
      immediate: true,
    })
    await registerTools($)
    await poll($)
    $.clock.every(cfg.pollMs, () => void poll($, true))
    return started
  })

  // ---- the main conversation's turns: when to wake it, and job groups

  on('turn.start', async ($, e, next) => {
    mainTurn = { id: e.turnId }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (mainTurn?.id === e.turnId) {
      mainTurn = null
      idleTurn++
      // Whatever came in during the turn and found no tool result to ride on.
      if ((await get($, 'isEnabled')) && (await get($, 'outbox')).some(n => n.owner === undefined)) void deliver($)
    }
    return r
  })

  // ---- slash command

  on('command.run', { command: 'sprc' }, async ($, e) => {
    if (!(await get($, 'isEnabled'))) return { text: 'sprc: not on the sprc cluster.' }
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    if (sub === 'follow' || sub === 'unfollow') {
      const ids = jobIds(rest.join(' '))
      if (!ids) return { text: `sprc: usage: /sprc ${sub} <job ids>` }
      if (sub === 'unfollow') {
        await put($, 'followed', list => list.filter(f => !ids.map(parentId).includes(f.id)))
        return { text: `sprc: stopped following ${idRanges(ids.map(parentId))}.` }
      }
      const out: string[] = []
      const ok: string[] = []
      for (const id of ids) {
        const refusal = await followRefusal($, id)
        if (refusal) out.push(refusal)
        else ok.push(id)
      }
      await follow($, ok, undefined, 'person')
      if (ok.length) out.unshift(`following ${idRanges(ok.map(parentId))}`)
      return { text: `sprc: ${out.join('\n')}` }
    }
    await poll($)
    const follows = await get($, 'followed')
    return { text: `${summary(await get($, 'snapshot'))}${follows.length ? `\nFollowing: ${idRanges(follows.map(f => f.id))}` : ''}` }
  })

  // ---- model tools. A failure becomes the tool's result, never a missing answer.

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_status' }, async $ => ({ result: await statusTool($) })).catch(($, e, next) => ({
    result: `sprc_status failed: ${why(next.error)}`,
  }))

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_job' }, async ($, e) => ({ result: await jobTool($, e as unknown as Record<string, unknown>) })).catch(($, e, next) => ({
    result: `sprc_job failed: ${why(next.error)}`,
  }))

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_follow' }, async ($, e) => ({ result: await followTool($, e as unknown as Record<string, unknown>, e.agentId) })).catch(($, e, next) => ({
    result: `sprc_follow failed: ${why(next.error)}`,
  }))

  // ---- guardrails and sbatch tracking on Bash

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await get($, 'isEnabled'))) return next(e)
    const command = e.command
    const isGuarded = cfg.guards !== 'off' && /\b(sbatch|ssh|sacct|torchrun|deepspeed|accelerate|vllm|sglang|python[\d.]*)\b/.test(command)

    // Everything the mod does here is advisory: if it fails, the command runs as if the mod were not there.
    let findings: Finding[] = []
    let isSubmit = false
    let top = Infinity
    const startedAt = await $.clock.now()
    try {
      // sbatch anywhere in the text (a heredoc'd script, a loop) or in a script the command runs.
      isSubmit = runsSbatch(command) || /\bsbatch\b/.test(command) || (await runsSubmitScript($, command))
      if (isGuarded) findings = await guardFindings($, command)
      if (isSubmit) top = await queueTop(runner($))
    } catch (err) {
      $.ui.log(`sprc guard skipped: ${String(err)}`, { to: 'debug' })
    }
    const blocking = findings.filter(f => f.level === 'reject')
    if (blocking.length && cfg.guards === 'enforce') {
      $.ui.toast(`sprc blocked: ${blocking.map(f => f.rule).join(', ')}`)
      return { deny: `[sprc guard] ${blocking.map(f => f.message).join('\n')}\n(The user can relax this with /config → sprc-slurm-mods guards.)` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      const notes = findings
        .filter(f => f.level !== 'reject' || cfg.guards === 'warn')
        .filter(f => f.level === 'reject' || !toldRules.has(f.rule))
        .map(f => (toldRules.add(f.rule), `[sprc guard] ${f.message}`))
      const loop = loopKey(e.agentId)
      if (e.run_in_background) {
        // Its output never comes back here: the poll adopts what it submits.
        if (isSubmit && Number.isFinite(top)) {
          watches.push({ owner: e.agentId, group: groupKey(e.agentId), top, since: startedAt, until: startedAt + WATCH_MS, text: command })
          notes.push(`[sprc] Jobs this background command submits are followed as they reach the queue; ${resultsLine()}`)
          void poll($)
        }
      } else {
        const out = ran.text ?? ''
        let ids = submittedJobs(out, isSubmit && /--parsable\b/.test(command))
        // A command that is not a known submitter but printed sbatch's line (a wrapper, a Makefile):
        // keep only jobs of yours submitted while it ran, so a printed log of old jobs is ignored.
        if (ids.length && !isSubmit) ids = await submittedSince(runner($), ids, startedAt)
        // `JID=$(sbatch --parsable …)` prints nothing: the queue says what is new.
        if (!ids.length && isSubmit) ids = await mineAbove(runner($), top)
        const fresh = await follow($, ids, e.agentId, 'sbatch')
        if (fresh.length) {
          notes.push(
            toldFollowing.has(loop)
              ? `[sprc] Following ${idRanges(fresh)}.`
              : `[sprc] Following ${idRanges(fresh)}${fresh.length > 1 ? ' as a group' : ''}: when ${fresh.length > 1 ? 'they have all' : 'it has'} ended you get one message with results, failures, log paths and right-sizing. Every job you submit is followed this way, so never wait or poll for it: ${resultsLine()}`,
          )
          toldFollowing.add(loop)
          $.ui.toast(`following ${fresh.length === 1 ? `job ${fresh[0]}` : `${fresh.length} jobs`}`)
          void poll($)
        }
      }
      if (!notes.length) return ran
      return { ...ran, context: [...(ran.context ?? []), ...notes] }
    } catch (err) {
      $.ui.log(`sprc: after-Bash tracking failed: ${String(err)}`, { to: 'debug' })
      return ran
    }
  }).catch(($, e, next) => next(e)) // advisory: a failure runs the command as if the mod were not there

  // ---- notices ride on the next tool result of the loop they are for

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!mem.outbox?.length || ran.deny !== undefined || ran.isError) return ran
    try {
      const texts = await takeNotices($, e.agentId)
      if (!texts.length) return ran
      return { ...ran, context: [...(ran.context ?? []), ...texts] }
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))

  // ---- live context and waiting notices on the person's prompts

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || !(await get($, 'isEnabled').catch(() => false))) return next(e)
    const context = [...(e.context ?? [])]
    try {
      context.push(...(await takeNotices($, undefined)))
      if (cfg.liveContext && SLURMY.test(e.text)) {
        const now = await $.clock.now()
        if (now - lastPollAt > 60_000) await poll($)
        const snap = await get($, 'snapshot')
        // An unchanged cluster is already in the conversation: re-send it only
        // after 15 minutes, so a long Slurm-heavy session pays for it once.
        const text = summary(snap)
        if (snap && (text !== lastContext.text || now - lastContext.at >= 15 * 60_000)) {
          lastContext = { text, at: now }
          context.push(text)
        }
      }
    } catch (err) {
      $.ui.log(`sprc prompt context skipped: ${String(err)}`, { to: 'debug' })
    }
    return context.length === (e.context ?? []).length ? next(e) : next({ ...e, context })
  }).catch(($, e, next) => next(e))
}
