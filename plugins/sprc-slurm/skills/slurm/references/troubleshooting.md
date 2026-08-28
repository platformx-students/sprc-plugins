# Troubleshooting Slurm jobs on `sprc`

Always **read the actual reason before changing flags**. Get it from:
- `squeue --me` (the `NODELIST(REASON)` column for pending jobs)
- `scontrol show job <id>` (the `Reason=` field, plus `JobState`)
- `sacct -j <id> --format=JobID,State,Elapsed,MaxRSS,ReqTRES,ExitCode` (for finished/failed jobs)
- the job's `--output` / `--error` file (for application-level errors)

## Pending forever / won't start

| Reason= | Meaning | Action |
|---|---|---|
| `Priority` | Higher-priority jobs are ahead of you. | Normal. `squeue --start` for an ETA. Consider `--qos=scavenger` if work is restartable, or trim `--time`/GPU count to backfill sooner. |
| `Resources` | Waiting for enough free GPUs/CPUs/RAM to fit. | Normal under load. Smaller request = sooner start. |
| `QOSMaxGRESPerUser` / `QOSMaxGRESPerUserLimit` | You're at your per-user GPU cap (4 normal / 2 undergrad / 8 scavenger). | Let your running jobs finish, or cancel one. Not routable around. |
| `QOSMaxJobsPerUserLimit` / `AssocMaxSubmitJobLimit` | Too many submitted jobs. | Wait for some to drain, or cancel. |
| `ReqNodeNotAvail` / `Reserved` | Node drained, or capacity held by a reservation (part of the cluster is reserved for a course on a recurring schedule). | Check `sinfo -R` and `scontrol show res` — an `State=ACTIVE` reservation shows what's held and until when. Wait it out, or size the job to fit what's left. Not an error, and not routable around. |
| `PartitionTimeLimit` | `--time` exceeds the partition/QoS cap. | Lower `--time` (or use a QoS/partition with a longer cap). |

## Rejected at submit time

| Message | Cause | Fix |
|---|---|---|
| `Invalid account or account/partition combination` | User not onboarded (no association), or `-p`/account mismatch. | If `sacctmgr show assoc where user=$USER` is empty → they need a cluster account: send them to the Sprocket portal (`/no-account` once signed in). Otherwise check the partition name. |
| `Invalid qos specification` | Requested a QoS the user doesn't hold. | Drop `--qos` and proceed on the default. For `expedite`, it must be granted first — request it at the portal's `/requests`. |
| `Interactive sessions are limited to the 'debug' partition ...` | An interactive `salloc`/`srun` explicitly asked for a non-`debug` partition (e.g. `-p main`). `job_submit.lua` rejects it. | Drop `-p` (interactive auto-routes to `debug`), or — if the work needs > 1 h — make it an `sbatch` job on `main`. |
| `scavenger is a batch/best-effort tier and cannot run interactively ...` | An interactive `salloc --qos=scavenger`. | Submit it as `sbatch --qos=scavenger` instead. |
| `Requested time limit ... exceeds ... limit` | `--time` over the QoS/partition cap (batch). | Lower it, or move to a higher-cap QoS. |
| `Requested GRES option unsupported` / bad `--gres` | Typo in the GRES spec. | Use `--gres=gpu:N` (or `--gpus=N`). The GRES name is `gpu` (type `h100_nvl`). |
| `Access/permission denied` on `ssh sprcNN` | No allocation on that node (`pam_slurm_adopt`). | `salloc` first, confirm the node in `squeue --me`, then `ssh`. |

> **Not an error — an interactive `--time` over 1 h.** A `salloc`/`srun` asking for more than an hour
> is **not rejected**; `job_submit.lua` prints "Requested time exceeds the 'debug' limit; capped to 60
> minutes" and grants a 1 h session. If the user actually needs the longer walltime, that's the signal
> to switch to `sbatch`, not to retry.

## Failed while running

| Symptom | Likely cause | Fix |
|---|---|---|
| Killed right at the `--time` mark; `State=TIMEOUT` | Walltime too short. | Raise `--time`; add checkpoint/resume so a re-run continues. |
| `State=OUT_OF_MEMORY`, or `MaxRSS` ≈ requested mem in `sacct` | Not enough RAM. | Raise `--mem` (or `--cpus-per-task`, since default mem scales per CPU). |
| `scavenger` job keeps restarting / `State=REQUEUED` | A real job preempted it (by design). | Expected for `scavenger`. Ensure it checkpoints; or move to `normal` if it can't tolerate interruption. |
| `CUDA error: no device` / can't see a GPU | Forgot `--gres=gpu:N`, or code ignores `CUDA_VISIBLE_DEVICES`. | Add the GPU request; verify with `nvidia-smi -L` inside the job (cgroup shows only allocated GPUs). |
| Sees the wrong number of GPUs | Asked for fewer/more than the code expects. | Match `--gres=gpu:N` to the code; inside the job the cgroup exposes exactly N. |
| Job runs but app can't find data/code | Files only on the laptop, not the shared FS. | Put the project on the cluster's shared filesystem before submitting (see SKILL.md "Where you're running"). |

## Useful diagnostics

> **Reading efficiency after the fact:** use the text `sacct --format=...` form, not `sacct --json`.
> The JSON output omits the memory-used fields, so `MaxRSS` comes back empty and an efficiency check
> silently reports nothing rather than failing loudly.

```bash
scontrol show job <id>                 # full state + Reason
sacct -j <id> -l                       # everything accounting recorded
sacct -j <id> --format=JobID,Elapsed,Timelimit,ReqTRES%40,MaxRSS   # over-request check.
                                       #   MaxRSS is on the .batch step: do NOT add -X.
                                       #   (`seff` is NOT installed on this cluster.)
sinfo -R                               # why any node is down/drained
sprio -l                               # priority breakdown of pending jobs (QoS vs fairshare vs age)
sshare -l                              # your fair-share standing (low = recent heavy usage)
scontrol show res                      # active reservations that might be blocking nodes
```
