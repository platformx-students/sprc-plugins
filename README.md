<div align="center">

# ⚡ sprc-plugins

### Cluster superpowers for the **sprc** H100 cluster

<sub>4 nodes · 8× H100-NVL · Slurm 23.11 · controller <code>sprlab005</code></sub>

</div>

---

One agent **skill**, `slurm`, that lets your coding agent *actually run your work* on the **sprc**
cluster instead of just explaining how: it stages and submits `sbatch` jobs, opens interactive
`salloc` GPU sessions, picks sane GPUs/walltime/QoS, wires up checkpoint/requeue for long runs,
right-sizes the next submission from what the last one actually used, and monitors/debugs jobs —
execute-first, terse, tuned to this cluster's real defaults and policies.

The skill is a single [Agent Skill](https://agentskills.io) (`SKILL.md` + references + job
templates), so the same content works across Claude Code, codex, oh-my-pi, opencode, and anything
else that reads the format.

## Access

**This repo is private.** Install requires a GitHub account with read access to the
`platformx-students` org — that's the whole access control, so there's nothing to configure on the
cluster side.

Every install path below authenticates as *you*: Claude Code's `/plugin marketplace add` uses your
existing git credential helper, and the codex/opencode path is a plain `git clone`. So before
installing, make sure git can reach the repo:

```bash
gh auth login          # or: gh auth setup-git   (if you already have a token)
git ls-remote git@github.com:platformx-students/sprc-plugins >/dev/null && echo "git auth OK"
```

If that fails it's this machine's git credentials, not your access — you're reading this, so you're
already in the org. Run `gh auth login` (or add an SSH key) and try again.

## Install

### `npx skills`

Install with the [Vercel Skills CLI](https://github.com/vercel-labs/skills) from the GitHub source:

```
npx skills add platformx-students/sprc-plugins --skill slurm
```

This installs into the current project by default. Add `--global` for a user-wide install, or
`--agent claude-code`, `--agent codex`, or `--agent opencode` to target one supported client.

### Claude Code

```
/plugin marketplace add platformx-students/sprc-plugins
/plugin install sprc-slurm@sprc-plugins
/reload-plugins
```

<details>
<summary><b>Private-repo auto-update caveat</b> (worth two minutes)</summary>

Claude Code's *background* marketplace refresh disables git credential helpers, so a private
**HTTPS** remote can't authenticate and the skill silently stops updating. Two fixes — either is
enough:

```bash
# A. use SSH (a key in ssh-agent authenticates background pulls normally)
/plugin marketplace add git@github.com:platformx-students/sprc-plugins.git

# B. or embed a token for this repo only, so the background pull works over HTTPS
git config --global url."https://x-access-token:$(gh auth token)@github.com/platformx-students/sprc-plugins".insteadOf \
  "https://github.com/platformx-students/sprc-plugins"
```

</details>

### oh-my-pi (`omp`)

As a marketplace plugin:

```
omp plugin marketplace add platformx-students/sprc-plugins
omp plugin install sprc-slurm@sprc-plugins
```

Or install the whole repo as a single plugin in one line:

```
omp install github:platformx-students/sprc-plugins
```

The skill shows up as `/skill:slurm`.

### codex, opencode, and everything else

All of these read the same `SKILL.md` format; they only differ in which directory they scan. Clone
and run the installer — it symlinks the skill into each one it finds:

```bash
git clone git@github.com:platformx-students/sprc-plugins.git
cd sprc-plugins
./install.sh
```

| Flag | What it does |
|---|---|
| `./install.sh` | every harness detected on this machine, plus `~/.agents/skills` |
| `./install.sh --all` | every known harness dir, installed or not |
| `./install.sh --project [DIR]` | `DIR/.agents/skills` — project scope; codex and opencode both read it |
| `./install.sh /path/to/skills` | one explicit skills directory |
| `./install.sh --list` | show the target table and exit |
| `./install.sh --uninstall` | remove the symlinks it created |

Targets it knows about:

| Harness | Skills directory |
|---|---|
| codex (and any agent following the cross-agent convention) | `~/.agents/skills` |
| codex (legacy path) | `~/.codex/skills` (or `$CODEX_HOME/skills`) |
| opencode | `~/.config/opencode/skills` |
| Claude Code, without the marketplace | `~/.claude/skills` |
| oh-my-pi, without the marketplace | `~/.omp/agent/skills` |

It symlinks rather than copies, so edits to the clone propagate — but the clone has to stay put;
re-run `./install.sh` if you move it. Restart your agent afterward, then look for `slurm` in its
skill list.

## Use it

Ask your agent to run cluster work in plain language — *"get train.py running on the cluster for
~6h"*, *"grab me a GPU node to debug in"*, *"submit these as an overnight scavenger sweep"* — and
the skill takes it from there. It picks it up automatically when your request matches; in
codex/opencode you can also invoke it explicitly (`$slurm` in codex, the `skill` tool in opencode).

## What's in the skill

| File | Contents |
|---|---|
| `SKILL.md` | Operating posture, the batch/interactive/scavenger paths, right-sizing loop, storage and environment, portal routing |
| `references/cluster-facts.md` | Hardware, exact defaults and caps, storage map, QoS table, scheduling and accounting internals |
| `references/troubleshooting.md` | Error → cause → fix, for pending, rejected, and failed jobs |
| `references/admin-ops.md` | The things that need a sysadmin, and how to route them |
| `assets/job-template.sbatch` | Annotated starting point for an ordinary batch job |
| `assets/checkpoint-job.sbatch` | `--requeue` + pre-kill `USR1` trap, for long or `scavenger` work |

The numbers in `cluster-facts.md` are verified against the live controller rather than a config
mirror; it carries the date it was last checked. Anything that gets retuned (reservations, free
capacity) is deliberately *not* hardcoded — the skill tells the agent to read it live.

## Layout

```
plugins/sprc-slurm/skills/slurm/   ← the skill (canonical source): SKILL.md, references/, assets/
.claude-plugin/marketplace.json    ← catalog for Claude Code + omp
skills/slurm                       ← symlink → canonical, for `omp install github:…`
package.json                       ← makes the repo an omp plugin
install.sh                         ← symlinks the skill for codex/opencode/others
```

## License

[MIT](LICENSE) © 2026 Max Bromberg.
