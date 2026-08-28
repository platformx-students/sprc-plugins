# Admin / onboarding actions (not self-serve)

These are things a **researcher cannot do for themselves** — they require sysadmin privileges on
`sprlab005`. As an agent helping a researcher, your job is to recognize when one of these is the real
blocker and route the request, with the exact command so it's easy to fulfill. Don't try to work
around them (e.g. don't substitute a different QoS to dodge a missing `expedite` grant).

**Route through the portal first.** Onboarding, `expedite` grants, and quota increases are now
requestable at `https://sprlab005.csl.illinois.edu/requests` (types `expedite_qos`,
`quota_increase`, `other`), where they're tracked and get a decision. That is what you should tell a
researcher. The commands below are what the *sysadmin* then runs — include them only when you're
helping the sysadmin, not as instructions for the requester.

## Onboarding a user (required before they can submit anything)

Accounting enforcement (`AccountingStorageEnforce=associations,limits,qos,safe`) rejects any
submission from a user with no association. A sysadmin adds them:

```bash
sacctmgr -i add user <username> account=grads        # grad researcher (default QoS normal)
sacctmgr -i add user <username> account=undergrads   # undergrad researcher (default QoS undergrad)
sacctmgr show assoc where user=<username> format=User,Account,QOS,DefaultQOS   # verify
```

`grads` → inherits `normal`,`scavenger` (default `normal`); `undergrads` → `undergrad`,`scavenger`.

## Granting `expedite` (research-deadline priority boost)

`expedite` is **not** attached to any account — it's granted per user and auto-expires, so it can't
leak. A sysadmin runs:

```bash
/opt/slurm-lab/expedite.sh grant <user> 48     # 48h grant window; auto-revokes via `at` + cron backstop
/opt/slurm-lab/expedite.sh revoke <user>       # manual early revoke
```

After a grant the user can `--qos=expedite` (top priority, 24h per-job cap). Before it, that QoS is
rejected.

## Reservations (hard no-preemption guarantee for a deadline)

When a user needs a *guaranteed* block of a node (stronger than `expedite`'s priority boost), a
sysadmin creates a reservation:

```bash
scontrol create reservation ReservationName=deadline_alice user=alice \
  nodes=sprc03 starttime=2026-09-15T00:00:00 duration=2-00:00:00 flags=IGNORE_JOBS
scontrol show res
```

`IGNORE_JOBS` does not evict already-running jobs, so the reservation needs enough lead time for
existing ≤3-day jobs on that node to drain (or pick an idle node).

Note that `scontrol show res` will also list the **standing course reservations**, which are
administrator-owned and recur on a weekday/weekend schedule. Those are not ad-hoc deadline
reservations and are retuned as the teaching/research balance changes — read them, don't edit them
as part of a researcher request.

## For the full picture

The complete scheduling design, QoS rationale, fair-share tree, configless setup, `pam_slurm_adopt`
install, and deployment runbook live in the lab's `SlurmPolicies.md` (the admin single-source-of-truth).
This skill is the researcher-facing distillation; that document is where a sysadmin goes to change the
policy itself.
