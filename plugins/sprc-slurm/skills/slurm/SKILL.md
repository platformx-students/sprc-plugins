---
name: slurm
description: >-
  Use when getting work running on the lab's `sprc` H100 GPU cluster (login/controller `sprlab005`)
  via Slurm, not just explaining it: staging and submitting `sbatch` jobs, opening interactive
  `salloc` GPU sessions, SSHing to a compute node, picking GPUs/CPUs/memory/walltime and QoS
  (`normal`/`undergrad`/`expedite`/`scavenger`), making long runs checkpoint and requeue, watching a
  run and right-sizing the next one, or troubleshooting a pending/stuck/failed job. Triggers on
  run/submit/queue/launch a job, train/benchmark/profile/fine-tune/sweep on a GPU, "grab a node", and
  on `sprc`/`sprlab005`/`sbatch`/`salloc`/`srun`/`squeue`/`sacct`/`scancel`/`sinfo`/`seff`/
  `scavenger`/`expedite` — even if they never say "Slurm". Do NOT use for administering Slurm itself
  (`slurmctld`/`slurmd`), conceptual questions with no job to run, fixing SSH/login/networking, or
  work on a local laptop.
---

# Running work on the `sprc` cluster (Slurm)

## Operating posture: do the work, don't narrate it

The people on this cluster are experienced — they already know what Slurm is and how the workflow
goes. They invoke you to **get their work running**, not to be taught the steps. So **default to
executing**: figure out the resources, write the job script, submit it, and report back tersely
(job id + the one command they'd use to watch it). Don't preface a run with a tutorial on QoS tiers,
fair-share, or "here's how Slurm works" — that's noise they have to scroll past.

- **Act first.** When the user describes work to run, *stage and submit it.* The deliverable is a
  running (or ready-to-submit) job, not an explanation of how you'd submit it.
- **Be terse.** A good response is the script you wrote + "Submitted job 12345; watch with
  `tail -f myrun-12345.out`." A paragraph per flag is too much. When you report a *finished* job, one
  extra line: whether the request fit, and what you're changing next time.
- **Explain only on demand.** If the user asks "why", "how does X work", or "what are my options",
  *then* explain — and pull in the references below for the specifics.
- **Terse ≠ withholding.** Brevity is about cutting what they already know, not what they need to
  know. Always surface — in a line — the caveat that would otherwise burn them: their job needs
  checkpointing because it'll be requeued, they're not onboarded so nothing will submit, their
  `--time` is too short for the run, their files aren't on the shared FS the nodes can see. Flag it,
  don't lecture it.
- **One judgment call to flag, not lecture:** when a choice genuinely affects them (e.g. `normal`
  vs. `scavenger` for a big sweep), state the pick and a half-line why, then proceed.

This posture is the point of the skill. Everything below is what you need to act *correctly* for
*this* cluster — keep it in your head, but keep it out of your reply unless asked.

## Act correctly: the cluster facts that change what you do

These are the things a generic Slurm answer gets wrong here. Get them right silently.

- **Never run real work on the login node `sprlab005`.** Anything using a GPU or sustained CPU/RAM
  goes through `sbatch`/`salloc`. The login node is for editing, submitting, monitoring — and a
  systemd slice caps **every user at 8 vCPUs and 32 GB RAM** there, so heavy local work is throttled
  or OOM-killed, not just frowned upon. (A build or dataloader that dies around 32 GB on the login
  node is hitting that cap, not a bug.) Real compute belongs on a node.
- **No GPU unless you ask.** Add `--gres=gpu:N` (or `--gpus=N`). CPUs and RAM then auto-derive — you
  rarely set them. Per GPU you get **32 CPUs (16 cores) + 384,000 MB** (`sacct` prints that as
  `375G`); a CPU-only job floors at 4 CPUs (~48 GB). So usually: **request GPUs + `--time`, nothing
  else.**
- **Always set `--time`. The batch default is 2 hours, not the 3-day max.** A job submitted without
  `--time` is killed at the 2 h mark — the single most common way a long run dies for no visible
  reason. (Interactive defaults to 30 min, capped at 1 h.)
- **Submit from shared storage, never from `/tmp`.** Compute nodes mount `/home`, `/projects`,
  `/data`, `/fast-data` and `/huggingface` at the *same paths* as the login node; `/tmp` is
  node-local and a job cannot see the login node's copy. Submitting from `/tmp` "works" and then the
  output file lands on the node's own disk where nobody finds it.
- **Interactive vs. batch decides the partition and the walltime cap — automatically.** `sbatch`
  runs on `main` (3-day cap). `salloc`/`srun` (interactive) are **auto-routed to `debug` and capped
  at 1 hour** by `job_submit.lua` — you do **not** pass `-p`. Two consequences to internalize: an
  interactive job that names a non-`debug` partition (e.g. `-p main`) is **rejected**, and an
  interactive `--time` over 1 h is **silently clamped to 1 h**. So **anything longer than an hour
  must be `sbatch`** — never try to hold a long `salloc`. `debug` is also capped at **1 node**. Set
  an honest `--time` regardless (batch backfills sooner with an accurate short walltime; jobs are
  killed at the limit).
- **Your GPU cap comes from your QoS, not the partition.** The default QoS is right for almost
  everything; only pass `--qos` for the two special cases below.
- **Allocate before you SSH to a node.** `ssh sprcNN` is *denied* without an allocation there; with
  one, you land on the node scoped to your job's GPUs/cores/RAM. So always `salloc` first.
- **Onboarding gate.** If `sacctmgr show assoc where user=$USER` is empty, every submit is rejected
  (`Invalid account...`). You can't fix this from the shell — point the user at the Sprocket portal
  (below) and stop retrying the submit.
- **The cluster is shared, and a slice of it is reserved on a rolling schedule.** Standing
  reservations hold part of the cluster for a course; the size and hours get retuned as demand
  changes, so **never quote a figure from memory — read it live** with `scontrol show res`. What this
  changes for research work: at busy times you may wait longer, but your jobs are **not** preempted
  and **none of your flags change**. If contention is the real reason something is pending, say so
  and cite the live reservation, don't guess.

Exact numbers, caps, storage layout, and the rationale live in `references/cluster-facts.md` — read
it before quoting a specific limit; don't recite from memory.

## The default path: stage and submit a batch job

This is what to do for "run / submit / kick off X". Steps, not prose:

1. **Decide** GPUs (from what the work needs) and an honest `--time` (estimate + ~25–50% margin,
   under the 3-day cap). Leave CPU/RAM as defaults unless the work is lopsided.
2. **Write the script.** Start from `assets/job-template.sbatch`, fill in the `#SBATCH` lines and the
   work command. Launch the actual work with `srun` inside the script. For long runs, wire up
   checkpoint/resume and add `--requeue` — jobs can hit walltime or be requeued.
3. **Submit** (`sbatch job.sbatch`), then **report** the job id + how it'll be watched. Don't run the
   work yourself on the login node.
4. **Own the follow-through — don't just hand over check commands and leave.** A long job isn't
   handled when you submit it; it's handled when you've reported how it *ended*. So your default is to
   **set up a background monitor yourself and tell the user you'll report back** — e.g. close with
   "Submitted job 12345 — I'll watch it and report when it finishes." (You can still give them a
   `squeue --me` / `tail -f` to peek if they want; that's in addition, not instead.) Don't make the
   user poll and come back to ask.

   Run the wait as a **background** command in whatever way your harness supports, so it doesn't
   block the user. It returns when the job leaves the queue; you then report the outcome:

   ```bash
   until ! squeue -j <id> -h -t PENDING,RUNNING,COMPLETING -o %T 2>/dev/null | grep -q .; do sleep 60; done
   sacct -j <id> --format=JobID,State,Elapsed,Timelimit,MaxRSS,ExitCode    # then report
   ```

   (In Claude Code that's a background Bash call, which re-invokes you on exit. Other harnesses have
   their own background/notify mechanism — use it.) If your harness has none, fall back to
   `--mail-type=END,FAIL` on the job so the *user* is notified, and say that's what you did. The
   principle doesn't change: *submit, then arrange to follow up and report* — never poll inline in a
   way that blocks the user. If you're only staging a job for the user to submit themselves, still
   say you'll set up the watch once it's submitted, so the follow-through is the plan, not an
   afterthought.
5. **Right-size from the result, then feed it into the next submission.** Reporting the outcome
   includes reporting whether the request fit, and correcting it yourself next time round — see
   "Right-sizing" below. Steps 1–5 are a loop, not a checklist you run once.

Minimal correct script (the template asset is the annotated version):

```bash
#!/bin/bash
#SBATCH --job-name=myrun
#SBATCH --gres=gpu:1
#SBATCH --time=8:00:00
#SBATCH --output=%x-%j.out
set -euo pipefail
srun ./run_my_thing.sh
```

Then: `sbatch job.sbatch` → `squeue --me` (PD pending / R running / CG completing) →
`tail -f myrun-<id>.out`. `scontrol show job <id>` shows the `Reason=` if it's stuck.

## Interactive when they want to poke at a node

For "give me a shell on a GPU / debug live / open a REPL": get them into an allocation, don't lecture.
Interactive sessions are **auto-routed to `debug` and capped at 1 hour** — this is for hands-on work,
not long runs.

```bash
salloc --gres=gpu:1 --time=1:00:00     # interactive allocation on debug (≤1h); work here via srun, or:
squeue --me                            # see the node (e.g. sprc02)
ssh sprc02                             # only works because you hold an allocation there
```

Don't pass `-p main` (or any non-`debug` partition) to an interactive job — it's rejected. Don't
request more than `--time=1:00:00` — it's clamped to the hour. **If the work needs longer than an
hour, it isn't an interactive job — write an `sbatch` script instead** (the default path above).
Remind them to `exit`/`scancel` when done (an idle `salloc` holds GPUs and costs fair-share).

## Long or preemptible work: make it actually resumable

A `scavenger` job *will* be requeued, and any job can hit its walltime — both restart your script
from the top. So "checkpoint it" is not advice, it's a precondition, and it means two concrete
things. A job missing either one loses the work it already did:

1. **Write state to the shared FS periodically, and load it on startup if it's there.**
2. **Add `--requeue` and catch the pre-kill signal** so the last stretch isn't thrown away.

Slurm will warn you before the kill if you ask. `--signal=B:USR1@120` delivers `USR1` 120 s ahead of
the limit; the `B:` sends it to the batch shell rather than the job step, which is what lets a trap
see it:

```bash
#SBATCH --requeue
#SBATCH --signal=B:USR1@120

trap 'echo "checkpointing early"; kill -USR1 "$PID" 2>/dev/null; wait "$PID"' USR1
srun ./train.py --checkpoint-dir "$SLURM_SUBMIT_DIR/ckpt" --resume-if-exists &
PID=$!
wait "$PID"
```

`assets/checkpoint-job.sbatch` is the complete annotated version — start there for anything going to
`scavenger`. Two things to check rather than assume: that the code really *reloads* the checkpoint
(a `--resume` flag that silently starts from scratch is the usual failure, and it hides until a
requeue), and that the checkpoint path is on the shared FS, not a node-local dir that vanishes.
`$SLURM_RESTART_COUNT` is set on a requeued run if you want the script to log restarts.

## QoS: default is fine; deviate in two cases

Pass `--qos` only when one of these applies — otherwise say nothing about QoS:

- **`--qos=scavenger`** for big *restartable* batches (sweeps, anything that checkpoints): soaks idle
  GPUs (up to all 8), lowest priority, **requeued the instant a real job needs the GPU**. The
  good-neighbor choice for bulk work — but only if it actually checkpoints. Pair with a job array.
  **Batch only** — an interactive `salloc --qos=scavenger` is rejected; use `sbatch`.
- **`--qos=expedite`** for a genuine deadline — but it's **sysadmin-granted per user** and not
  self-serve. If the user needs it, tell them to ask; until granted, `--qos=expedite` is rejected.
  (It's also the one QoS exempt from the interactive 1 h cap, so a granted user's `salloc` runs its
  full 24 h — but for long *unattended* work, `sbatch` is still the right tool; don't reach for
  expedite just to stretch an interactive session.)

## Monitor / debug

```bash
squeue --me                 # my jobs + state
scontrol show job <id>      # full detail + Reason= for pending
squeue --start              # ETA for pending jobs
sacct -j <id> --format=JobID,State,Elapsed,MaxRSS,ExitCode    # post-mortem
```

When a job won't start or fails, **read the `Reason=` before changing flags** — don't shotgun. Most
common: `Priority`/`Resources` = just waiting; `QOSMaxGRESPerUser` = at your per-user GPU cap (4 on
`normal`), running jobs must free one — not routable around; killed at walltime = raise `--time` +
checkpoint; OOM = raise `--mem`. The full error→cause→fix table is `references/troubleshooting.md` —
consult it for anything non-obvious, and explain to the user only what they need.

## Right-sizing: a standing loop, not a post-mortem

You are usually not submitting one job — you're dispatching work, reading results, and dispatching
again. **Measure every job that finishes and carry the correction into the next submission
yourself.** This is ordinary workflow, not a special request: the user should never have to ask "was
that sized right?", and you should never submit the same over-sized request twice in a session.

Each time a job of yours ends:

1. **Measure.** `sacct -j <id> --format=JobID,State,Elapsed,Timelimit,ReqTRES%40,MaxRSS,ExitCode`
2. **Compare** peak `MaxRSS` against the memory requested, `Elapsed` against `Timelimit`, and — if
   you asked for more than one GPU — whether the run could actually use them.
3. **Correct the next submission automatically.** Don't ask permission to right-size; do it and say
   so in one line: *"last run used 38 GB of 384 GB and 2 h of 8 h — resubmitting at
   `--time=3:00:00`, which will also backfill sooner."*
4. **Carry the numbers forward** for the rest of the session. The second task of a sweep should
   already be sized from what the first one actually did.

### Correction rules — apply these without being asked

| Observation | Do |
|---|---|
| `Elapsed` well under `Timelimit` | Cut `--time` to roughly `Elapsed × 1.5`, floor ~15 min. An honest short walltime backfills sooner, so this speeds *them* up — it isn't housekeeping. |
| `MaxRSS` far below the memory requested | Leave the default, or set `--mem` ≈ `MaxRSS × 1.3`. Never trim below the observed peak. |
| GPUs idle, or the code is single-GPU | Drop `--gres` to what it uses. An unused GPU is the most expensive thing you can hold against future fair-share. |
| `State=TIMEOUT` | Raise `--time` **and** add checkpointing. You've learned "not enough", not how much — don't infer a precise value from a truncated run. |
| `State=OUT_OF_MEMORY` | Raise memory. Never trim anything else in the same resubmission. |
| Requeued run (`SLURM_RESTART_COUNT` > 0) | **Don't size `--time` from `Elapsed`** — it covers only the final attempt, so you will under-size and time out. |
| First run of unfamiliar work | No measurement yet: take sane defaults, keep `--time` generous, right-size on the next one. |

Two standing limits on this autonomy: **never trim a request you have no measurement for**, and
**never trim in a way that risks the run**. An over-request costs fair-share; an under-request kills
the job. When the two conflict, protect the job and say what you'd try next time instead.

### Traps that make the measurement silently empty

- **`MaxRSS` lives on the job *steps*, not the allocation row.** It appears on the `<id>.batch` line,
  so **don't pass `-X`** — that collapses output to the allocation row and `MaxRSS` comes back blank.
  `ReqTRES` is the reverse: allocation row only.
- **Don't use `sacct --json`.** It carries no memory-used field at all, so the check returns nothing
  rather than failing loudly. Use the text `--format=` above.
- **`seff` is not installed here** — don't run it or suggest it.
- **No GPU utilization is recorded on this cluster.** Profile accounting isn't enabled, so nothing in
  `sacct` can tell you whether the GPU was busy. Size GPUs from what the code actually does, and if
  it matters, have the run log its own device utilization.

## Email notifications (opt-in)

Slurm emails **nothing by default** — it's per-job opt-in. To notify the user about a job, add:

```bash
#SBATCH --mail-type=END,FAIL        # events: BEGIN, END, FAIL, ALL, TIME_LIMIT_90 …
#SBATCH --mail-user=<netid>         # bare netid is enough → <netid>@illinois.edu
```

- **Bare netid works** — the cluster qualifies it to `<netid>@illinois.edu` (their campus inbox); a
  full address (internal or external) is fine too.
- **If their login name isn't their netid, set `--mail-user` explicitly.** Omitting it defaults the
  recipient to `<login>@illinois.edu`, which for those users isn't a real mailbox — the mail is then
  silently dropped (no error, job runs normally). Flag this rather than let it bite them.
- **Off** = omit `--mail-type` (already the default), or `--mail-type=NONE` to override one baked into
  a script.
- For a sweep/array, `--mail-type=ALL` floods the inbox (one mail per state change per task) — prefer
  `FAIL` only, or skip mail and rely on the background watch above.
- Mail comes from `no-reply@illinois.edu` ("SPRC Cluster") — send-only, replies go nowhere.

## The Sprocket portal: where the blockers get resolved

Some things a submit can't fix are self-serve in the cluster portal at
**`https://sprlab005.csl.illinois.edu/`** — lab members already have accounts. When one of these is
the real blocker, name the page instead of telling the user to go find a sysadmin:

| What they're blocked on | Page |
|---|---|
| `expedite` rejected (not granted), or home quota too small | `/requests` — types `expedite_qos`, `quota_increase`, `other`; tracked, with a decision |
| Which GPUs are actually free right now, per node | `/monitor` |
| The live queue; their own usage and storage | `/queue`, `/usage` |
| SSH keys, account details, request history | `/me` |
| Signed in but no cluster account yet | `/no-account` explains the next step |
| What changed on the cluster, news, help | `/changes`, `/news`, `/support`, `/wiki` |

Use it to *unblock*, not as a detour: if `--qos=expedite` is rejected, the reply is "not granted —
request it at `/requests`", and then you carry on with the default QoS rather than stalling.

## Storage and environment: where files go, what's already set up

Compute nodes mount the shared filesystems at the **same paths** as the login node, so a path that
works in your shell works unchanged inside a job:

| Path | Use it for |
|---|---|
| `/home` | Job scripts, code, small outputs. Per-user quota — a `quota_increase` is a portal request. |
| `/projects` | Shared per-project directories — the right place for group work. |
| `/data` | Datasets. |
| `/fast-data` | Fast tier: hot working sets, frequent checkpoints, anything I/O-bound. |
| `/huggingface` | Shared HF cache (below). |

**Node-local paths are not shared and will lose work:** `/tmp` on a compute node is that node's own
disk; `/tmp` on `sprlab005` is invisible to every job; `/mnt/data1` is node-local and often >90 %
full; there is no `/scratch`. Checkpoints in particular must land on shared storage or a requeue
restarts from zero.

Things that are already configured — don't reinvent them:

- **`HF_HOME=/huggingface`** is set cluster-wide, on the fast tier, shared by everyone. Models and
  datasets are cached once. **Never redirect `HF_HOME` into `/home`** — that re-downloads tens of GB
  and eats the user's quota. `HF_TOKEN_PATH` already points at their own `~/.cache/huggingface/token`.
- **`sbatch` carries your environment into the job** (`--export=ALL` is the default), so an activated
  conda env or `venv` just works — activate it *before* submitting, or activate it inside the script.
- **There is no module system.** No Lmod, no `module load` — that's a different cluster's workflow.
  Environments come from conda/`venv`/containers, and CUDA comes from the user's own framework build.

Where you're running from:

- **On `sprlab005`**: commands run directly; keep real compute off it (8 vCPU / 32 GB per-user cap —
  a build that dies around 32 GB is hitting the cap, not a bug).
- **From a laptop**: `ssh sprlab005` and work there — and make sure the user's **code and data are on
  the cluster's shared storage**, not just the laptop. Stage the project over first if needed.

## References

Pull these in only when relevant — they're for getting the details right or answering a "why":
- `references/cluster-facts.md` — hardware, exact defaults/caps, storage map, QoS table,
  scheduling and accounting internals. Carries the date it was last verified against the controller.
- `references/troubleshooting.md` — error → cause → fix.
- `references/admin-ops.md` — things that need a sysadmin (onboarding, `expedite`, reservations);
  recognize these, route the user to the portal or a sysadmin, and don't try to work around them.
