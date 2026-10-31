#!/usr/bin/env bash
# Installs the Claude Code plugins this repo relies on, all pinned to a reviewed
# commit in .claude/skills-externas (the official Cloudflare plugin included).
# Runs on every session start (hook in .claude/settings.json) and is idempotent.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v claude >/dev/null || exit 0

MK=zuri-skills-externas
PLUGINS=(
  "cloudflare@$MK"
  "mattpocock-skills@$MK"
  "nateherk-design@$MK"
  "cloudflare-security-audit@$MK"
  "humanizer@$MK"
)

markets="$(claude plugin marketplace list 2>/dev/null || true)"
grep -q "$MK" <<<"$markets" || claude plugin marketplace add ./.claude/skills-externas >/dev/null
# Re-read the local catalog so a SHA bumped by a merged PR takes effect.
claude plugin marketplace update "$MK" >/dev/null 2>&1 || true

installed="$(claude plugin list 2>/dev/null || true)"
for p in "${PLUGINS[@]}"; do
  if grep -qF "$p" <<<"$installed"; then
    claude plugin update "$p" --scope project >/dev/null 2>&1 || true
  else
    claude plugin install "$p" --scope project >/dev/null
  fi
done
