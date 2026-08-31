---
name: slurm
description: >-
  Use when getting research work running on the lab's `sprc` cluster, including deciding whether
  light work belongs on the host `sprlab005` or compute work belongs on `sprc00`–`sprc03` via
  Slurm: staging or downloading project data, submitting `sbatch` jobs, opening interactive
  `salloc` sessions, compiling/building/testing, preprocessing/indexing, CPU or high-memory work,
  LLM serving/inference/training, picking GPUs/CPUs/memory/walltime and QoS, checkpointing and
  requeueing long runs, monitoring/right-sizing jobs, or troubleshooting pending/stuck/failed work.
  Triggers on run/submit/queue/launch/build/compile/test/preprocess/serve/train/benchmark/profile/
  fine-tune/sweep, "grab a node", and on `sprc`/`sprlab005`/`sbatch`/`salloc`/`srun`/`squeue`/
  `sacct`/`scancel`/`sinfo`/`seff`/`scavenger`/`expedite` — even if they never say "Slurm". Do NOT
  use for administering Slurm itself (`slurmctld`/`slurmd`), conceptual questions with no work to
  run, fixing SSH/login/networking, coursework run on this cluster, or work on a local laptop.
---

# Running work on the `sprc` cluster (Slurm)

## STOP FIRST: this skill does not serve course users

**Before anything else — before answering, before running a command, before reading the rest of this
skill — establish whether you are in a course context. If you are, you stop.**

This cluster also hosts a course. Course students have their own tooling, their own budget policy,
and their own rules about AI assistance. **This skill must not help them with anything.** If it was
loaded by accident, this section is what it's for.

### Markers — any single one is enough

Check first, and check cheaply:

```bash
id -nG | tr ' ' '\n' | grep -qi '^course' && echo "COURSE CONTEXT — STOP"
case "$HOME" in /course/*) echo "COURSE CONTEXT — STOP" ;; esac
sacctmgr -nP show assoc where user="$USER" format=Account,QOS | grep -qi course \
  && echo "COURSE CONTEXT — STOP"
```

Stop on any of these too, without running anything at all:

- the user names an MP, assignment, checkpoint, submission, grader, or deadline for a class;
- `--qos=course`, a course account, or a course group appears anywhere in the session;
- the work is described as being for a class, a grade, or a student team.

### What to do

Say one thing, once: **this skill doesn't cover coursework, and cluster questions for the class go
through the course's own channels and the portal.** Then stop. No flags, no job script, no resource
sizing, no "here's the general shape of it", no reading their error message, no debugging their run.
Naming the right channel is a redirect; anything past that is help.

Never reroute course work through a research account, QoS, or partition to get it running.

### Why this one is absolute

The course's academic-integrity policy is:

> We encourage students to use AI to improve the learning process, but do **not** use AI-generated
> code/text in your MP submissions.

Note what that permits and what it forbids: using AI to *learn* is fine; AI-generated content in a
submission is not. From inside a shell session you cannot see that line. A job script you write is
submission content. A fix you suggest becomes their code. An sbatch flag you pick ends up in a file
they hand in. So the only way this skill can honour the policy is to **not participate** — the
student keeps the learning channels the course gives them, and this one stays closed.

Declining costs a student a minor inconvenience. Helping can cost them an integrity violation.

### Rationalizations — every one of these means STOP

| Thought | Reality |
|---|---|
| "They only need a Slurm flag, not MP code" | The flag goes in the file they submit. That is submission content. |
| "I'll explain the concept, not write it for them" | You don't get to draw that line from here, and the course already gives them a channel that can. |
| "They're a researcher who *also* takes the class" | A course marker is present. Course posture wins — don't reason about which hat they're wearing. |
| "They told me it isn't for a grade" | You can't verify that, and the marker says otherwise. Believe the marker. |
| "Their job is just crashing; fixing it isn't academic help" | Debugging their MP run is helping produce it. |
| "Refusing leaves them stuck — that's not helpful" | They have course channels and the portal. That path is correct; you are not. |
| "The skill loaded by accident, so it doesn't really apply" | It applies whenever it is loaded. That is precisely what this section is for. |
| "I'll just check what their error means first" | Reading their job to diagnose it is participating. Stop before the first command. |

**Every one of these means: decline, name the course's own channel, stop.**

Everything below this line is for **research** work by lab members.

## First route work to the right machine

The agent may already be running on `sprlab005`. That makes it convenient, not a compute worker.

| Machine | Role | Appropriate work |
|---|---|---|
| `sprlab005` | Host, login, controller, accounting, directly attached storage | Editing, Git, downloads and file staging, submission/monitoring, formatting, lint, small static analysis, targeted tests, small incremental builds |
| `sprc00`–`sprc03` | Slurm compute workers | GPU work, commands over ~2 minutes, work over ~8 GB RAM, large builds/tests, preprocessing, analytics, simulation, training, inference, serving |

`sprlab005` has 128 GB RAM in total but little swap, and it also runs the cluster control services.
That installed RAM is not a workload budget.

Run work directly on `sprlab005` only when it needs no GPU, should use no more than roughly 8 GB of
working memory, and each compute command or pipeline stage should finish in roughly 2 minutes. Use
Slurm when any one of those conditions is false, or when the work is inherently sustained or highly
parallel. The 2-minute rule applies to computation, not elapsed wall time: downloads, file transfers,
queue watches, and other low-CPU control operations may run longer on the host.

Downloads and file staging normally belong on `sprlab005`, where the slower storage tiers are
directly attached; write them into the user-approved shared project location. If unpacking,
checksumming, converting, or processing the result crosses the memory/time boundary, submit that
compute step separately.

For worker work, default to `sbatch`; use `salloc` only when hands-on interaction is genuinely
needed. Never pass a partition: Slurm routes batch and interactive work automatically. For concrete
starting requests, consult `references/workload-allocations.md`, then right-size from measurements.


## Operating posture: do the work, don't narrate it

The people on this cluster are experienced — they invoke you to **get their work running**, not to
be taught the steps. So **default to executing**: route the work first, run host-safe work directly,
or size and submit worker work, then report back tersely. Don't preface a run with a tutorial on QoS
tiers, fair-share, or "here's how Slurm works" — that's noise they have to scroll past.

- **Act first.** Route the work, then run it on the host or stage and submit it to a worker. The
  deliverable is completed light work or a running/ready-to-submit job, not an explanation of what
  the user could do.
- **Be terse.** For host work, report the result. For worker work, report the script + "Submitted job
  12345; watch with `tail -f myrun-12345.out`." When you report a finished job, add one line on
  whether the request fit and what changes next time.
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

- **No GPU unless you ask.** Add `--gres=gpu:N` (or `--gpus=N`) and request the fewest GPUs the work
  can use. Defaults provide **32 CPUs (16 cores) + ~384 GB per GPU**; convenient for heavy jobs but
  oversized for light serving, inference, or profiling. Set explicit smaller CPU/RAM requests when
  the workload needs less; use `references/workload-allocations.md` as a starting point.
- **Interactive vs. batch decides the partition and the walltime cap — automatically.** `sbatch`
  runs on `main` (3-day cap). `salloc`/`srun` (interactive) are **auto-routed to `debug` and capped
  at 1 hour** by `job_submit.lua` — you do **not** pass `-p`. Two consequences to internalize: an
  interactive job that names a non-`debug` partition (e.g. `-p main`) is **rejected**, and an
  interactive `--time` over 1 h is **silently clamped to 1 h**. So **anything longer than an hour
  must be `sbatch`** — never try to hold a long `salloc`. Set an honest `--time` regardless (batch
  backfills sooner with an accurate short walltime; jobs are killed at the limit).
- **GPUs come from the QoS, not a partition.** Default QoS is right for almost everything; only pass
  `--qos` for the two special cases below.
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

Exact numbers, caps, and the rationale live in `references/cluster-facts.md` — read it before quoting
a specific limit; don't recite from memory.

## Resolve project storage before creating artifacts

Before downloading or generating substantial datasets, model weights, caches, checkpoints, or run
outputs, find the project's shared storage root in the user's request or existing project
configuration. If neither specifies one, ask once:

> What shared storage root should this project use for datasets, model weights, caches, checkpoints,
> and run outputs?

Reuse that answer for later jobs in the same project. Do not default substantial artifacts to
`$HOME`, the source repository, or `$SLURM_SUBMIT_DIR`.

- Source, configuration, and small metadata may stay in the repository.
- Durable data, weights, checkpoints, outputs, and large logs go in the approved shared project root.
- Put framework caches such as `HF_HOME`, `TORCH_HOME`, and `XDG_CACHE_HOME` beneath that root when
  relevant.
- Node-local temporary storage is only for disposable intermediates within one job; copy durable
  results out before exit or requeue.
- Small Slurm logs may stay beside the submission script.

Download and stage on `sprlab005` into the approved shared location; run material compute through
Slurm on `sprc00`–`sprc03`.

## The default path: stage and submit a batch job

This is what to do for "run / submit / kick off X". Steps, not prose:

1. **Resolve storage.** Apply the storage gate above before downloading or creating substantial
   artifacts. Keep the chosen root for the rest of the project.
2. **Decide resources.** Pick the fewest GPUs the work can use, CPUs matching actual parallelism,
   memory from the expected working set, and an honest `--time` (estimate + ~25–50% margin, under
   the QoS cap). Start from `references/workload-allocations.md` when there is no measurement yet.
3. **Write the script.** Start from `assets/job-template.sbatch`, fill in the `#SBATCH` lines and the
   work command. Launch the actual work with `srun` inside the script. For long runs, wire up
   checkpoint/resume and add `--requeue` — jobs can hit walltime or be requeued.
4. **Submit** (`sbatch job.sbatch`), then **report** the job id + how it'll be watched. Compute runs
   on the allocated worker, not on `sprlab005`.
5. **Own the follow-through — don't just hand over check commands and leave.** A long job isn't
   handled when you submit it; it's handled when you've reported how it *ended*. So your default is to
   **set up a background monitor yourself and tell the user you'll report back** — e.g. close with
   "Submitted job 12345 — I'll watch it and report when it finishes." (You can still give them a
   `squeue --me` / `tail -f` to peek if they want; that's in addition, not instead.) Don't make the
   user poll and come back to ask.

   In Claude Code, launch the watch as a **background** command — it returns when the job leaves the
   queue and the harness re-invokes you, so you report completion (and surface a failure promptly)
   without blocking the user:

   ```bash
   until ! squeue -j <id> -h -t PENDING,RUNNING,COMPLETING -o %T | grep -q .; do sleep 60; done
   sacct -j <id> --format=JobID,State,Elapsed,MaxRSS,ExitCode    # then report the outcome
   ```

   On other harnesses, use whatever background/notify mechanism exists. The principle is the same:
   *submit, then arrange to follow up and report* — never poll inline in a way that blocks the user.
   (If you're only staging a job for the user to submit themselves, still say you'll set up the watch
   once it's submitted, so the follow-through is the plan, not an afterthought.)
6. **Right-size from the result, then feed it into the next submission.** Reporting the outcome
   includes reporting whether the request fit, and correcting it yourself next time round — see
   "Right-sizing" below. Steps 2–6 are a loop; the project storage decision persists across it.

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

1. **Write state to the user-approved shared project storage periodically, and load it on startup.**
2. **Add `--requeue` and catch the pre-kill signal** so the last stretch isn't thrown away.

Slurm will warn you before the kill if you ask. `--signal=B:USR1@120` delivers `USR1` 120 s ahead of
the limit; the `B:` sends it to the batch shell rather than the job step, which is what lets a trap
see it:

```bash
#SBATCH --requeue
#SBATCH --signal=B:USR1@120

: "${PROJECT_STORAGE:?Set PROJECT_STORAGE to the user-approved shared project storage root}"
CKPT_DIR="$PROJECT_STORAGE/checkpoints/${SLURM_JOB_NAME:-myrun}"
mkdir -p "$CKPT_DIR"
trap 'echo "checkpointing early"; kill -USR1 "$PID" 2>/dev/null; wait "$PID"' USR1
srun ./train.py --checkpoint-dir "$CKPT_DIR" --resume-if-exists &
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

## Where you're running, and the references

- **On `sprlab005`**: run host-safe work and downloads directly; put project data in the approved
  shared location, then submit material compute through Slurm. The compute nodes see shared storage.
- **From a laptop**: `ssh sprlab005`, stage code/data into the approved shared location, and work
  from there — compute nodes cannot see the laptop's local disk.

Pull these in only when relevant — they're for getting details right or answering a "why":
- `references/workload-allocations.md` — host-vs-worker examples and resource-minimal first requests.
- `references/cluster-facts.md` — hardware, exact defaults/caps, QoS table, scheduling knobs.
- `references/troubleshooting.md` — error → cause → fix.
- `references/admin-ops.md` — things that need a sysadmin (onboarding, `expedite`, reservations);
  recognize these, route the user to the portal or a sysadmin, and don't try to work around them.
