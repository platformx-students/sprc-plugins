import { atom, read } from 'claude-code'
import type { EngineInterface, PluginState, Register } from 'claude-code'

import type { Followed, JobReport, Snapshot, View } from '../types'
import { checkBash, submittedJobs } from './guards'
import {
  TERMINAL_STATES,
  expandNodes,
  fetchReport,
  fetchScontrol,
  fetchSnapshot,
  gpuTotals,
  hasJob,
  isBad,
  reportLine,
  tailFile,
} from './slurm'
import type { Run } from './slurm'
import { JobView, Overview, explainReason } from './ui'
import type { Actions } from './ui'

type $ = EngineInterface

const PANE = 'sprc'
const PLUGIN = 'sprc-slurm-mods'
const T = (name: string) => `mcp__${PLUGIN}__${name}`

const REF_snapshot = { plugin: 'sprc-slurm-mods', key: 'snapshot' } as const
const REF_followed = { plugin: 'sprc-slurm-mods', key: 'followed' } as const
const REF_finished = { plugin: 'sprc-slurm-mods', key: 'finished' } as const
const REF_view = { plugin: 'sprc-slurm-mods', key: 'view' } as const
const REF_detail = { plugin: 'sprc-slurm-mods', key: 'detail' } as const
const REF_budget = { plugin: 'sprc-slurm-mods', key: 'budget' } as const
const REF_isEnabled = { plugin: 'sprc-slurm-mods', key: 'isEnabled' } as const
const REF_hasOpened = { plugin: 'sprc-slurm-mods', key: 'hasOpened' } as const
const snapshot = atom(REF_snapshot, null)
const followed = atom(REF_followed, [])
const finished = atom(REF_finished, [])
const view = atom(REF_view, { kind: 'overview' } as View)
const detail = atom(REF_detail, null)
const budget = atom(REF_budget, null)
const isEnabled = atom(REF_isEnabled, false)
const hasOpened = atom(REF_hasOpened, false)

// Slurm's own words and cluster phrases only: "job", "node" or "queue" alone
// mostly mean CI, Node.js or a web queue.
const SLURMY =
  /\b(slurm|sbatch|salloc|srun|squeue|sacct|sinfo|scancel|scontrol|gpus?|h100s?|sprc\w*|sprlab005|my jobs?|the queue|the cluster|compute nodes?|scavenger|expedite)\b/i

// Reads within one dispatch see the state as it stood when the dispatch
// began, so a value written mid-hook reads stale. This module is the only
// writer of its values, so it keeps them here too: `get` answers from the
// cache, `put` writes both. A reload empties the cache; the next `get` loads
// from the host. Render hooks still `read` the atoms, which subscribes them.
type S = PluginState['sprc-slurm-mods']
const mem: { [K in keyof S]?: S[K] } = {}
async function load<K extends keyof S>($: $, k: K): Promise<S[K]> {
  switch (k) {
    case 'snapshot':
      return (await read($, snapshot)) as S[K]
    case 'followed':
      return (await read($, followed)) as S[K]
    case 'finished':
      return (await read($, finished)) as S[K]
    case 'view':
      return (await read($, view)) as S[K]
    case 'detail':
      return (await read($, detail)) as S[K]
    case 'budget':
      return (await read($, budget)) as S[K]
    case 'isEnabled':
      return (await read($, isEnabled)) as S[K]
    case 'hasOpened':
      return (await read($, hasOpened)) as S[K]
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
    case 'view':
      await $.state.set(REF_view, v as S['view'])
      break
    case 'detail':
      await $.state.set(REF_detail, v as S['detail'])
      break
    case 'budget':
      await $.state.set(REF_budget, v as S['budget'])
      break
    case 'isEnabled':
      await $.state.set(REF_isEnabled, v as S['isEnabled'])
      break
    case 'hasOpened':
      await $.state.set(REF_hasOpened, v as S['hasOpened'])
      break
  }
}

// Module-local; a reload starts these over, and the next poll refills them.
const cfg = { pollMs: 30_000, autoOpen: true, guards: 'enforce', liveContext: true }
let user = ''
let isLoginNode = false
let isPolling = false
let lastBudgetAt = 0
let lastPollAt = 0
// The last snapshot that read cleanly: jobs are diffed against it, so a
// failed poll in between does not lose the jobs that ended meanwhile.
let lastGood: Snapshot | null = null
// What the prompt hook last attached, so an unchanged cluster is not re-sent.
let lastContext = { text: '', at: 0 }
// Jobs an sprc_wait call is blocked on: that call reports their end, so the
// background poll must not post it a second time.
const awaited = new Set<string>()

function runner($: $): Run {
  return (argv, init) => $.process.run(argv, { timeoutMs: init?.timeoutMs ?? 20_000 })
}

// ---- polling ---------------------------------------------------------

async function refreshDetail($: $, id: string): Promise<void> {
  const run = runner($)
  const now = await $.clock.now()
  const fields = (await fetchScontrol(run, id)) ?? {}
  const state = fields['JobState']
  let report: JobReport | undefined
  if (!state || TERMINAL_STATES.has(state)) report = (await fetchReport(run, id, now)) ?? undefined
  let stdout = fields['StdOut']
  if (!stdout && report) stdout = report.stdout
  const log = stdout ? await tailFile(run, stdout, 60) : []
  await put($, 'detail', () => ({ id, fields, log, report, at: now }))
}

async function onJobsEnded($: $, ended: readonly string[], prevMine: Snapshot['mine']): Promise<void> {
  const run = runner($)
  const now = await $.clock.now()
  const follows = await get($, 'followed')
  const done: { report: JobReport; wake: boolean }[] = []
  for (const id of ended) {
    const report =
      (await fetchReport(run, id, now)) ??
      ({
        id,
        name: prevMine.find(j => j.id === id)?.name ?? '',
        state: 'ENDED',
        exitCode: '?',
        elapsed: '?',
        limit: '?',
        nodes: '',
        cpus: 0,
        gpus: 0,
        reqMem: '?',
        maxRss: '?',
        advice: [],
        endedAt: now,
      } satisfies JobReport)
    await put($, 'finished', list => [report, ...list.filter(r => r.id !== id)].slice(0, 20))
    const follow = follows.find(f => f.id === id)
    if (follow && !awaited.has(id)) done.push({ report, wake: follow.wake })
  }
  if (follows.some(f => ended.includes(f.id))) await put($, 'followed', list => list.filter(f => !ended.includes(f.id)))
  if (!done.length) return
  // One toast, one note and at most one woken turn per poll, however many ended.
  const bad = done.filter(d => isBad(d.report.state)).length
  const [first] = done
  $.ui.toast(
    done.length === 1
      ? `${bad ? '✗' : '✓'} job ${first!.report.id} ${first!.report.state} (${first!.report.elapsed})`
      : `${done.length} followed jobs ended: ${done.length - bad} ✓ ${bad} ✗`,
    { timeoutMs: 8000 },
  )
  const note = done
    .map(({ report: r }) => `[sprc] Followed ${reportLine(r)}.${r.advice.length ? ' Right-sizing: ' + r.advice.join('; ') + '.' : ''}`)
    .join('\n')
  if (done.some(d => d.wake)) {
    void $.prompt.submit({
      text: `${note}\n${done.length === 1 ? 'The job you were following has' : 'Jobs you were following have'} ended. Check the result (use sprc_job for the log and details) and report back${bad ? ', diagnosing the failure' : ''}.`,
    } as Parameters<$['prompt']['submit']>[0])
  } else {
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
      .catch(err => $.ui.log(`sprc: job-end note not added: ${String(err)}`, { to: 'debug' }))
  }
}

/**
 * `isTimer`: a background tick. With no jobs of yours and nothing followed,
 * those run at a quarter of the configured rate; anything that needs fresh
 * data (a tool, /sprc, a cluster-ish prompt) polls on its own.
 */
async function poll($: $, isTimer = false): Promise<void> {
  if (isPolling || !user) return
  const now = await $.clock.now()
  if (isTimer && now - lastPollAt < 4 * cfg.pollMs - 1000) {
    const snap = await get($, 'snapshot')
    const isIdle = !!snap && !snap.error && snap.mine.length === 0 && (await get($, 'followed')).length === 0
    if (isIdle) return
  }
  isPolling = true
  lastPollAt = now
  try {
    const snap = await fetchSnapshot(runner($), user, now)
    await put($, 'snapshot', () => snap)
    if (!snap.error) {
      const prev = lastGood
      lastGood = snap
      const follows = await get($, 'followed')
      // Ended: was in the last good read and is gone, or is followed (since
      // before this read began) and absent: that also catches a job that ended
      // before it was followed, or an array job whose tasks all finished.
      const ended = new Set(prev ? prev.mine.filter(j => !hasJob(snap.mine, j.id)).map(j => j.id) : [])
      for (const f of follows) if ((f.since ?? 0) < now && !hasJob(snap.mine, f.id)) ended.add(f.id)
      if (ended.size) await onJobsEnded($, [...ended], prev?.mine ?? [])
      // Started: a followed job went PD -> R.
      const followIds = new Set(follows.map(f => f.id))
      for (const j of snap.mine) {
        const was = prev?.mine.find(p => p.id === j.id)
        if (was && was.state === 'PD' && j.state === 'R' && followIds.has(j.id)) {
          $.ui.toast(`▶ job ${j.id} started on ${j.nodes}`)
        }
      }
    }
    setStatus($, snap)
    const v = await get($, 'view')
    if (v.kind === 'job' && (await $.ui.panes()).some(p => p.id === PANE)) await refreshDetail($, v.id)
    if (now - lastBudgetAt > 5 * 60_000) {
      lastBudgetAt = now
      await refreshBudget($, now)
    }
  } catch (err) {
    $.ui.log(`sprc poll failed: ${String(err)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

async function refreshBudget($: $, now: number): Promise<void> {
  const r = await $.process.run(['mybudget', '--no-color'], { timeoutMs: 15_000 }).catch(() => null)
  if (!r || r.exitCode !== 0 || /not enrolled/i.test(r.stdout)) {
    await put($, 'budget', () => null)
    return
  }
  const lines = r.stdout
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() && !/^\s*-+\s*$/.test(l))
  await put($, 'budget', () => ({ lines: lines.slice(0, 12), at: now }))
}

function setStatus($: $, snap: Snapshot): void {
  if (snap.error) {
    $.ui.status('sprc ▸ Slurm unreachable')
    return
  }
  const g = gpuTotals(snap.nodes)
  const r = snap.mine.filter(j => j.state === 'R').length
  const pd = snap.mine.filter(j => j.state === 'PD').length
  const mine = snap.mine.length ? ` · you ${r}R ${pd}PD` : ''
  $.ui.status(`sprc ▸ ${g.usable}/${g.total} GPU free${g.idle > g.usable ? ` (+${g.idle - g.usable} stranded)` : ''}${mine} · queue ${snap.others.pending + pd}`)
}

function summary(snap: Snapshot | null): string {
  if (!snap) return 'sprc: no data yet'
  if (snap.error) return `sprc: Slurm unreachable (${snap.error})`
  const g = gpuTotals(snap.nodes)
  const r = snap.mine.filter(j => j.state === 'R')
  const pd = snap.mine.filter(j => j.state === 'PD')
  return `[sprc live] ${g.usable}/${g.total} GPUs free for a default GPU job${g.idle > g.usable ? ` (${g.idle - g.usable} more idle on nodes short of the 32 CPU + 375G that go with a GPU by default)` : ''} (${snap.nodes.map(n => `${n.name} ${n.gpus - n.gpusUsed}/${n.gpus} idle, ${n.cpusTotal - n.cpusAlloc} CPU free`).join('; ')}); your jobs: ${r.length} running, ${pd.length} pending; others: ${snap.others.running} running, ${snap.others.pending} pending.`
}

// ---- actions the pane's buttons call -----------------------------------

function actionsFor($: $): Actions {
  return {
    refresh: () => void poll($),
    open: id => {
      void (async () => {
        await put($, 'view', () => ({ kind: 'job', id }) as View)
        await refreshDetail($, id)
      })()
    },
    back: () => void put($, 'view', () => ({ kind: 'overview' }) as View),
    cancel: id => {
      void (async () => {
        const answer = await $.ui.ask(`Cancel job ${id}?`, ['Keep it', 'scancel it']).catch(() => 'Keep it')
        if (answer !== 'scancel it') return
        const r = await $.process.run(['scancel', id])
        $.ui.toast(r.exitCode === 0 ? `scancel ${id} sent` : `scancel failed: ${r.stderr.trim()}`)
        await poll($)
        await refreshDetail($, id)
      })()
    },
    toggleFollow: id => {
      void (async () => {
        if ((await get($, 'followed')).some(f => f.id === id)) {
          await put($, 'followed', list => list.filter(f => f.id !== id))
          return
        }
        const refusal = await followRefusal($, id)
        if (refusal) $.ui.toast(refusal)
        else await followJob($, id, false, 'person')
      })()
    },
    clearFinished: () => void put($, 'finished', () => []),
  }
}

async function followJob($: $, id: string, wake: boolean, origin: Followed['origin']): Promise<void> {
  const since = await $.clock.now()
  await put($, 'followed', list => [...list.filter(f => f.id !== id), { id, wake, origin, since }])
}

/**
 * Why job `id` cannot be followed, or null if it can: it must be yours and
 * still queued or running. An ended one is recorded and its result returned,
 * so the caller learns it now instead of waiting on an end that never comes.
 */
async function followRefusal($: $, id: string): Promise<string | null> {
  const run = runner($)
  const q = await run(['squeue', '-h', '-j', id, '-o', '%u'])
  const owners = new Set(q.exitCode === 0 ? q.stdout.split('\n').map(l => l.trim()).filter(Boolean) : [])
  if (owners.size) return owners.has(user) ? null : `Job ${id} is not yours; only your own jobs can be followed.`
  const report = await fetchReport(run, id, await $.clock.now())
  if (!report) return `Job ${id} is not queued or running, and sacct has no record of it. Check the id.`
  if (report.user && report.user !== user) return `Job ${id} is not yours; only your own jobs can be followed.`
  await put($, 'finished', list => [report, ...list.filter(r => r.id !== id)].slice(0, 20))
  return `Job ${id} has already ended: ${reportLine(report)}${report.advice.length ? `\nRight-sizing: ${report.advice.join('; ')}` : ''}`
}

async function registerTools($: $): Promise<void> {
  await $.tool.register({
    name: 'sprc_status',
    description:
      'Live state of the sprc Slurm cluster: free GPUs per node, all of your queued/running jobs with pending reasons, queue depth, and your recently finished jobs with efficiency. Cheaper and more reliable than parsing squeue/sinfo yourself.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'sprc_job',
    description:
      "Full lifecycle of one Slurm job (running, pending or finished): state and pending reason explained, submit/start/end times and queue wait, resources, working dir and log paths, the last lines of its stdout log, and for finished jobs CPU/memory/time efficiency with concrete right-sizing advice for the next submission.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The Slurm job id, e.g. "80240".' },
        log_lines: { type: 'number', description: 'How many trailing log lines to include (default 40, max 200).' },
        stderr: { type: 'boolean', description: 'Tail StdErr instead of StdOut (when they differ).' },
      },
      required: ['job_id'],
    },
  })
  await $.tool.register({
    name: 'sprc_wait',
    description:
      'Block until a Slurm job starts or ends (or changes state), up to 10 minutes per call, then return its state. Use this instead of sleep/squeue polling loops. If it times out, either call again or use sprc_follow and end your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        until: { type: 'string', enum: ['start', 'end', 'change'], description: 'Default "end".' },
        timeout_minutes: { type: 'number', description: '1-10, default 10.' },
      },
      required: ['job_id'],
    },
  })
  await $.tool.register({
    name: 'sprc_follow',
    description:
      'Follow a Slurm job in the background: when it ends the user gets a notification and you get a note with its result and efficiency. With wake=true a new turn starts automatically when it ends so you can check the result (use when the user asked to be told / to have results checked when a long job finishes). Jobs submitted with sbatch in this session are followed automatically (without wake). Set stop=true to unfollow.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wake: { type: 'boolean', description: 'Start a new turn when the job ends. Default false.' },
        stop: { type: 'boolean' },
      },
      required: ['job_id'],
    },
  })
}

export const register: Register = (on, options) => {
  cfg.pollMs = Math.max(10, Number(options['pollSeconds'] ?? 30)) * 1000
  cfg.autoOpen = options['autoOpen'] !== false
  cfg.guards = String(options['guards'] ?? 'enforce')
  cfg.liveContext = options['liveContext'] !== false

  // ---- session start -----------------------------------------------------

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
      description: 'sprc cluster dashboard: /sprc, /sprc job <id>, /sprc follow <id>, /sprc refresh, /sprc close',
      argumentHint: '[job <id> | follow <id> | refresh | close]',
      immediate: true,
    })
    await registerTools($)

    await poll($)
    $.clock.every(cfg.pollMs, () => void poll($, true))
    // session.start runs again on a reload or worker respawn: open the pane
    // the first time only, so one the person closed stays closed.
    if (cfg.autoOpen && e.isInteractive && !(await get($, 'hasOpened'))) {
      await put($, 'hasOpened', () => true)
      void $.ui.open({ id: PANE, title: 'sprc' })
    }
    return started
  })

  // ---- slash command -------------------------------------------------------

  on('command.run', { command: 'sprc' }, async ($, e) => {
    if (!(await get($, 'isEnabled'))) return { text: 'sprc: Slurm commands are not available on this machine.' }
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'close') {
      await put($, 'view', () => ({ kind: 'overview' }) as View)
      await $.ui.close({ id: PANE })
      return { text: 'sprc pane closed.' }
    }
    if (sub === 'refresh') {
      await poll($)
      return { text: summary(await get($, 'snapshot')) }
    }
    if ((sub === 'follow' || sub === 'unfollow') && arg) {
      if (sub === 'follow') {
        const refusal = await followRefusal($, arg)
        if (refusal) return { text: `sprc: ${refusal}` }
        await followJob($, arg, false, 'person')
      } else await put($, 'followed', list => list.filter(f => f.id !== arg))
      return { text: `sprc: ${sub === 'follow' ? 'following' : 'stopped following'} job ${arg}.` }
    }
    if ((sub === 'job' || /^\d+$/.test(sub ?? '')) && (arg ?? sub)) {
      const id = sub === 'job' ? arg! : sub!
      await put($, 'view', () => ({ kind: 'job', id }) as View)
      await $.ui.open({ id: PANE, title: 'sprc' })
      void refreshDetail($, id)
      return { text: `sprc: showing job ${id}.` }
    }
    await put($, 'view', () => ({ kind: 'overview' }) as View)
    const opened = await $.ui.open({ id: PANE, title: 'sprc' })
    return { text: opened.isPlaced ? 'sprc dashboard opened.' : summary(await get($, 'snapshot')) }
  })

  // ---- the pane ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const v = await read($, view)
    const snap = await read($, snapshot)
    const follows = await read($, followed)
    const now = await $.clock.now()
    if (!(await read($, isEnabled))) {
      const { Text } = el
      return <Text dimColor>Slurm is not available on this machine.</Text>
    }
    if (v.kind === 'job') {
      return JobView(el, {
        id: v.id,
        detail: await read($, detail),
        snap,
        isFollowed: follows.some(f => f.id === v.id),
        columns,
        logRows: Math.max(5, (e.viewport?.rows ?? 40) - 24),
        actions: actionsFor($),
      })
    }
    return Overview(el, {
      snap,
      finished: await read($, finished),
      followed: follows,
      budget: await read($, budget),
      now,
      columns,
      actions: actionsFor($),
    })
  })

  // ---- model tools -----------------------------------------------------------

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_status' }, async $ => {
    await poll($)
    const snap = await get($, 'snapshot')
    const fin = await get($, 'finished')
    const lines = [summary(snap)]
    // Bounded: a campaign of hundreds of jobs must not become hundreds of lines.
    const mine = snap?.mine ?? []
    const running = mine.filter(j => j.state !== 'PD')
    const pending = mine.filter(j => j.state === 'PD')
    for (const j of running.slice(0, 12)) {
      lines.push(`  ${j.id} ${j.state.padEnd(2)} ${j.name} · ${j.elapsed}/${j.limit} on ${j.nodes} · ${j.gpus} GPU ${j.cpus} CPU ${j.mem} · qos ${j.qos}`)
    }
    if (running.length > 12) lines.push(`  … ${running.length - 12} more running`)
    for (const j of pending.slice(0, 8)) {
      lines.push(
        `  ${j.id} PD ${j.name} · ${explainReason(j.reason)}${j.start !== 'N/A' ? ` · est. start ${j.start}` : ''} · ${j.gpus} GPU ${j.cpus} CPU ${j.mem} · qos ${j.qos}`,
      )
    }
    if (pending.length > 8) {
      const why = new Map<string, number>()
      for (const j of pending.slice(8)) why.set(j.reason, (why.get(j.reason) ?? 0) + 1)
      lines.push(`  … ${pending.length - 8} more pending (${[...why].map(([k, n]) => `${explainReason(k)} ×${n}`).join(', ')})`)
    }
    if (fin.length) {
      lines.push(`Recently finished (yours, since this session began${fin.length > 5 ? `; newest 5 of ${fin.length}` : ''}):`)
      for (const r of fin.slice(0, 5)) lines.push(`  ${reportLine(r)}${r.advice.length ? ' → ' + r.advice.join('; ') : ''}`)
    }
    const follows = await get($, 'followed')
    if (follows.length) lines.push(`Following: ${follows.map(f => f.id + (f.wake ? ' (wake)' : '')).join(', ')}`)
    return { result: lines.join('\n') }
  })

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_job' }, async ($, e) => {
    const args = e as unknown as { job_id: string; log_lines?: number; stderr?: boolean }
    const id = String(args.job_id ?? '').trim()
    if (!/^\d+(_\d+)?$/.test(id)) return { deny: `sprc_job: "${id}" is not a job id.` }
    const run = runner($)
    const now = await $.clock.now()
    const fields = await fetchScontrol(run, id)
    const state = fields?.['JobState']
    const report = !state || TERMINAL_STATES.has(state) ? await fetchReport(run, id, now) : null
    if (!fields && !report) return { result: `Job ${id}: unknown to scontrol and sacct.` }
    const out: string[] = []
    if (fields) {
      const f = fields
      out.push(`Job ${id} "${f['JobName']}" ${f['JobState']}${f['Reason'] && f['Reason'] !== 'None' ? ` (${f['Reason']}: ${explainReason(f['Reason'])})` : ''}`)
      out.push(`  user ${f['UserId']} · partition ${f['Partition']} · qos ${f['QOS']} · nodes ${f['NodeList'] || '-'}`)
      out.push(`  TRES ${f['AllocTRES'] || f['ReqTRES'] || '?'} · time ${f['RunTime']} of ${f['TimeLimit']}`)
      out.push(`  submitted ${f['SubmitTime']} · start ${f['StartTime']} · end ${f['EndTime']} · restarts ${f['Restarts'] ?? 0} · requeue ${f['Requeue'] ?? '?'}`)
      out.push(`  workdir ${f['WorkDir']}`)
      out.push(`  command ${f['Command']}`)
      out.push(`  stdout ${f['StdOut']}${f['StdErr'] !== f['StdOut'] ? `\n  stderr ${f['StdErr']}` : ''}`)
      if (f['ExitCode']) out.push(`  exit ${f['ExitCode']}`)
    }
    if (report) {
      out.push(`Accounting: ${reportLine(report)}`)
      if (report.advice.length) out.push(`Right-sizing: ${report.advice.join('; ')}`)
      else if (report.state === 'COMPLETED') out.push('Right-sizing: request looked about right.')
    }
    const path = args.stderr ? fields?.['StdErr'] : fields?.['StdOut']
    if (path) {
      const n = Math.max(1, Math.min(200, Number(args.log_lines ?? 40)))
      const log = await tailFile(run, path, n)
      out.push(`--- last ${log.length} lines of ${path} ---`, ...log)
    } else if (!fields) {
      out.push('(scontrol has forgotten this job, so the log path is unknown; check the job script for --output)')
    }
    return { result: out.join('\n') }
  })

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_wait' }, async ($, e) => {
    const args = e as unknown as { job_id: string; until?: string; timeout_minutes?: number }
    const id = String(args.job_id ?? '').trim()
    if (!/^\d+(_\d+)?$/.test(id)) return { deny: `sprc_wait: "${id}" is not a job id.` }
    const until = args.until === 'start' || args.until === 'change' ? args.until : 'end'
    const minutes = Math.max(1, Math.min(10, Number(args.timeout_minutes ?? 10)))
    // The loop runs on the host (squeue every 15 s), so the hook's own time
    // budget is not spent while it waits.
    const script = `
id="$1"; until="$2"; deadline=$(( $(date +%s) + $3 ))
st() { squeue -h -j "$id" -o %T 2>/dev/null | sort -u | paste -sd, -; }
first=$(st)
while :; do
  s=$(st)
  if [ -z "$s" ]; then echo "ENDED"; exit 0; fi
  case "$until" in
    start) [ "$s" != PENDING ] && { echo "$s"; exit 0; } ;;
    change) [ "$s" != "$first" ] && { echo "$s"; exit 0; } ;;
  esac
  [ $(date +%s) -ge $deadline ] && { echo "TIMEOUT $s"; exit 0; }
  sleep 15
done`
    awaited.add(id)
    let outcome: string
    try {
      const r = await $.process.run(['bash', '-c', script, 'sprc_wait', id, until, String(minutes * 60)], {
        timeoutMs: minutes * 60_000 + 30_000,
      })
      outcome = r.stdout.trim()
      // This call reports the end itself: unfollow first so the poll does not
      // add the same result again as a note.
      if (outcome === 'ENDED') await put($, 'followed', list => list.filter(f => f.id !== id))
      await poll($)
    } finally {
      awaited.delete(id)
    }
    if (outcome === 'ENDED') {
      const report = await fetchReport(runner($), id, await $.clock.now())
      return {
        result: report
          ? `Job ${id} has ended: ${reportLine(report)}${report.advice.length ? `\nRight-sizing: ${report.advice.join('; ')}` : ''}\nUse sprc_job for its log.`
          : `Job ${id} is no longer in the queue (sacct has no record yet).`,
      }
    }
    if (outcome.startsWith('TIMEOUT')) {
      return {
        result: `Job ${id} still ${outcome.slice(8) || 'unknown'} after ${minutes} min. Call sprc_wait again, or sprc_follow (wake=true) and end your turn so the user is not blocked.`,
      }
    }
    return { result: `Job ${id} is now ${outcome}.` }
  })

  on('tool.call', { tool: 'mcp__sprc-slurm-mods__sprc_follow' }, async ($, e) => {
    const args = e as unknown as { job_id: string; wake?: boolean; stop?: boolean }
    const id = String(args.job_id ?? '').trim()
    if (!/^\d+(_\d+)?$/.test(id)) return { deny: `sprc_follow: "${id}" is not a job id.` }
    if (args.stop) {
      await put($, 'followed', list => list.filter(f => f.id !== id))
      return { result: `Stopped following job ${id}.` }
    }
    const refusal = await followRefusal($, id)
    if (refusal) return { result: refusal }
    await followJob($, id, args.wake === true, 'tool')
    return {
      result: args.wake
        ? `Following job ${id}. When it ends, a new turn will start with its result; you can end this turn now.`
        : `Following job ${id}. When it ends the user is notified and a note with its result is added to the conversation.`,
    }
  })

  // ---- guardrails and sbatch tracking on Bash --------------------------------

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await get($, 'isEnabled'))) return next(e)
    const command = e.command
    const isSubmit = /\b(sbatch|salloc)\b/.test(command)
    const isGuarded =
      cfg.guards !== 'off' && /\b(sbatch|salloc|srun|ssh|sacct|squeue|scontrol|torchrun|deepspeed|accelerate|vllm|sglang|python[\d.]*)\b/.test(command)
    if (!isSubmit && !isGuarded) return next(e)

    let allocated: Set<string> | null = null
    if (isGuarded && /\bssh\b/.test(command) && /\bsprc\d+/.test(command)) {
      const r = await $.process.run(['squeue', '--me', '-h', '-t', 'R', '-o', '%N']).catch(() => null)
      if (r && r.exitCode === 0) allocated = new Set(r.stdout.split('\n').flatMap(l => expandNodes(l.trim())))
    }
    const findings = isGuarded
      ? checkBash(command, { cwd: await $.session.cwd(), allocatedNodes: allocated, isLoginNode, waitTool: T('sprc_wait') })
      : []
    const blocking = findings.filter(f => f.level !== 'note')
    if (blocking.length && cfg.guards === 'enforce') {
      $.ui.toast(`sprc blocked: ${blocking.map(f => f.rule).join(', ')}`)
      return { deny: `[sprc guard] ${blocking.map(f => f.message).join('\n')}\n(The user can relax this with /config → sprc-slurm-mods guards.)` }
    }

    const ran = await next(e)
    const notes = findings.map(f => `[sprc guard] ${f.message}`)
    if (ran.deny === undefined) {
      const ids = isSubmit ? submittedJobs(ran.text ?? '', /--parsable\b/.test(command)) : []
      if (ids.length) {
        for (const id of ids) await followJob($, id, false, 'sbatch')
        notes.push(
          `[sprc] Following job${ids.length > 1 ? 's' : ''} ${ids.join(', ')}: the user sees it in the sprc pane and gets notified when it ends. Use sprc_wait / sprc_job instead of polling squeue.`,
        )
        $.ui.toast(`following job ${ids.join(', ')}`)
      }
      if (ids.length || /\bscancel\b/.test(command)) void poll($)
    }
    if (!notes.length || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  })

  // ---- live context on cluster-ish prompts -----------------------------------

  on('prompt.submit', async ($, e, next) => {
    if (!cfg.liveContext || e.origin.kind === 'plugin' || !SLURMY.test(e.text)) return next(e)
    if (!(await get($, 'isEnabled'))) return next(e)
    const now = await $.clock.now()
    if (now - lastPollAt > 60_000) await poll($)
    const snap = await get($, 'snapshot')
    if (!snap) return next(e)
    // An unchanged cluster is already in the conversation: re-send it only
    // after 15 minutes, so a long Slurm-heavy session pays for it once.
    const text = summary(snap)
    if (text === lastContext.text && now - lastContext.at < 15 * 60_000) return next(e)
    lastContext = { text, at: now }
    return next({ ...e, context: [...(e.context ?? []), text] })
  })
}
