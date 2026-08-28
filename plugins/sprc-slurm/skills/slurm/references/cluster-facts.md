# `sprc` cluster facts — the source-of-truth numbers

Quote limits/defaults from here, not from memory. Verify against the live controller when it matters
(`scontrol show config`, `sacctmgr show qos`, `scontrol show node`) — config can drift from this snapshot.

## Hardware

- **4 compute nodes:** `sprc[00-03]`.
- **Per node:** 2× H100-NVL (94 GB, NVLink-paired) · 2× AMD EPYC 9334 (32 cores/socket → **64
  physical cores**, SMT on → **128 logical CPUs**) · ~1.5 TB RAM · InfiniBand.
- **Cluster total schedulable:** **8 GPUs, 256 physical cores (512 logical CPUs), ~6 TB RAM.**
- **GRES name:** `gpu:h100_nvl:2` per node. Node features: `nvlink,h100,epyc9334`.
- **Controller / login node:** `sprlab005` (Ubuntu 24.04, Slurm **23.11.4**, munge 0.5.15, cgroup v2).
  This host is login + control plane + accounting. Do not run compute on it — each user is
  **hard-capped at 8 vCPUs** here via a systemd per-user slice (`CPUQuota=800%`), so heavy local
  work is throttled. (Admin accounts root/exx/mgmt are exempt.)

## Slurm CPU vs. physical core

SMT is on (`ThreadsPerCore=2`): **1 physical core = 2 Slurm CPUs**. All `--cpus-*` flags and the
defaults below are in **Slurm CPUs**. So "32 CPUs" = 16 physical cores.

## Allocation defaults (what a job gets if it doesn't ask)

| Resource | Default | Notes |
|---|---|---|
| GPU | **none** | Must request `--gres=gpu:N` (or `--gpus=N`). No auto-assign. |
| CPU (GPU job) | **32 Slurm CPUs per GPU** (16 physical cores) | `DefCpuPerGPU=32`. |
| CPU (CPU-only job) | **4 Slurm CPUs** (2 physical cores) | Floor applied by `job_submit.lua` when no GPU is requested. |
| Memory | **12 GB per allocated CPU** (`DefMemPerCPU=12000`) | Scales with CPU count. |

Representative results:
- 1-GPU job → 32 CPU → **~384 GB**.
- 2-GPU job → 64 CPU → **~768 GB** (fills one node).
- CPU-only job → 4 CPU → **~48 GB**.

Note: a node can't *default*-pack all 128 CPUs at 12 GB each (would need 1,536 GB > 1,500 GB RealMemory).
Never bites in practice because realistic packing is GPU-bound. For big CPU-only jobs set `--mem` explicitly.

## QoS tiers

A higher tier always outranks a lower one in the queue; fair-share and wait-time only order peers
*within* the same tier.

| QoS | Priority | MaxWall | MaxGPU/user | MaxSubmit/user | Preempts | Preemptable by | Self-serve? |
|---|---|---|---|---|---|---|---|
| `expedite` | 1000 | 24 h | 4 | — | scavenger | — | **No** — sysadmin grants per-user, auto-expires |
| `normal` (grad default) | 500 | 3 days | 4 | 500 | scavenger | — | Yes |
| `undergrad` (ug default) | 400 | 1 day | 2 | 200 | scavenger | — | Yes |
| `scavenger` | 1 | 1 day | 8 | 500 | — | everyone (REQUEUE) | Yes (`--qos=scavenger`) |

- **Preemption is REQUEUE, never CANCEL**, and only `scavenger` is ever preempted. `normal`,
  `undergrad`, `expedite` are never auto-killed. A requeued scavenger job restarts from scratch
  (hence: checkpoint).
- A fresh scavenger job gets a ~10-minute grace period before it can be preempted.

## Account / tier mapping

| Account | Default QoS | Also has | Per-user GPU cap |
|---|---|---|---|
| `grads` | `normal` | `scavenger` (+ `expedite` while granted) | 4 (`normal`), 8 (`scavenger`) |
| `undergrads` | `undergrad` | `scavenger` | 2 (`undergrad`), 8 (`scavenger`) |

A user must be added to one of these accounts (`sacctmgr add user`) before they can submit at all.

## Sharing the cluster with coursework

The same four nodes also carry a course. Three facts matter for research work, and nothing else about
the course policy belongs in a research answer:

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
same flags. The controller handles course jobs on a separate branch that research jobs never enter.

## Partitions

| Partition | Default? | Nodes | MaxTime | Notes |
|---|---|---|---|---|
| `main` | **Yes** | sprc[00-03] | 3 days | All **batch** work (`sbatch`). Batch walltime/priority comes from your QoS, not the partition. Also carries the lower-ranked course tiers. |
| `debug` | No | sprc[00-03] | 1 hour | **Home for every interactive session** (`salloc`/`srun`) plus quick sanity checks. Higher `PriorityTier` (jumps the *pending* queue, does **not** preempt). Research accounts only. |

**You do not choose the partition — `job_submit.lua` routes by job kind.** `sbatch` → `main`.
`salloc`/`srun` (interactive) → `debug`, auto-routed, with `--time` **clamped to 1 h** as needed
(an unset `--time` gets `debug`'s 30 min default). An interactive job that explicitly names a
non-`debug` partition is **rejected** with a pointer to `sbatch`; an interactive `--qos=scavenger`
is **rejected** (batch-only tier). The one exception to the 1 h interactive cap is `--qos=expedite`
(sysadmin-granted), which is exempt and keeps its 24 h wall. Net: **interactive ≤ 1 h; anything
longer is `sbatch` on `main`.** There is intentionally **no** `interactive`/`batch`/`long`
partition — only `main` + `debug`.

## Scheduling behavior worth knowing (for answering "why")

- **Backfill scheduler:** an accurate short `--time` lets a job slip ahead of bigger ones — so an
  honest walltime helps *you* start sooner. Padding it hurts you.
- **GPU-weighted fair-share:** holding a GPU (even an idle one) is what costs your future priority,
  far more than CPUs — recent usage decays over ~a week. This is why releasing idle allocations and
  using `scavenger` for bulk work keeps you in good standing.
- **Preemption is requeue-only and only touches `scavenger`** — a preempted scavenger job restarts
  from scratch, which is why it must checkpoint.

## Resource isolation

A job (and an SSH session adopted onto its node) sees only its allocated GPUs/cores/RAM — nothing
leaks between jobs sharing a node. That's why `nvidia-smi` inside a job shows exactly what you asked
for, and why you can't SSH to a node you hold no allocation on.

> The exact scheduler weights, billing config, cgroup/PAM plugin settings, and partition/QoS
> internals live in the lab's admin doc `SlurmPolicies.md`, not here — this reference is for getting
> a researcher's job placed correctly, not for tuning the policy.
