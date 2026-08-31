#!/bin/bash
# =============================================================================
# Resumable sbatch template for the `sprc` cluster — use this for anything long
# or anything going to `--qos=scavenger`.
#
# Why this file exists: a scavenger job IS requeued (that's the deal you take
# for the idle GPUs), and ANY job is killed at its walltime. Both restart this
# script from the top. If the work doesn't reload prior state, every restart
# throws away everything it had done.
#
# Two mechanisms, both required:
#   1. --requeue            : let Slurm restart the job after preemption
#   2. --signal=B:USR1@120  : get USR1 120s BEFORE the kill, so we can flush a
#                             final checkpoint. `B:` = deliver to the batch
#                             shell (this script), not the srun step — without
#                             `B:` the trap below never fires.
#
#   sbatch this-file.sbatch
# =============================================================================

#SBATCH --job-name=myrun
#SBATCH --gres=gpu:1
#SBATCH --time=1-00:00:00          # scavenger cap is 1 day; normal is 3 days
#SBATCH --output=%x-%j.out
#SBATCH --requeue                  # REQUIRED: allow restart after preemption
#SBATCH --signal=B:USR1@120        # REQUIRED: 120s warning before the kill
# #SBATCH --qos=scavenger          # uncomment for opportunistic idle-GPU soak

set -euo pipefail

# Checkpoints MUST live in the user-approved shared project storage under /home,
# /projects, /data, or /fast-data. Prefer /fast-data for frequent or large
# checkpoints. Node-local /tmp and /mnt/data1 can disappear before a resume on
# another worker; the host's /tmp is invisible to jobs. Before submission, export
# PROJECT_STORAGE from the user's answer or existing project configuration.
: "${PROJECT_STORAGE:?Set PROJECT_STORAGE to the user-approved shared project storage root}"
CKPT_DIR="${CKPT_DIR:-$PROJECT_STORAGE/checkpoints/${SLURM_JOB_NAME:-myrun}}"
mkdir -p "$CKPT_DIR"

echo "Job $SLURM_JOB_ID on $(hostname) — attempt ${SLURM_RESTART_COUNT:-0} — $(date)"

# --- graceful pre-kill checkpoint -------------------------------------------
# Forward USR1 to the real work and WAIT for it to finish writing. Exiting the
# trap early defeats the point: the process gets killed mid-write and you
# inherit a corrupt checkpoint, which is worse than none.
checkpoint_and_exit() {
    echo "USR1 received at $(date) — flushing checkpoint before requeue"
    kill -USR1 "$PID" 2>/dev/null || true
    wait "$PID"
    exit 0
}
trap checkpoint_and_exit USR1

# --- your work ---------------------------------------------------------------
# Run in the BACKGROUND (&) and `wait` on it, so the shell stays responsive to
# the signal. A foreground `srun` blocks the trap until the step ends — by which
# time the job is already being killed.
#
# The resume flag must genuinely reload from CKPT_DIR when a checkpoint is
# present. Verify that once, by hand: a flag that silently starts from scratch
# looks perfectly healthy until the first requeue, then quietly costs you a day.
srun ./train.py --checkpoint-dir "$CKPT_DIR" --resume-if-exists &
PID=$!
wait "$PID"

echo "Finished $(date)"
