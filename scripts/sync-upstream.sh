#!/usr/bin/env bash
# Pull the ponytail skill bodies from upstream, re-record the lock, then verify.
#
#   bash scripts/sync-upstream.sh
#   UPSTREAM_REPO=git@github.com:DietrichGebert/ponytail.git bash scripts/sync-upstream.sh
#
# Only skills/<name>/SKILL.md is copied: the rest of upstream (hooks, per-host
# adapters, benchmark) belongs to other hosts and is not used here. Nothing else in
# this repo is touched, so the DSH-specific code keeps its own review history.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/DietrichGebert/ponytail}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "cloning ${UPSTREAM_REPO}"
git clone --depth 1 "${UPSTREAM_REPO}" "${TMP}/upstream" >/dev/null 2>&1

VERSION="$(node -e "process.stdout.write(require('${TMP}/upstream/package.json').version)")"
COMMIT="$(git -C "${TMP}/upstream" rev-parse HEAD)"
echo "upstream ${VERSION} @ ${COMMIT}"

for dir in "${TMP}"/upstream/skills/*/; do
  name="$(basename "${dir}")"
  if [ ! -f "${dir}SKILL.md" ]; then
    continue
  fi
  mkdir -p "${ROOT}/skills/${name}"
  cp "${dir}SKILL.md" "${ROOT}/skills/${name}/SKILL.md"
  echo "  synced ${name}"
done

node "${ROOT}/scripts/record-lock.mjs" --upstream-version="${VERSION}" --upstream-commit="${COMMIT}"

echo
echo "running verify (11 assertion groups)"
node "${ROOT}/scripts/verify.mjs"

echo
echo "done. Review the diff, bump the version, then commit."
echo "note: a level table change in upstream may need a matching update in lib/baseline.js"
