#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

image=${1:-}
[[ $# == 1 && "$image" =~ ^ghcr\.io/jjgitt/junjunorder@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Only this project image with a sha256 digest may be deployed' >&2; exit 64;
}
[[ $EUID == 0 ]] || { echo 'Must run through the restricted sudo entry' >&2; exit 1; }
exec 9>/var/lock/hongyun-deploy.lock
flock -w 900 9 || { echo 'Another deployment is running'; exit 1; }
cd /home/junjun/hongyun-order
compose=(docker compose --project-name hongyun-order --env-file .env -f compose.yaml -f deploy/compose.server.yaml -f /etc/hongyun-cicd/compose.image.yaml)
export DEPLOY_IMAGE="$image"

retain_rollbacks=3
retain_backups=10
minimum_free_kb=$((5 * 1024 * 1024))

housekeeping() {
  local tag id name path resolved index
  local -a rollback_tags backup_paths stopped_builders

  mapfile -t rollback_tags < <(docker image ls hongyun-order-app --format '{{.Tag}}' | grep -E '^rollback-[0-9]{14}$' | sort -r || true)
  for ((index=retain_rollbacks; index<${#rollback_tags[@]}; index++)); do
    tag=${rollback_tags[$index]}
    docker image rm "hongyun-order-app:$tag" >/dev/null || echo "Warning: could not remove old rollback image $tag" >&2
  done

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
cleanup() { rm -f "$auth_dir/config.json"; rmdir "$auth_dir"; }
trap cleanup EXIT
export DOCKER_CONFIG="$auth_dir"
IFS= read -r registry_user
IFS= read -r registry_token
[[ "$registry_user" =~ ^[a-zA-Z0-9_-]+$ && -n "$registry_token" ]] || exit 64
printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin
unset registry_token
pulled=false
for attempt in 1 2 3; do
  if docker pull "$image"; then pulled=true; break; fi
  sleep 5
done
[[ "$pulled" == true ]] || { echo 'Image pull failed; running service unchanged'; exit 1; }
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
