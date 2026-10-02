// The dashboard pane's drawing. Only Box, Text and Button, which every
// surface (terminal, desktop, vscode, mobile) has.

import type { Elements } from 'claude-code'

import type { Budget, Followed, JobDetail, JobReport, JobRow, Snapshot } from '../types'
import { durationSeconds, formatDuration, gpuTotals, isBad, nodeUsable, pct } from './slurm'

export type El = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>

export type Actions = {
  refresh: () => void
  open: (id: string) => void
  back: () => void
  cancel: (id: string) => void
  toggleFollow: (id: string) => void
  clearFinished: () => void
}

const STATE_COLOR: Record<string, string> = {
  R: 'green',
  PD: 'yellow',
  CG: 'cyan',
  S: 'magenta',
}

export function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0))
  const full = Math.round(f * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

function clock(iso: string): string {
  const m = /T(\d\d:\d\d)/.exec(iso)
  return m ? m[1]! : iso
}

const REASONS: Record<string, string> = {
  Priority: 'waiting behind higher-priority jobs',
  Resources: 'next in line; waiting for resources to free',
  Dependency: 'waiting on a dependency',
  DependencyNeverSatisfied: 'dependency failed; will never start (scancel it)',
  JobArrayTaskLimit: 'array throttle (%N) reached',
  QOSMaxGRESPerUser: 'at your QoS GPU limit',
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

function shorten(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'
}

export function Overview(
  el: El,
  props: {
    snap: Snapshot | null
    finished: readonly JobReport[]
    followed: readonly Followed[]
    budget: Budget | null
    now: number
    columns: number
    actions: Actions
  },
) {
  const { Box, Text, Button } = el
  const { snap, finished, followed, budget, now, columns, actions } = props
  if (!snap) return <Text dimColor>Reading cluster state…</Text>
  const followedIds = new Set(followed.map(f => f.id))
  const gpus = gpuTotals(snap.nodes)
  const nameW = Math.max(8, columns - 34)
  const running = snap.mine.filter(j => j.state === 'R' || j.state === 'CG')
  const pending = snap.mine.filter(j => j.state !== 'R' && j.state !== 'CG')
  const shown = [...running, ...pending].slice(0, 10)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>
          {gpus.usable}/{gpus.total} GPUs free
          {gpus.idle > gpus.usable ? <Text dimColor> (+{gpus.idle - gpus.usable} stranded)</Text> : null}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{ago(now, snap.at)}</Text>
          <Button key="refresh" label="refresh" hotkey="r" plain onPress={actions.refresh} />
        </Box>
      </Box>
      {snap.error && <Text color="red">Slurm: {snap.error}</Text>}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          NODES
        </Text>
        {snap.nodes.map(n => {
          const cpu = n.cpusTotal ? n.cpusAlloc / n.cpusTotal : 0
          const mem = n.memTotalMb ? n.memAllocMb / n.memTotalMb : 0
          const isOut = /drain|down|fail|maint/i.test(n.state)
          return (
            <Box key={`node-${n.name}`} flexDirection="row" gap={1}>
              <Text>{n.name}</Text>
              <Text color={n.gpusUsed >= n.gpus ? 'red' : nodeUsable(n) === 0 ? 'yellow' : 'green'}>
                {'■'.repeat(n.gpusUsed)}
                {'□'.repeat(Math.max(0, n.gpus - n.gpusUsed))}
              </Text>
              <Text dimColor>cpu</Text>
              <Text color={cpu > 0.9 ? 'red' : undefined}>{bar(cpu, 6)}</Text>
              <Text dimColor>mem</Text>
              <Text>{bar(mem, 4)}</Text>
              <Text color={isOut ? 'red' : undefined} dimColor={!isOut} wrap="truncate-end">
                {n.state}
              </Text>
            </Box>
          )
        })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          YOUR JOBS {snap.mine.length ? `(${running.length} running · ${pending.length} pending)` : ''}
        </Text>
        {snap.mine.length === 0 && <Text dimColor>none queued or running</Text>}
        {shown.map(j => JobLine(el, j, nameW, followedIds.has(j.id), actions))}
        {snap.mine.length > shown.length && <Text dimColor>+{snap.mine.length - shown.length} more</Text>}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          EVERYONE ELSE
        </Text>
        <Text>
          {snap.others.running} running ({snap.others.gpusRunning} GPU) · {snap.others.pending} pending (
          {snap.others.gpusPending} GPU)
        </Text>
      </Box>

      {finished.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor bold>
              RECENTLY FINISHED
            </Text>
            <Button key="clear-finished" label="clear" plain onPress={actions.clearFinished} />
          </Box>
          {finished.slice(0, 6).map(r => (
            <Box key={`fin-${r.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={isBad(r.state) ? 'red' : 'green'}>{isBad(r.state) ? '✗' : '✓'}</Text>
                <Button key={`open-fin-${r.id}`} label={r.id} plain onPress={() => actions.open(r.id)} />
                <Text wrap="truncate-end">
                  {shorten(r.name, nameW)} {r.state} {r.elapsed}
                </Text>
              </Box>
              {r.advice.slice(0, 1).map(a => (
                <Text dimColor wrap="truncate-end">
                  {'   → '}
                  {a}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      {budget && budget.lines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor bold>
            COURSE BUDGET
          </Text>
          {budget.lines.map(l => (
            <Text wrap="truncate-end">{l}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function JobLine(el: El, j: JobRow, nameW: number, isFollowed: boolean, actions: Actions) {
  const { Box, Text, Button } = el
  const isRun = j.state === 'R'
  const used = durationSeconds(j.elapsed)
  const limit = durationSeconds(j.limit)
  return (
    <Box key={`job-${j.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={STATE_COLOR[j.state]}>{j.state.padEnd(2)}</Text>
        <Button key={`open-${j.id}`} label={j.id} plain onPress={() => actions.open(j.id)} />
        <Text wrap="truncate-end">
          {isFollowed ? '★ ' : ''}
          {shorten(j.name, nameW)}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {'      '}
        {isRun
          ? `${bar(used / limit, 8)} ${j.elapsed}/${j.limit} on ${j.nodes}${j.gpus ? ` · ${j.gpus} GPU` : ''}`
          : `${explainReason(j.reason)}${j.start && j.start !== 'N/A' ? ` · est. start ${clock(j.start)}` : ''}`}
      </Text>
    </Box>
  )
}

const DETAIL_FIELDS: readonly [string, string][] = [
  ['Partition', 'partition'],
  ['QOS', 'qos'],
  ['NumCPUs', 'cpus'],
  ['AllocTRES', 'tres'],
  ['ReqTRES', 'requested'],
  ['TimeLimit', 'limit'],
  ['WorkDir', 'workdir'],
  ['StdOut', 'stdout'],
]

export function JobView(
  el: El,
  props: {
    id: string
    detail: JobDetail | null
    snap: Snapshot | null
    isFollowed: boolean
    columns: number
    logRows: number
    actions: Actions
  },
) {
  const { Box, Text, Button } = el
  const { id, detail, isFollowed, actions, logRows } = props
  const f = detail?.id === id ? detail.fields : {}
  const r = detail?.id === id ? detail.report : undefined
  const state = f['JobState'] ?? r?.state ?? '…'
  const isLive = !!f['JobState'] && !/COMPLETED|FAILED|CANCELLED|TIMEOUT|OUT_OF_MEMORY/.test(state)
  const runTime = durationSeconds(f['RunTime'] ?? '')
  const limit = durationSeconds(f['TimeLimit'] ?? '')
  const submit = f['SubmitTime']
  const start = f['StartTime']
  const waitSecs =
    submit && start && start !== 'Unknown' && state !== 'PENDING'
      ? (Date.parse(start) - Date.parse(submit)) / 1000
      : NaN

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Button key="back" label="← back" hotkey="b" plain onPress={actions.back} />
        <Button key="refresh" label="refresh" hotkey="r" plain onPress={actions.refresh} />
        <Button
          key="follow"
          label={isFollowed ? '★ following' : '☆ follow'}
          hotkey="f"
          plain
          onPress={() => actions.toggleFollow(id)}
        />
        {isLive && <Button key="cancel" label="scancel" plain onPress={() => actions.cancel(id)} />}
      </Box>
      <Box marginTop={1} flexDirection="row" gap={1}>
        <Text bold>job {id}</Text>
        <Text color={isBad(state) ? 'red' : state === 'RUNNING' ? 'green' : 'yellow'}>{state}</Text>
        <Text wrap="truncate-end">{f['JobName'] ?? r?.name ?? ''}</Text>
      </Box>
      {!detail || detail.id !== id ? (
        <Text dimColor>Loading…</Text>
      ) : (
        <Box flexDirection="column">
          {state === 'PENDING' && f['Reason'] && (
            <Text color="yellow">
              pending: {explainReason(f['Reason'])}
              {start && start !== 'Unknown' ? ` · est. start ${clock(start)}` : ''}
            </Text>
          )}
          {state === 'RUNNING' && Number.isFinite(limit) && (
            <Text>
              {bar(runTime / limit, 16)} {formatDuration(runTime)} / {formatDuration(limit)} on {f['NodeList']}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">
            submitted {clock(submit ?? '?')}
            {Number.isFinite(waitSecs) ? ` · queued ${formatDuration(waitSecs)} · started ${clock(start!)}` : ''}
            {f['EndTime'] && f['EndTime'] !== 'Unknown' && !isLive ? ` · ended ${clock(f['EndTime'])}` : ''}
            {f['Restarts'] && f['Restarts'] !== '0' ? ` · requeued ${f['Restarts']}×` : ''}
          </Text>
          {DETAIL_FIELDS.filter(([k]) => f[k]).map(([k, label]) => (
            <Text wrap="truncate-start">
              <Text dimColor>{label.padEnd(9)}</Text>
              {f[k]}
            </Text>
          ))}
          {r && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                EFFICIENCY
              </Text>
              <Text>
                CPU {pct(r.cpuEff)} of {r.cpus} · mem {r.maxRss}/{r.reqMem} ({pct(r.memEff)}) · time {r.elapsed} of{' '}
                {r.limit} ({pct(r.timeEff)}) · exit {r.exitCode}
              </Text>
              {r.advice.map(a => (
                <Text color="cyan">→ {a}</Text>
              ))}
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>
              LOG (last {Math.min(logRows, detail.log.length)} lines)
            </Text>
            {detail.log.length === 0 && <Text dimColor>(empty or not yet created)</Text>}
            {detail.log.slice(-logRows).map(l => (
              <Text wrap="truncate-end">{l || ' '}</Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}
