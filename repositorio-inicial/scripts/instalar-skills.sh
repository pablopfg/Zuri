#!/usr/bin/env bash
# Installs the Claude Code plugins this repo relies on: the official Cloudflare
# plugin and the pinned external skills in .claude/skills-externas.
# Runs on every session start (hook in .claude/settings.json) and is idempotent.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v claude >/dev/null || exit 0

MK=zuri-skills-externas
PLUGINS=(
  "cloudflare@cloudflare"
  "mattpocock-skills@$MK"
  "nateherk-design@$MK"
  "cloudflare-security-audit@$MK"
  "humanizer@$MK"
)

markets="$(claude plugin marketplace list 2>/dev/null || true)"
grep -q "$MK" <<<"$markets" || claude plugin marketplace add ./.claude/skills-externas >/dev/null
grep -q "cloudflare/skills" <<<"$markets" || claude plugin marketplace add cloudflare/skills >/dev/null
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
