#!/usr/bin/env bash
set -euo pipefail
# Run on the production server as root after pulling this repo revision.
# Backs up the live GHCR-only script, then installs the dual-registry deploy script.

[[ $EUID == 0 ]] || { echo 'Run as root' >&2; exit 1; }

repo_root=${1:-/home/junjun/hongyun-order}
src="$repo_root/deploy/ci/deploy.sh"
[[ -f "$src" ]] || { echo "Missing $src" >&2; exit 1; }
bash -n "$src"

stamp=$(date -u +%Y%m%d%H%M%S)
if [[ -f /usr/local/sbin/hongyun-deploy ]]; then
  install -o root -g root -m 755 /usr/local/sbin/hongyun-deploy "/usr/local/sbin/hongyun-deploy.bak-$stamp"
  echo "Backed up live script to /usr/local/sbin/hongyun-deploy.bak-$stamp"
fi
install -o root -g root -m 755 "$src" /usr/local/sbin/hongyun-deploy
echo 'Installed dual-registry /usr/local/sbin/hongyun-deploy'
echo "Restore GHCR-only script: install -o root -g root -m 755 /usr/local/sbin/hongyun-deploy.bak-$stamp /usr/local/sbin/hongyun-deploy"
