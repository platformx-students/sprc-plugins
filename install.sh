#!/usr/bin/env bash
# Install the sprc `slurm` agent skill for whichever coding agents you use.
#
# The skill is a plain SKILL.md folder (the agentskills.io cross-agent format), so
# one source serves every harness — the only difference is which directory each one
# scans. This script symlinks the canonical skill into those directories.
#
#   ./install.sh                  # every harness detected on this machine (+ ~/.agents/skills)
#   ./install.sh --all            # every known harness dir, whether or not it's installed
#   ./install.sh --project        # this repo's ./.agents/skills  (codex + opencode read it)
#   ./install.sh --project DIR    # DIR/.agents/skills
#   ./install.sh /some/skills/dir # one explicit skills directory
#   ./install.sh --list           # show the target table and exit
#   ./install.sh --uninstall      # remove symlinks this script created
#
# Claude Code and oh-my-pi users normally want the marketplace instead (see README);
# the ~/.claude/skills and ~/.omp/agent/skills targets here are the no-marketplace path.
#
# Symlink, not copy: one source of truth, edits propagate. The repo must stay where
# it is — re-run this after moving it.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$repo/plugins/sprc-slurm/skills/slurm"
[ -f "$src/SKILL.md" ] || { echo "error: $src/SKILL.md not found — is this the sprc-plugins repo?" >&2; exit 1; }

# harness | skills dir | detect-if-this-exists ("" = always install)
targets=(
  "cross-agent (codex, opencode, ...)|$HOME/.agents/skills|"
  "codex (legacy path)|${CODEX_HOME:-$HOME/.codex}/skills|${CODEX_HOME:-$HOME/.codex}"
  "opencode|${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills|${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  "Claude Code (personal skills)|$HOME/.claude/skills|$HOME/.claude"
  "oh-my-pi|$HOME/.omp/agent/skills|$HOME/.omp"
)

link() {  # link <skills-dir> <label>
  mkdir -p "$1"
  ln -sfn "$src" "$1/slurm"
  printf '  ✔ %-34s %s/slurm\n' "${2:-}" "$1"
}

unlink_one() {  # unlink_one <skills-dir>
  if [ -L "$1/slurm" ]; then rm -f "$1/slurm"; printf '  ✘ removed %s/slurm\n' "$1"; fi
}

case "${1:-}" in
  -h|--help)
    awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"
    exit 0 ;;
  --list)
    printf '%-34s %-46s %s\n' HARNESS "SKILLS DIR" DETECTED
    for t in "${targets[@]}"; do
      IFS='|' read -r label dir probe <<<"$t"
      det=always; [ -n "$probe" ] && { [ -e "$probe" ] && det=yes || det=no; }
      printf '%-34s %-46s %s\n' "$label" "${dir/#$HOME/\~}" "$det"
    done
    exit 0 ;;
  --uninstall)
    echo "Removing sprc slurm skill symlinks:"
    for t in "${targets[@]}"; do IFS='|' read -r _ dir _ <<<"$t"; unlink_one "$dir"; done
    unlink_one "$repo/.agents/skills"
    exit 0 ;;
  --project)
    base="${2:-$PWD}"
    echo "Installing into project scope (codex + opencode both read .agents/skills):"
    link "$base/.agents/skills" "project"
    echo "Restart your agent to pick it up."
    exit 0 ;;
  --all|"")
    force=false; [ "${1:-}" = "--all" ] && force=true
    echo "Installing the sprc \`slurm\` skill from $repo"
    installed=0
    for t in "${targets[@]}"; do
      IFS='|' read -r label dir probe <<<"$t"
      if [ -z "$probe" ] || $force || [ -e "$probe" ]; then
        link "$dir" "$label"; installed=$((installed+1))
      else
        printf '  – %-34s not installed here (skipped; --all to force)\n' "$label"
      fi
    done
    echo
    echo "$installed target(s) linked. Restart your agent, then check its skill list for \`slurm\`."
    exit 0 ;;
  -*)
    echo "error: unknown option '$1' (try --help)" >&2; exit 2 ;;
  *)
    link "$1" "explicit"
    echo "Restart your agent to pick it up."
    exit 0 ;;
esac
