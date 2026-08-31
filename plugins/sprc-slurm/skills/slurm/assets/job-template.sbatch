#!/bin/bash
# =============================================================================
# sbatch job template for the `sprc` cluster. Copy, edit the #SBATCH lines and
# the work section, then:   sbatch this-file.sbatch
#
# Reminders:
#   - You get NO GPU unless you ask (--gres). A GPU otherwise defaults to 32 CPU
#     + 384,000 MB (shown as 375G in sacct); set smaller explicit CPU/RAM requests
#     when the workload needs less.
#   - ALWAYS set --time. Omitting it gives the 2-hour batch default, not the 3-day
#     maximum. Accurate short walltimes backfill sooner; jobs are killed at the
#     limit. Caps: normal=3d, undergrad=1d, expedite=24h, scavenger=1d.
#   - Submit from user-approved shared storage under /home, /projects, /data, or
#     /fast-data — never /tmp. Output defaults to the submit directory.
#   - Make long work checkpoint/resume — jobs can hit walltime or (scavenger) be requeued.
#     For anything long or preemptible, start from `checkpoint-job.sbatch` instead:
#     it wires up --requeue and the pre-kill USR1 trap that this template omits.
# =============================================================================

#SBATCH --job-name=myrun           # shows in squeue
# #SBATCH --gres=gpu:1             # uncomment only when the workload uses a GPU
#SBATCH --time=8:00:00             # HH:MM:SS or D-HH:MM:SS — estimate + margin, don't max it out
#SBATCH --output=%x-%j.out         # small log in submit dir; route large logs to project storage
# --- resource tuning (use measured needs or references/workload-allocations.md) ---
# #SBATCH --cpus-per-task=16       # set to parallelism the workload will actually use
# #SBATCH --mem=64G                # set from expected working set + margin
# #SBATCH --qos=scavenger          # opportunistic idle-GPU soak; preemptible — REQUIRES checkpointing
# #SBATCH --mail-type=END,FAIL     # email on end/failure (omit = no mail). Events: BEGIN,END,FAIL,ALL
# #SBATCH --mail-user=netid        # bare netid -> netid@illinois.edu; set explicitly if your login != netid

set -euo pipefail

echo "Job $SLURM_JOB_ID on $(hostname) — started $(date)"
# nvidia-smi -L                    # optionally verify the allocated GPU count

# --- your work -------------------------------------------------------------
# Resolve project data/cache/output paths with the user before replacing this
# command. Downloads belong on sprlab005; material compute belongs in this job.
# Launch the real work with `srun` so the step is tied to the allocation
# (clean accounting + signal handling). Replace with your actual command:
srun ./run_my_thing.sh

echo "Finished $(date)"
