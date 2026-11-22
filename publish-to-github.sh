#!/usr/bin/env bash
# One-time: create the git repo and push it to GitHub as a private repo.
# Run from anywhere:  bash ~/dev/src/github.com/etiennep/homey-mitsubishi-comfort/publish-to-github.sh
set -euo pipefail
cd "$(dirname "$0")"

REPO="etiennep/homey-mitsubishi-comfort"

if [ ! -d .git ]; then
  git init -b main
fi

git add .
echo "--- files to be committed ---"
git status --short
if git ls-files --cached --error-unmatch kumo-creds.json >/dev/null 2>&1; then
  echo "ERROR: kumo-creds.json is staged — aborting." >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "(nothing new to commit)"
else
  git commit -m "Homey app for Mitsubishi Comfort mini-splits (cloud + local)"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create "$REPO" --private --source . --remote origin --push \
    --description "Homey app for Mitsubishi Comfort (formerly Kumo Cloud) mini-splits"
fi

echo
echo "Done: https://github.com/$REPO"
