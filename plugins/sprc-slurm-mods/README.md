# sprc-slurm-mods — Claude Code only

A Claude Code **mod** that makes agents faster on the sprc cluster. It follows the jobs an agent
submits and tells that agent once, briefly, when they have ended. It is not an Agent Skill and
does nothing in codex, opencode or oh-my-pi. Those harnesses (and Claude Code) get the generic
[`slurm` skill](../sprc-slurm/skills/slurm/SKILL.md), which works on its own; this mod is an
optional extra on top of it.

| You get | What it is |
|---|---|
| Auto-follow | Every `sbatch` the agent runs is followed, including loops, job arrays and `JID=$(sbatch --parsable …)`. Jobs submitted by one agent in one turn form a group. |
| One message per group | When every job in a group has ended, the agent gets one short message: state counts, the failures with exit codes and log paths, and right-sizing advice it hasn't already seen. If the conversation is idle, this starts a turn (setting `wake`). If it is busy, the message rides on its next tool result. Subagents and teammates get their own jobs' results. |
| Toasts | `▶` when a followed job starts, `✓`/`✗` when followed jobs end, combined into one toast per poll. |
| Status line | `sprc ▸ 4/8 GPU free · following 21 (3R 18PD) · queue 71` |
| Job tools for the model | `sprc_status`, `sprc_job` (log tail, efficiency, array summary), `sprc_wait` (blocks up to 9 min on several jobs), `sprc_follow` (for jobs submitted elsewhere) |
| Guardrails | Blocks only commands that would fail silently or load the login node, and that Slurm doesn't refuse itself: `sbatch` whose working directory is node-local `/tmp` (the script's own `#SBATCH --chdir` counts), and GPU launchers (`torchrun`, `vllm serve`, …) on sprlab005. Notes on `ssh` to a node you have no job on, and on `sacct --json`, are shown once per session and never block. |
| Live context | A one-line cluster summary on prompts that mention Slurm, GPUs or the cluster. It is sent again only when the summary changes. |

"Free" GPUs are the ones a default GPU job could actually get: an idle GPU plus the 32 CPUs and
375G of memory that come with it by default. Idle GPUs on a node full of CPU jobs show as
*stranded*.

Agents can still poll Slurm their own way, for example with a background
`while squeue …; do sleep 60; done`. The mod never blocks that.

## When it is active

Only when the session runs on the sprc cluster (Slurm reports `ClusterName = sprc`), normally on
`sprlab005`. Anywhere else, including another site's Slurm cluster and Claude Code on the web, it
registers nothing and stays silent. If a hook fails, the command it was watching runs as if the
mod weren't installed.

## Install

Needs a recent Claude Code with mod (function hook) support. Add the marketplace as in the
[main README](../../README.md#claude-code), then:

```
/plugin install sprc-slurm-mods@sprc-plugins
/reload-plugins
```

Install `sprc-slurm` too: the mod tracks jobs, and the skill tells Claude how to submit them well.

## Settings

`/config` → `sprc-slurm-mods`:

| Setting | Default | |
|---|---|---|
| `pollSeconds` | 30 | How often to read `sinfo` + `squeue` (minimum 10). With nothing followed, it polls at a quarter of that rate. |
| `wake` | on | When a conversation's followed jobs have all ended and it is idle, start a turn with the results. Off: the results wait for your next prompt; the toast still shows. |
| `guards` | `enforce` | `enforce` blocks; `warn` lets the command run and tells Claude; `off` disables the checks. Jobs are followed either way. |
| `liveContext` | on | The one-line summary on cluster-related prompts. |

`/sprc` prints the cluster summary and what this session follows. `/sprc follow <ids>` and
`/sprc unfollow <ids>` change that list.

## Privacy

The tools show other users' jobs only as counts: no names, users or job names.

## Developing it

Load the working copy on `sprlab005` with `claude --plugin-dir plugins/sprc-slurm-mods` (disable
the installed plugin first); edits hot-reload. Before committing, run `claude plugin validate .`
and `claude plugin test .` in this directory.
