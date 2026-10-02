# sprc-slurm-mods — Claude Code only

A Claude Code **mod**: live cluster state and job tracking inside the Claude Code interface,
for sessions running on the sprc cluster. It is not an Agent Skill and does nothing in codex,
opencode or oh-my-pi. Those harnesses (and Claude Code) get the generic
[`slurm` skill](../sprc-slurm/skills/slurm/SKILL.md), which works on its own; this mod is an
optional extra on top of it.

| You get | What it is |
|---|---|
| Status line | `sprc ▸ 2/8 GPU free (+2 stranded) · you 1R 3PD · queue 31` |
| `/sprc` pane | Nodes (GPUs, CPU and memory bars), your jobs (walltime bar or pending reason + estimated start), other users as counts only, recently finished jobs with right-sizing advice, course budget. Click a job id for its detail view: times, queue wait, resources, log tail, efficiency, follow and `scancel` (asks first). |
| Job tools for the model | `sprc_status`, `sprc_job`, `sprc_wait` (blocks up to 10 min instead of a sleep/`squeue` loop), `sprc_follow` (`wake=true` starts a new turn when the job ends) |
| Finish notices | Jobs submitted with `sbatch` in the session are followed automatically; when one ends you get a toast and Claude gets its result and efficiency |
| Guardrails | Blocks what the cluster would reject anyway: interactive `scavenger`, `sbatch` from node-local `/tmp`, GPU launchers (`torchrun`, `vllm serve`, …) on the login node, sleep-and-`squeue` polling loops |
| Live context | A one-line cluster summary on prompts that mention Slurm, GPUs or the cluster, re-sent only when it changes |

"Free" GPUs are the ones a default GPU job could actually get: an idle GPU plus the 32 CPUs and
375G of memory that come with it by default. Idle GPUs on a node full of CPU jobs show as
*stranded*.

## When it is active

Only when the session runs on the sprc cluster (Slurm reports `ClusterName = sprc`), normally on
`sprlab005`. Anywhere else, including another site's Slurm cluster and Claude Code on the web, it
registers nothing and stays silent.

## Install

Needs a recent Claude Code with mod (function hook) support. Add the marketplace as in the
[main README](../../README.md#claude-code), then:

```
/plugin install sprc-slurm-mods@sprc-plugins
/reload-plugins
```

Install `sprc-slurm` too: the mod shows state and tracks jobs, and the skill tells Claude how to
submit them well.

## Settings

`/config` → `sprc-slurm-mods`:

| Setting | Default | |
|---|---|---|
| `pollSeconds` | 30 | How often to read `sinfo` + `squeue` (minimum 10). With no jobs of yours and nothing followed, it polls at a quarter of that rate. |
| `autoOpen` | on | Open the pane beside the chat once per session (wide terminals only). |
| `guards` | `enforce` | `enforce` blocks; `warn` lets the command run and tells Claude; `off` disables the checks (submitted jobs are still followed). |
| `liveContext` | on | The one-line summary on cluster-related prompts. |

## Privacy

The pane and tools show other users' jobs only as counts: no names, users or job names.

## Developing it

Load the working copy on `sprlab005` with `claude --plugin-dir plugins/sprc-slurm-mods` (disable
the installed plugin first); edits hot-reload. Before committing, run `claude plugin validate .`
and `claude plugin test .` in this directory.
