#!/bin/bash
# =============================================================================
# sbatch job template for the `sprc` cluster. Copy, edit the #SBATCH lines and
# the work section, then:   sbatch this-file.sbatch
#
# Reminders:
#   - You get NO GPU unless you ask (--gres). CPUs/RAM auto-derive from the GPU
#     count (32 CPU + ~384 GB per GPU), so usually you only set GPUs + time.
#   - Set an HONEST --time: short accurate walltimes backfill sooner; jobs are
#     KILLED at the limit. Caps: normal=3d, undergrad=1d, expedite=24h, scavenger=1d.
#   - Make long work checkpoint/resume — jobs can hit walltime or (scavenger) be requeued.
#     For anything long or preemptible, start from `checkpoint-job.sbatch` instead:
#     it wires up --requeue and the pre-kill USR1 trap that this template omits.
# =============================================================================

#SBATCH --job-name=myrun           # shows in squeue
#SBATCH --gres=gpu:1               # number of GPUs; DELETE this line for a CPU-only job
#SBATCH --time=8:00:00             # HH:MM:SS or D-HH:MM:SS — estimate + margin, don't max it out
#SBATCH --output=%x-%j.out         # %x=job-name %j=jobid; lands in the submit dir (shared FS)
# --- optional overrides (defaults are usually fine; uncomment to change) ---
# #SBATCH --cpus-per-task=16       # only if the workload is CPU-lopsided
# #SBATCH --mem=64G                # only if default per-CPU memory is wrong for you
# #SBATCH --qos=scavenger          # opportunistic idle-GPU soak; preemptible — REQUIRES checkpointing
# #SBATCH --partition=debug        # 1-hour quick sanity checks that jump the queue
# #SBATCH --mail-type=END,FAIL     # email on end/failure (omit = no mail). Events: BEGIN,END,FAIL,ALL
# #SBATCH --mail-user=netid        # bare netid -> netid@illinois.edu; set explicitly if your login != netid

set -euo pipefail

echo "Job $SLURM_JOB_ID on $(hostname) — started $(date)"
nvidia-smi -L || true              # confirm we see exactly the GPU(s) we requested (omit for CPU-only)

# --- your work -------------------------------------------------------------
# Launch the real work with `srun` so the step is tied to the allocation
# (clean accounting + signal handling). Replace with your actual command:
srun ./run_my_thing.sh

echo "Finished $(date)"
