# `sprc` cluster facts — the source-of-truth numbers

Quote limits/defaults from here, not from memory. Verify against the live controller when it matters
(`scontrol show config`, `sacctmgr show qos`, `scontrol show node`, `scontrol show partition`) —
config drifts from any snapshot. Last verified against the live controller **2026-08-30**.

## Hardware

- **4 compute nodes:** `sprc[00-03]`.
- **Per node:** 2× H100-NVL (**95,830 MiB ≈ 94 GB**, NVLink-paired) · 2× AMD EPYC 9334 (32
  cores/socket → **64 physical cores**, SMT on → **128 logical CPUs**) · **1,500,000 MB RealMemory**
  (~1.5 TB) · InfiniBand. NVIDIA driver **570.124.06**.
- **Cluster total schedulable:** **8 GPUs, 256 physical cores (512 logical CPUs), ~6 TB RAM.**
- **GRES name:** `gpu:h100_nvl:2` per node. Node features: `nvlink,h100,epyc9334`.
- **`TmpDisk=0`** — Slurm schedules no node-local scratch. See "Storage" below.
- **Host / controller / login node:** `sprlab005` (Ubuntu 24.04, Slurm **23.11.4**, munge 0.5.15,
  cgroup v2) runs login, control-plane, and accounting services. It has 2× Xeon E5-2687W v4,
  **48 logical CPUs and 128 GB installed RAM (~125 GiB visible)**, much less than a compute node.

### Host per-user caps (`sprlab005`)

A systemd per-user slice caps every user; the installed hardware is not a workload allocation:

| Limit | Value |
|---|---|
| CPU | `CPUQuota=800%` → **8 vCPUs** |
| Memory (soft throttle) | `MemoryHigh=24G` |
| Memory (hard kill) | `MemoryMax=32G` |
| Swap | `MemorySwapMax=8G` |
| Processes | `TasksMax=4096` |

Admin accounts (root, exx, mgmt) are exempt. Light work is fine when it needs no GPU, stays around
8 GB RAM or less, and each compute command takes around 2 minutes or less. Everything heavier belongs
on `sprc[00-03]` through Slurm. A build or dataloader dying around 32 GB on the host is hitting the
hard cap, not an application bug. Downloads and file staging normally run on `sprlab005`, where the
slower storage tiers are directly attached.

## Slurm CPU vs. physical core

SMT is on (`ThreadsPerCore=2`): **1 physical core = 2 Slurm CPUs**. All `--cpus-*` flags and the
defaults below are in **Slurm CPUs**. So "32 CPUs" = 16 physical cores.

## Allocation defaults (what a job gets if it doesn't ask)

| Resource | Default | Notes |
|---|---|---|
| GPU | **none** | Must request `--gres=gpu:N` (or `--gpus=N`). No auto-assign. |
| CPU (GPU job) | **32 Slurm CPUs per GPU** (16 physical cores) | `JobDefaults=DefCpuPerGPU=32`. |
| CPU (CPU-only job) | **4 Slurm CPUs** (2 physical cores) | Floor applied by `job_submit.lua` when no GPU is requested. |
| Memory | **12,000 MB per allocated CPU** (`DefMemPerCPU=12000`) | Scales with CPU count. |
| Walltime (`sbatch` on `main`) | **2 hours** (`DefaultTime=02:00:00`) | **Not** the 3-day max. Omitting `--time` gets you 2 h and a kill at the mark. Always set `--time`. |
| Walltime (interactive on `debug`) | **30 minutes** (`DefaultTime=00:30:00`) | Capped at 1 h regardless. |

Representative results:
- 1-GPU job → 32 CPU → **384,000 MB (= 375 GiB;** `sacct` prints this as `mem=375G`**)**.
- 2-GPU job → 64 CPU → **768,000 MB (750 GiB)** — fills one node.
- CPU-only job → 4 CPU → **48,000 MB (~47 GiB)**.

Note: a node can't *default*-pack all 128 CPUs at 12 GB each (would need 1,536,000 MB > 1,500,000 MB
RealMemory). Never bites in practice because realistic packing is GPU-bound. For big CPU-only jobs
set `--mem` explicitly.

`EnforcePartLimits=ALL`: a request over the partition/QoS limit is **rejected at submit**, not held
pending. `OverTimeLimit=0` and `KillWait=30` — a job is killed at its limit, with 30 s between
`SIGTERM` and `SIGKILL`.

## Storage — which paths the compute nodes can actually see

**This is the most common way a real job fails.** Compute nodes mount the shared filesystems at the
**same paths** as the login node, so anything under these works identically in a job:

| Path | Backing | Use it for |
|---|---|---|
| `/home` | ZFS → NFS (`spr-storage/home`) | Your home. Job scripts, code, small outputs. Quota'd per user. |
| `/projects` | ZFS → NFS (`spr-storage/projects`) | Shared per-project directories — the right home for group work. |
| `/data` | ZFS → NFS (`spr-storage/data`) | Datasets. |
| `/fast-data` | NFS, **fast tier** (separate server) | Hot working sets and checkpoints that are I/O-bound. |
| `/huggingface` | NFS, fast tier | **Shared Hugging Face cache** — see below. |

**Not shared — never write anything you need to keep, or read anything a job depends on, here:**

- **`/tmp` on a compute node** is that node's local disk, invisible from the login node and from any
  other node, and it can be nearly full. Fine for genuinely temporary per-job scratch; nothing else.
- **`/tmp` on `sprlab005`** is the *login node's* local disk — a job **cannot see it at all**.
  Submitting from `/tmp` is a classic silent failure: the job runs, then `--output` lands on the
  node's own local disk and you never find it. Stage and submit from `/home` or `/projects`.
- **`/mnt/data1`** is node-local bulk disk, not shared, and often >90 % full.
- There is **no `/scratch`**, and `TmpDisk=0`, so nothing schedules around node-local space.

Sizes and free space change — read them live with `df -h /home /projects /data /fast-data` rather
than quoting a number from here.

## Environment inside a job

- **`sbatch` exports your submitting environment by default** (`--export=ALL`). An activated conda
  env, `PYTHONPATH`, and `HF_*` carry into the job. Corollary: a job can inherit a *broken* shell
  env, and `--export=NONE` gives you a clean one.
- **A batch script is not a login shell** — `/etc/profile.d` is not re-sourced on the node. The
  site defaults below reach the job by *inheritance from your login shell*, so if you submit from a
  stripped environment (cron, `--export=NONE`, a container) you must set them yourself.
- **Shared Hugging Face cache.** `/etc/profile.d/env.sh` sets `HF_HOME=/huggingface` cluster-wide,
  plus `HF_TOKEN_PATH=$HOME/.cache/huggingface/token` and `HF_HUB_DISABLE_XET=1`. Models and
  datasets are cached **once for everyone on the fast tier** — don't redirect `HF_HOME` into
  `/home`, which re-downloads tens of GB and eats the user's quota.
- **There is no environment-module system.** No Lmod, no `module load`. Users bring their own
  toolchain — conda/mamba, `venv`, or a container. Never emit `module load ...` for this cluster.
- **No system CUDA toolkit or torch on the default `PATH`** — the driver is on the nodes, the
  framework comes from the user's own environment.

## QoS tiers

A higher tier always outranks a lower one in the queue (`PriorityWeightQOS=2000000` dwarfs
fair-share and age); fair-share and wait-time only order peers *within* the same tier.

| QoS | Priority | MaxWall | MaxGPU/user | MaxSubmit/user | Preempts | Preemptable by | Self-serve? |
|---|---|---|---|---|---|---|---|
| `expedite` | 1000 | 24 h | 4 | — | scavenger | — | **No** — sysadmin grants per-user, auto-expires |
| `normal` (grad default) | 500 | 3 days | 4 | 500 | scavenger | — | Yes |
| `undergrad` (ug default) | 400 | 1 day | 2 | 200 | scavenger | — | Yes |
| `scavenger` | 1 | 1 day | 8 | 500 | — | everyone (REQUEUE) | Yes (`--qos=scavenger`) |

- **Preemption is REQUEUE, never CANCEL** (`PreemptType=preempt/qos`, `PreemptMode=REQUEUE`), and
  only `scavenger` is ever preempted. `normal`, `undergrad`, `expedite` are never auto-killed. A
  requeued scavenger job restarts from scratch (hence: checkpoint).
- A fresh scavenger job gets a **10-minute grace period** (`PreemptExemptTime=00:10:00`) before it
  can be preempted.

## Account / tier mapping

| Account | Default QoS | Also has | Per-user GPU cap |
|---|---|---|---|
| `grads` | `normal` | `scavenger` (+ `expedite` while granted) | 4 (`normal`), 8 (`scavenger`) |
| `undergrads` | `undergrad` | `scavenger` | 2 (`undergrad`), 8 (`scavenger`) |

A user must be added to one of these accounts (`sacctmgr add user`) before they can submit at all
(`AccountingStorageEnforce=associations,limits,qos,safe`).

## Sharing the cluster with coursework

The same four nodes also carry a course. Three facts about it affect how research jobs schedule:

1. **Course tiers rank below every research tier** in the queue, and they are not in `debug` at all
   (`debug` is restricted to the research accounts). A course job never outranks yours.
2. **No new preemption.** `scavenger` is still the only thing ever preempted, still by REQUEUE. The
   course policy added no preemption path that can touch a research job.
3. **Standing reservations hold a slice of the cluster** for the course on a recurring weekday/weekend
   schedule. Research jobs schedule around them.

The size and hours of that slice are **actively tuned** as demand shifts between teaching and
research — so it is not a constant, and quoting a remembered number will be wrong sooner or later.
Read it live instead:

```bash
scontrol show res              # what's reserved, for whom, when, and how much (State=ACTIVE = now)
sinfo -o '%P %a %l %D %t %N'   # partition/node availability
squeue -t PENDING --start      # what the scheduler thinks your ETA is
```

Research submission behavior itself is unchanged: same partitions, same QoS tiers, same defaults,
same flags.

## Partitions

| Partition | Default? | Nodes | MaxTime | DefaultTime | MaxNodes | Notes |
|---|---|---|---|---|---|---|
| `main` | **Yes** | sprc[00-03] | 3 days | **2 h** | unlimited | All **batch** work (`sbatch`). Walltime/priority come from your QoS, not the partition. `PriorityTier=1`. |
| `debug` | No | sprc[00-03] | 1 hour | 30 min | **1** | **Home for every interactive session** (`salloc`/`srun`) plus quick sanity checks. `PriorityTier=10` — jumps the *pending* queue, does **not** preempt. Research accounts only (`AllowAccounts=grads,undergrads`), and `scavenger` is not among its allowed QoS. |

**You do not choose the partition — `job_submit.lua` routes by job kind.** `sbatch` → `main`.
`salloc`/`srun` (interactive) → `debug`, auto-routed, with `--time` **clamped to 1 h** as needed
(an unset `--time` gets `debug`'s 30 min default). An interactive job that explicitly names a
non-`debug` partition is **rejected** with a pointer to `sbatch`; an interactive `--qos=scavenger`
is **rejected** (batch-only tier). The one exception to the 1 h interactive cap is `--qos=expedite`
(sysadmin-granted), which is exempt and keeps its 24 h wall. Net: **interactive ≤ 1 h and ≤ 1 node;
anything longer is `sbatch` on `main`.** There is intentionally **no** `interactive`/`batch`/`long`
partition — only `main` + `debug`.

## Scheduling behavior worth knowing (for answering "why")

- **Backfill scheduler** (`sched/backfill`, `select/cons_tres` with `CR_CPU_MEMORY,CR_PACK_NODES`):
  an accurate short `--time` lets a job slip ahead of bigger ones — so an honest walltime helps
  *you* start sooner. Padding it hurts you.
- **GPU-weighted fair-share:** holding a GPU (even an idle one) is what costs your future priority,
  far more than CPUs. Usage decays with a **3-day half-life** (`PriorityDecayHalfLife=3-00:00:00`),
  so a heavy weekend is mostly forgiven by mid-week. This is why releasing idle allocations and
  using `scavenger` for bulk work keeps you in good standing.
- **Priority weights:** QoS 2,000,000 · fair-share 100,000 · age 20,000 · job size 0 · partition 0.
  Tier dominates; everything else breaks ties.
- **Preemption is requeue-only and only touches `scavenger`** — a preempted scavenger job restarts
  from scratch, which is why it must checkpoint.

## Accounting: what is and isn't recorded

- `JobAcctGatherType=jobacct_gather/cgroup`, sampled every **30 s** — a job shorter than that can
  report `MaxRSS=0`.
- **`AcctGatherProfileType` is unset and `AcctGatherNodeFreq=0`, so no GPU utilization or GPU memory
  is recorded**, despite `gres/gpuutil` and `gres/gpumem` appearing in `AccountingStorageTRES`.
  `TRESUsageIn*` carries only `cpu,energy,fs/disk,mem,pages,vmem`. Nothing in `sacct` can tell you
  whether the GPU was busy.
- **`seff` is not installed.**

## Resource isolation

`ProctrackType=proctrack/cgroup`, `TaskPlugin=task/cgroup,task/affinity`. A job (and an SSH session
adopted onto its node) sees only its allocated GPUs/cores/RAM — nothing leaks between jobs sharing a
node. That's why `nvidia-smi -L` inside a CPU-only job reports *no devices*, why it shows exactly N
GPUs when you asked for N, and why you can't SSH to a node you hold no allocation on.

## Mail

`MailProg=/usr/local/sbin/slurm-mail` wraps msmtp: it stamps `From: SPRC Cluster
<no-reply@illinois.edu>` and relays. A bare netid in `--mail-user` is qualified to
`<netid>@illinois.edu`. Send-only — replies go nowhere.

> The exact scheduler weights, billing config, cgroup/PAM plugin settings, and partition/QoS
> internals live in the lab's admin doc `SlurmPolicies.md`, not here — this reference is for getting
> a researcher's job placed correctly, not for tuning the policy.
