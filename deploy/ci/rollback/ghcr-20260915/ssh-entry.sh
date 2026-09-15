#!/usr/bin/env bash
set -euo pipefail
# Installed root-owned; authorized_keys forces this command and disables forwarding.
exec sudo -n /usr/local/sbin/hongyun-deploy "${SSH_ORIGINAL_COMMAND:-}"
