# Workload placement and starting allocations

Use the routing rule in `SKILL.md` first: host work needs no GPU, roughly no more than 8 GB of
working memory, and roughly no more than 2 minutes per compute command or pipeline stage. Downloads,
file transfers, and low-CPU monitoring are host work even when their elapsed time is longer.

The requests below are first measurements, not universal optima. Match CPUs to real parallelism,
request system RAM for the expected working set plus margin, and request the fewest GPUs the code can
use. Memory values are host RAM, not GPU VRAM.

- Prefer `sbatch` for worker work; use `salloc` only for genuinely interactive work up to 1 hour.
- Never pass a partition; job kind selects it automatically.
- A GPU request otherwise defaults to 32 CPUs and roughly 384 GB per GPU. The smaller explicit
  CPU/RAM requests below avoid that waste for light GPU work.
- Download on `sprlab005` into the user-approved shared project root. Treat extraction, conversion,
  and preprocessing as separate compute steps and route them by the normal thresholds.

## Examples

| Workload | Placement | Resource-minimal starting point |
|---|---|---|
| Formatting | Host | No allocation |
| Lint or small static analysis | Host if within thresholds | If larger: batch with `--cpus-per-task=4 --mem=8G --time=00:10:00` |
| Targeted unit tests | Host if within thresholds | If larger: batch with `--cpus-per-task=4 --mem=8G --time=00:10:00` |
| Full test suite | Host only when known to remain within thresholds | Batch with `--cpus-per-task=4 --mem=12G --time=00:20:00` |
| Small incremental compilation | Host if within thresholds | No allocation |
| Clean or parallel C/C++/Rust/CUDA compilation | Batch worker | `--cpus-per-task=8 --mem=16G --time=00:30:00` |
| Download or repository/data transfer | Host, directly into approved shared storage | No allocation; artifact size is not working memory |
| Archive extraction, checksum, or format conversion | Host if within thresholds | If larger: batch with `--cpus-per-task=4 --mem=8G --time=00:30:00` |
| Dataset preprocessing or tokenization | Batch worker | `--cpus-per-task=8 --mem=32G --time=02:00:00` |
| Large dataframe join or index construction | Batch worker | `--cpus-per-task=8 --mem=128G --time=02:00:00` |
| Parallel CPU simulation or numerical workload | Batch worker | `--cpus-per-task=16 --mem=64G --time=04:00:00` |
| GPU smoke test, profiling, or short benchmark | Interactive worker | `--gres=gpu:1 --cpus-per-task=4 --mem=32G --time=00:30:00` |
| Interactive LLM serving or API development | Interactive worker | `--gres=gpu:1 --cpus-per-task=4 --mem=64G --time=01:00:00` |
| Unattended LLM serving | Batch worker | `--gres=gpu:1 --cpus-per-task=4 --mem=64G --time=08:00:00` |
| Batch inference, evaluation, or embeddings | Batch worker | `--gres=gpu:1 --cpus-per-task=4 --mem=64G --time=04:00:00` |
| Single-GPU training or fine-tuning | Batch worker | `--gres=gpu:1 --cpus-per-task=8 --mem=64G --time=08:00:00` |
| Model requiring both GPUs on one node | Batch worker | `--nodes=1 --gres=gpu:2 --cpus-per-task=16 --mem=128G --time=08:00:00` |
| Restartable GPU sweep | Batch array | Per task: `--gres=gpu:1 --cpus-per-task=4 --mem=32G`; use measured time and optionally `--qos=scavenger --requeue` |

For LLM work, start with one H100 only when the weights plus KV cache fit its 94 GB VRAM. Request two
GPUs only for demonstrated memory need or measured scaling. For arrays, cap concurrent tasks at the
user's QoS GPU limit; `scavenger` requires checkpointing and verified resume behavior.

## Right-size after the first run

Measure with:

```bash
sacct -j <id> --format=JobID,State,Elapsed,Timelimit,ReqTRES%40,MaxRSS,ExitCode
```

Then:

- Set the next walltime to roughly observed elapsed time × 1.5; use a larger margin for variable work.
- Set memory to roughly observed peak × 1.3, never below the observed peak.
- Drop unused GPUs; do not add GPUs unless the model needs the VRAM or measured throughput scales.
- Keep the safer request when measurements are missing or a smaller request risks losing the run.
- Do not size from a requeued attempt's `Elapsed`; it covers only the final attempt.
