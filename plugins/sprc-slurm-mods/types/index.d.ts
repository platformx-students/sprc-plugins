export type NodeRow = {
  name: string
  state: string
  gpus: number
  gpusUsed: number
  cpusAlloc: number
  cpusTotal: number
  memAllocMb: number
  memTotalMb: number
}

export type JobRow = {
  id: string
  user: string
  name: string
  /** Compact state: R, PD, CG, ... */
  state: string
  elapsed: string
  limit: string
  gpus: number
  cpus: number
  mem: string
  reason: string
  qos: string
  partition: string
  nodes: string
  /** Expected (pending) or actual (running) start, ISO, or N/A. */
  start: string
}

export type Snapshot = {
  at: number
  error?: string
  nodes: NodeRow[]
  mine: JobRow[]
  others: { running: number; pending: number; gpusRunning: number; gpusPending: number }
}

export type JobReport = {
  id: string
  name: string
  state: string
  exitCode: string
  elapsed: string
  limit: string
  nodes: string
  cpus: number
  gpus: number
  reqMem: string
  maxRss: string
  /** Fractions 0..1, absent where Slurm had nothing to measure. */
  cpuEff?: number
  memEff?: number
  timeEff?: number
  advice: string[]
  user?: string
  stdout?: string
  endedAt: number
}

export type Followed = {
  id: string
  wake: boolean
  origin: 'sbatch' | 'tool' | 'person'
  /** When following began; a snapshot taken before then cannot say it ended. */
  since?: number
}

export type View = { kind: 'overview' } | { kind: 'job'; id: string }

export type JobDetail = {
  id: string
  fields: Record<string, string>
  log: string[]
  report?: JobReport
  at: number
}

export type Budget = { lines: string[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'sprc-slurm-mods': {
      snapshot: Snapshot | null
      followed: Followed[]
      finished: JobReport[]
      view: View
      detail: JobDetail | null
      budget: Budget | null
      isEnabled: boolean
      hasOpened: boolean
    }
  }
}
