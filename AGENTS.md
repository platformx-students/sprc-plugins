<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->

# AGENTS.md

This repository distributes the lab's `slurm` Agent Skill across Claude Code, omp, opencode, and Codex. It keeps one canonical skill source plus the manifests, installer, and symlink needed by those clients.

**Keep this file current:** update `AGENTS.md` in the same change whenever repository structure, contributor workflow, validation, installation, or invariants change.

**Precedence:** the closest `AGENTS.md` to edited files wins. Explicit user instructions override repository guidance.

## Stable Structure

- `plugins/sprc-slurm/skills/slurm/` is the canonical skill source.
- `skills/slurm` must remain a relative symlink to that source.
- Plugin/package manifests, `install.sh`, and `README.md` are integration surfaces; inspect all affected surfaces instead of relying on a duplicated file map here.
- One skill source serves every supported client. Do not create client-specific copies.

## Working Rules

- Edit the canonical source, not the compatibility symlink or an installed copy.
- Treat `SKILL.md` frontmatter as routing behavior; positive and negative triggers both matter.
- The course-context refusal is a hard academic-integrity boundary. Ask before weakening or removing it.
- Cluster limits, reservations, availability, and policy are mutable. Verify them from the relevant source or live system instead of recording values here.
- When changing shared behavior, search the skill, references, templates, manifests, installer, and README for affected callouts; update only what the change actually touches.
- Keep detailed facts in references and reusable job scripts in assets. Keep the main skill focused on agent decisions and actions.
- Keep host-versus-worker placement and project-storage rules consistent across the skill, references, and job templates.

## Verification

| Changed area | Smallest check |
|---|---|
| Shell or `.sbatch` | `bash -n <changed-files>` |
| JSON metadata | `python3 -m json.tool <changed-file>` |
| Installer | Run `./install.sh` against a temporary directory and inspect the resulting link |
| Skill layout | Confirm `readlink skills/slurm` still targets the canonical source |

There is no project-wide build or test suite unless the repository adds one. Do not invent infrastructure for a documentation-only change.

## Ask First

- Add dependencies, CI, generated scaffolding, or another copy of the skill.
- Change installation destinations, plugin/package identities, or the academic-integrity boundary.

## Never

- Edit installed copies or caches under `~/.claude`, `~/.codex`, or `~/.config/opencode`.
- Replace `skills/slurm` with copied content.
- Submit a real cluster job merely to validate repository documentation.
- Guess mutable cluster facts.

Add a scoped `AGENTS.md` only when a subtree genuinely needs different rules.
