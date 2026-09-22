#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

image=${1:-}
# Exact repositories this server may deploy from: GHCR (build source), Huawei SWR (China hop), Aliyun ACR (preferred).
ghcr_image='^ghcr\.io/jjgitt/junjunorder@sha256:[a-f0-9]{64}$'
swr_image='^swr\.cn-north-4\.myhuaweicloud\.com/junjunorder/junjunorder@sha256:[a-f0-9]{64}$'
acr_image='^crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com/junjunorder/junjunorder@sha256:[a-f0-9]{64}$'
[[ $# == 1 && ( "$image" =~ $ghcr_image || "$image" =~ $swr_image || "$image" =~ $acr_image ) ]] || {
  echo 'Only this project image with a sha256 digest may be deployed' >&2; exit 64;
}
case "$image" in
  ghcr.io/*) registry_host=ghcr.io ;;
  swr.cn-north-4.myhuaweicloud.com/*) registry_host=swr.cn-north-4.myhuaweicloud.com ;;
  *) registry_host=crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com ;;
esac
[[ $EUID == 0 ]] || { echo 'Must run through the restricted sudo entry' >&2; exit 1; }
exec 9>/var/lock/hongyun-deploy.lock
flock -w 900 9 || { echo 'Another deployment is running'; exit 1; }
cd /home/junjun/hongyun-order
compose=(docker compose --project-name hongyun-order --env-file .env -f compose.yaml -f deploy/compose.server.yaml -f /etc/hongyun-cicd/compose.image.yaml)
export DEPLOY_IMAGE="$image"

retain_rollbacks=3
retain_backups=10
minimum_free_kb=$((5 * 1024 * 1024))
pull_attempts=3
pull_timeout_seconds=300
pull_kill_after_seconds=15
declare -A keep_ids=()

keep_project_image_id() {
  local id=${1:-}
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 0
  keep_ids["$id"]=1
}

# Drop GHCR/SWR/ACR digest copies that are no longer the running app, latest, or a kept rollback.
prune_unused_project_images() {
  local cid id tag current_ref
  local -a rollback_tags
  keep_ids=()

  cid=$("${compose[@]}" ps -q app 2>/dev/null || true)
  if [[ -n "$cid" ]]; then
    keep_project_image_id "$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  fi
  keep_project_image_id "$(docker image inspect --format '{{.Id}}' hongyun-order-app:latest 2>/dev/null || true)"
  if [[ -s /var/lib/hongyun-cicd/current-image ]]; then
    current_ref=$(tr -d '\n' </var/lib/hongyun-cicd/current-image)
    if [[ "$current_ref" =~ $ghcr_image || "$current_ref" =~ $swr_image || "$current_ref" =~ $acr_image ]]; then
      keep_project_image_id "$(docker image inspect --format '{{.Id}}' "$current_ref" 2>/dev/null || true)"
    fi
  fi
  mapfile -t rollback_tags < <(docker image ls hongyun-order-app --format '{{.Tag}}' | grep -E '^rollback-[0-9]{14}$' | sort -r || true)
  for tag in "${rollback_tags[@]}"; do
    keep_project_image_id "$(docker image inspect --format '{{.Id}}' "hongyun-order-app:$tag" 2>/dev/null || true)"
  done

  while IFS= read -r id; do
    [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || continue
    [[ -n "${keep_ids[$id]:-}" ]] && continue
    docker image rm "$id" >/dev/null || echo "Warning: could not remove unused project image $id" >&2
  done < <(docker image ls --no-trunc --format '{{.ID}} {{.Repository}}' | awk '
    $2 == "ghcr.io/jjgitt/junjunorder" ||
    $2 == "swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder" ||
    $2 == "crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder" ||
    $2 == "hongyun-order-app" { print $1 }
  ' | sort -u)
}

housekeeping() {
  local tag id name path resolved index
  local -a rollback_tags backup_paths stopped_builders

  mapfile -t rollback_tags < <(docker image ls hongyun-order-app --format '{{.Tag}}' | grep -E '^rollback-[0-9]{14}$' | sort -r || true)
  for ((index=retain_rollbacks; index<${#rollback_tags[@]}; index++)); do
    tag=${rollback_tags[$index]}
    docker image rm "hongyun-order-app:$tag" >/dev/null || echo "Warning: could not remove old rollback image $tag" >&2
  done
  prune_unused_project_images

  mapfile -t backup_paths < <(find /home/junjun -maxdepth 1 -mindepth 1 -type d -name 'hongyun-ci-backup.*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
  for ((index=retain_backups; index<${#backup_paths[@]}; index++)); do
    path=${backup_paths[$index]}
    resolved=$(readlink -f -- "$path")
    if [[ "$resolved" =~ ^/home/junjun/hongyun-ci-backup\.[A-Za-z0-9]+$ ]]; then
      rm -rf -- "$resolved"
    else
      echo "Warning: refused unexpected backup path $path" >&2
    fi
  done

  mapfile -t stopped_builders < <(docker ps -aq --filter status=exited --filter name=hongyun-build-)
  for id in "${stopped_builders[@]}"; do
    name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null || true)
    name=${name#/}
    [[ "$name" =~ ^hongyun-build-[A-Za-z0-9_.-]+$ ]] && docker rm "$id" >/dev/null || true
  done

  # Production pulls prebuilt images and never needs local build cache.
  docker builder prune -af >/dev/null || echo 'Warning: Docker build cache cleanup failed' >&2
}

housekeeping
available_kb=$(df --output=avail -k / | tail -n 1 | tr -d ' ')
[[ "$available_kb" =~ ^[0-9]+$ ]] || { echo 'Unable to determine free disk space' >&2; exit 1; }
(( available_kb >= minimum_free_kb )) || {
  echo 'Deployment stopped: less than 5 GiB free after safe cleanup' >&2
  exit 75
}

auth_dir=$(mktemp -d /tmp/hongyun-registry.XXXXXXXX)
cleanup() {
  if [[ "$auth_dir" =~ ^/tmp/hongyun-registry\.[A-Za-z0-9]+$ ]]; then
    rm -rf -- "$auth_dir"
  else
    echo "Warning: refused unexpected registry authentication path $auth_dir" >&2
  fi
}
trap cleanup EXIT
export DOCKER_CONFIG="$auth_dir"

login_registry() {
  local host=$1 user=$2 token=$3
  [[ "$user" =~ ^[^[:space:][:cntrl:]]+$ && ${#user} -le 128 && -n "$token" ]] || exit 64
  printf '%s' "$token" | docker login "$host" -u "$user" --password-stdin
}

pull_digest() {
  local ref=$1 attempt pull_status
  for ((attempt=1; attempt<=pull_attempts; attempt++)); do
    echo "Pulling image (attempt $attempt/$pull_attempts, timeout ${pull_timeout_seconds}s): $ref"
    if timeout --signal=TERM --kill-after="${pull_kill_after_seconds}s" "${pull_timeout_seconds}s" docker pull "$ref"; then
      return 0
    fi
    pull_status=$?
    if (( pull_status == 124 || pull_status == 137 )); then
      echo "Image pull attempt $attempt timed out after ${pull_timeout_seconds}s" >&2
    else
      echo "Image pull attempt $attempt failed with status $pull_status" >&2
    fi
    if (( attempt < pull_attempts )); then sleep 5; fi
  done
  return 1
}

IFS= read -r registry_user
IFS= read -r registry_token
# GHCR uses the GitHub actor, SWR uses region@AK, Aliyun ACR uses the account login name (may look like an email).
[[ "$registry_user" =~ ^[^[:space:][:cntrl:]]+$ && ${#registry_user} -le 128 && -n "$registry_token" ]] || exit 64

# Aliyun personal ACR cannot be filled from a US GitHub runner (cross-border push stalls).
# When the target is ACR, stdin also carries a China-reachable seed: SWR first, else GHCR.
if [[ "$image" =~ $acr_image ]]; then
  IFS= read -r seed_user
  IFS= read -r seed_token
  IFS= read -r seed_repository
  digest=${image##*@}
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 64
  [[ "$seed_repository" =~ ^(ghcr\.io/jjgitt/junjunorder|swr\.cn-north-4\.myhuaweicloud\.com/junjunorder/junjunorder)$ ]] || exit 64
  case "$seed_repository" in
    ghcr.io/*) seed_host=ghcr.io ;;
    *) seed_host=swr.cn-north-4.myhuaweicloud.com ;;
  esac
  login_registry "$registry_host" "$registry_user" "$registry_token"
  if ! pull_digest "$image"; then
    echo "ACR is missing $digest; pulling $seed_repository and pushing ACR from this China server"
    login_registry "$seed_host" "$seed_user" "$seed_token"
    pull_digest "$seed_repository@$digest" || { echo 'Image pull failed; running service unchanged'; exit 1; }
    login_registry "$registry_host" "$registry_user" "$registry_token"
    seed_id=$(docker image inspect --format '{{.Id}}' "$seed_repository@$digest")
    docker tag "$seed_id" "crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder:from-seed"
    if timeout --signal=TERM --kill-after="${pull_kill_after_seconds}s" 600s \
      docker push "crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder:from-seed" \
      && pull_digest "$image"; then
      echo 'ACR now has the digest; deploying from Aliyun ACR'
    else
      echo 'Warning: China-side ACR push failed; deploying the identical seed digest' >&2
      image="$seed_repository@$digest"
    fi
  fi
  unset registry_token seed_token
else
  login_registry "$registry_host" "$registry_user" "$registry_token"
  unset registry_token
  pull_digest "$image" || { echo 'Image pull failed; running service unchanged'; exit 1; }
fi
old_id=$("${compose[@]}" ps -q app)
[[ -n "$old_id" ]] || { echo 'Expected existing production application'; exit 1; }
old_image=$(docker inspect --format '{{.Image}}' "$old_id")
backup_dir=$(mktemp -d /home/junjun/hongyun-ci-backup.XXXXXXXX)
"${compose[@]}" exec -T postgres pg_dump -U junjun -d junjun_order -Fc > "$backup_dir/database.dump"
test -s "$backup_dir/database.dump"
printf '%s\n' "$old_image" > "$backup_dir/previous-image"
docker tag "$old_image" "hongyun-order-app:rollback-$(date -u +%Y%m%d%H%M%S)"

healthy() {
  local cid state
  for attempt in $(seq 1 30); do
    cid=$("${compose[@]}" ps -q app)
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)
    if [[ "$state" == healthy ]] && curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null; then return 0; fi
    sleep 4
  done
  return 1
}

rollback() {
  trap - ERR INT TERM HUP
  echo 'Deployment failed; restoring previous application image (database is NOT rolled back).' >&2
  export DEPLOY_IMAGE="$old_image"
  if "${compose[@]}" up -d --no-deps --no-build app && healthy; then
    echo 'Previous application image restored.' >&2
  else
    echo "URGENT: rollback unhealthy; investigate manually. Database backup: $backup_dir" >&2
  fi
  exit 1
}
trap rollback ERR INT TERM HUP
"${compose[@]}" up -d --no-deps --no-build app
healthy
# Keep existing administrator restart commands on the successfully deployed image.
docker tag "$image" hongyun-order-app:latest
install -d -m 700 /var/lib/hongyun-cicd
printf '%s\n' "$image" > /var/lib/hongyun-cicd/current-image
trap - ERR INT TERM HUP
housekeeping
echo 'Deployment healthy. Database and image uploads remain in existing volumes.'
