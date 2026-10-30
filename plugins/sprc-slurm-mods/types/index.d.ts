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
  /** As squeue prints it: "123", "123_4" (array task), "123_[5-200]" (pending tasks). */
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

/** One ended job, or one ended array job summarised over its tasks. */
export type JobReport = {
  /** The job id; for an array, the array's own id. */
  id: string
  name: string
  user?: string
  /** The state every task ended in, or MIXED. */
  state: string
  /** Tasks per end state; a plain job counts as one task. */
  counts: Record<string, number>
  tasks: number
  isArray: boolean
  /** Tasks that did not complete (at most 10). */
  failed: { id: string; state: string; exitCode: string }[]
  exitCode: string
  /** Longest task, formatted, and in seconds (NaN when unknown). */
  elapsed: string
  elapsedS: number
  limit: string
  cpus: number
  gpus: number
  reqMem: string
  maxRss: string
  /** Fractions 0..1, absent where Slurm had nothing to measure. */
  cpuEff?: number
  memEff?: number
  timeEff?: number
  advice: string[]
  endedAt: number
}

export type Followed = {
  /** The job id (an array's own id for a whole array). */
  id: string
  /** The loop that submitted or followed it: a subagent's or teammate's id; absent for the main conversation. */
  owner?: string
  /** Jobs followed by one loop during one main-conversation turn share a group and are reported together. */
  group: string
  origin: 'sbatch' | 'tool' | 'person'
  /** When following began; a snapshot taken before then cannot say it ended. */
  since: number
  /** Seen running; a start toast was shown. */
  started?: boolean
  /** Left the queue; the report once sacct has it. */
  gone?: number
  report?: JobReport
}

/** A finished-jobs message waiting for its loop to be told. */
export type Notice = {
  owner?: string
  text: string
  /** When it was queued; a loop that has not picked it up by the next poll is messaged. */
  at: number
}

/** A background command that may submit jobs; the poll adopts what it submits. */
export type Watch = {
  owner?: string
  group: string
  /** The background task running it; its notification ends the watch. */
  taskId?: string
  /** Queue top and time (ms) when it started: only newer jobs are its. */
  top: number
  since: number
  /** When it stops adopting: soon after its task ends, two hours at most. */
  until: number
  /** Whole words of the command and of the scripts it runs: job and script names it may submit. */
  tokens: string[]
  /** Where it ran, for `--wrap` jobs, which carry no name of their own. */
  cwd: string
  wrap: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'sprc-slurm-mods': {
      snapshot: Snapshot | null
      followed: Followed[]
      finished: JobReport[]
      outbox: Notice[]
      watches: Watch[]
      isEnabled: boolean
    }
  }
}
