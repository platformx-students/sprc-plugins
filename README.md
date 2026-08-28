<div align="center">

# ⚡ sprc-plugins

### Cluster superpowers for the **sprc** H100 cluster

<sub>4 nodes · 8× H100-NVL · Slurm · controller <code>sprlab005</code></sub>

</div>

---

One agent **skill**, `slurm`, that lets your coding agent *actually run your work* on the **sprc**
cluster instead of just explaining how: it stages and submits `sbatch` jobs, opens interactive
`salloc` GPU sessions, picks sane GPUs/walltime/QoS, and monitors/debugs jobs — execute-first,
terse, tuned to this cluster's real defaults and policies.

The skill is a single [Agent Skill](https://agentskills.io) (`SKILL.md` + references + a job
template), so the same content works across Claude Code, oh-my-pi, opencode, and codex. Pick your
tool below.

## Install

### Claude Code

```
/plugin marketplace add platformx-students/sprc-plugins
/plugin install sprc-slurm@sprc-plugins
/reload-plugins
```

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

The skill should show up as `/skill:slurm`.

### opencode & codex

Both read the same `SKILL.md` format. Clone the repo and run the installer — it symlinks the skill
into each tool's skills directory:

```
git clone https://github.com/platformx-students/sprc-plugins
cd sprc-plugins
./install.sh
```

This links the skill into `~/.codex/skills/slurm` (codex) and `~/.config/opencode/skills/slurm`
(opencode). To install for a single project instead — one dir both tools read — pass a target:

```
./install.sh /path/to/project/.agents/skills
```

Restart opencode/codex afterward. (`install.sh` symlinks rather than copies, so edits to the repo
propagate; re-run it if you move the repo.) 

You should now be able to see the `slurm` skill in `/skills`!

## Use it

Ask your agent to run cluster work in plain language — *"get train.py running on the cluster for
~6h"*, *"grab me a GPU node to debug in"*, *"submit these as an overnight scavenger sweep"* — and
the skill takes it from there. The agent picks it up automatically when your request matches; in
codex/opencode you can also invoke it explicitly (`$slurm` in codex, the `skill` tool in opencode).

## Layout

```
plugins/sprc-slurm/skills/slurm/   ← the skill (canonical source): SKILL.md, references/, assets/
.claude-plugin/marketplace.json    ← catalog for Claude Code + omp
skills/slurm                       ← symlink → canonical, for `omp install github:…`
package.json                       ← makes the repo an omp plugin
install.sh                         ← symlinks the skill for opencode/codex
```

## License

[MIT](LICENSE) © 2026 Max Bromberg.
