#!/usr/bin/env bash
# Sync the current worktree to an authorized Linux host; no host credentials are copied.
set -euo pipefail

: "${DROVER_LINUX_HOST:?Set DROVER_LINUX_HOST to an authorized SSH host}"
[[ "$DROVER_LINUX_HOST" =~ ^[a-zA-Z0-9_@.:-]+$ && "$DROVER_LINUX_HOST" != -* ]] || { echo 'Invalid SSH host' >&2; exit 1; }
remote_base=${DROVER_LINUX_DIR:-drover-linux-build}
[[ "$remote_base" =~ ^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$ ]] || { echo 'DROVER_LINUX_DIR must be a relative directory without spaces or traversal' >&2; exit 1; }
arm64=${DROVER_LINUX_ARM64:-auto}
case "$arm64" in auto|required|off) ;; *) echo 'DROVER_LINUX_ARM64 must be auto, required, or off' >&2; exit 1;; esac
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
destination=${DROVER_LINUX_OUTPUT:-"$HOME/remote-mac/linux-packages"}
ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15)
if [[ -n ${DROVER_LINUX_SSH_CONFIG:-} ]]; then ssh_args+=(-F "$DROVER_LINUX_SSH_CONFIG"); fi
printf -v rsync_ssh '%q ' ssh "${ssh_args[@]}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_run="$remote_base/runs/$run_id"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# git's ignored-file rules also exclude generated remote credentials. Explicit
# exclusions cover local agent state and secrets even if they were not ignored.
while IFS= read -r -d '' file; do
  [[ ! -e "$repo/$file" && ! -L "$repo/$file" ]] || printf '%s\0' "$file"
done < <(git -C "$repo" ls-files -z --cached --others --exclude-standard) > "$scratch/files"
echo "Syncing worktree to $DROVER_LINUX_HOST:$remote_run/tree"
ssh "${ssh_args[@]}" "$DROVER_LINUX_HOST" "mkdir -p '$remote_run/tree'"
rsync -ar --from0 --files-from="$scratch/files" -e "$rsync_ssh" \
  --exclude='.git' --exclude='.drover' --exclude='.codex' --exclude='.claude' \
  --exclude='AGENTS.md' --exclude='node_modules' --exclude='out' --exclude='release' \
  --exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' \
  --exclude='*ed25519*' --exclude='keys' --exclude='known_hosts' --exclude='*.log' \
  "$repo/" "$DROVER_LINUX_HOST:$remote_run/tree/"

ssh "${ssh_args[@]}" "$DROVER_LINUX_HOST" "bash -s -- '$remote_run' '$arm64'" <<'REMOTE'
set -euo pipefail
run=$(realpath "$1")
arm64=$2
cd "$run/tree"
[[ $(uname -m) == x86_64 ]] || { echo 'Native x64 build requires an x86_64 host' >&2; exit 1; }
docker buildx version
mkdir -p "$run/artifacts" "$run/logs"
architectures=(x64)
if [[ "$arm64" != off ]]; then
  if docker buildx inspect --bootstrap | grep -Eq 'Platforms:.*linux/arm64'; then
    architectures+=(arm64)
  elif [[ "$arm64" == required ]]; then
    echo 'arm64 requires a buildx builder with QEMU/binfmt support' >&2; exit 1
  else
    echo 'arm64 unavailable on remote builder; retain matching local arm64 packages' >&2
  fi
fi
for arch in "${architectures[@]}"; do
  platform=linux/amd64
  [[ "$arch" != arm64 ]] || platform=linux/arm64
  image="drover-linux-build:$arch"
  docker buildx build --platform "$platform" --load -f scripts/linux/Dockerfile -t "$image" . 2>&1 | tee "$run/logs/image-$arch.log"
  if [[ "$arch" == x64 ]]; then
    docker run --rm --platform "$platform" --network none "$image" sh -c 'npm run typecheck && npm test' 2>&1 | tee "$run/logs/checks.log"
  fi
  mkdir -p "$run/release-$arch"
  docker run --rm --platform "$platform" \
    -v "$run/release-$arch:/build/release" \
    -v drover-linux-electron-cache:/root/.cache/electron \
    -v drover-linux-builder-cache:/root/.cache/electron-builder \
    "$image" npm run dist:linux -- AppImage deb "--$arch" 2>&1 | tee "$run/logs/package-$arch.log"
  images=("$run/release-$arch/"*.AppImage)
  debs=("$run/release-$arch/"*.deb)
  [[ ${#images[@]} == 1 && -f ${images[0]} && ${#debs[@]} == 1 && -f ${debs[0]} ]]
  smoke_args=()
  [[ "$arch" != arm64 ]] || smoke_args+=(--qemu-appimage)
  docker run --rm --platform "$platform" --network none -v "$run/release-$arch:/packages:ro" \
    "$image" node scripts/linux/smoke.mjs "/packages/$(basename "${images[0]}")" "${smoke_args[@]}" 2>&1 | tee "$run/logs/smoke-$arch.log"
  docker run --rm --platform "$platform" --network none -v "$run/release-$arch:/packages:ro" \
    "$image" dpkg-deb -f "/packages/$(basename "${debs[0]}")" Package Version Architecture | tee "$run/logs/deb-$arch.log"
  cp "${images[0]}" "${debs[0]}" "$run/artifacts/"
done
cd "$run/artifacts"
sha256sum *.AppImage *.deb > "$run/SHA256SUMS"
REMOTE

mkdir -p "$(dirname "$destination")"
staging=$(mktemp -d "$(dirname "$destination")/.linux-packages.XXXXXX")
trap 'rm -rf "$scratch" "$staging"' EXIT
rsync -ar -e "$rsync_ssh" "$DROVER_LINUX_HOST:$remote_run/artifacts/" "$staging/"
rsync -ar -e "$rsync_ssh" "$DROVER_LINUX_HOST:$remote_run/SHA256SUMS" "$scratch/"
(cd "$staging" && shasum -a 256 -c "$scratch/SHA256SUMS")
# If remote arm64 is unavailable, accept only the same-version previous arm64
# pair. Never silently deliver a mixed-version or incomplete package directory.
x64_images=("$staging/"*-x86_64.AppImage)
[[ ${#x64_images[@]} == 1 && -f ${x64_images[0]} ]]
prefix=$(basename "${x64_images[0]}" -x86_64.AppImage)
if [[ ! -f "$staging/$prefix-arm64.AppImage" ]]; then
  for ext in AppImage deb; do
    [[ -f "$destination/$prefix-arm64.$ext" ]] || { echo "Missing matching local arm64 $ext; artifacts remain at $DROVER_LINUX_HOST:$remote_run" >&2; exit 1; }
    cp -p "$destination/$prefix-arm64.$ext" "$staging/"
  done
  echo 'Retained previous matching arm64 packages; only x64 was rebuilt' >&2
fi
for name in "$prefix-x86_64.AppImage" "$prefix-amd64.deb" "$prefix-arm64.AppImage" "$prefix-arm64.deb"; do
  [[ -s "$staging/$name" ]]
done
backup="$destination.previous-$run_id"
[[ ! -e "$destination" || ( -d "$destination" && ! -L "$destination" ) ]]
if [[ -e "$destination" ]]; then mv "$destination" "$backup"; fi
if ! mv "$staging" "$destination"; then
  [[ ! -e "$backup" ]] || mv "$backup" "$destination"
  exit 1
fi
rm -rf "$backup"
logs="$(dirname "$destination")/linux-build-$run_id"
mkdir -p "$logs"
rsync -ar -e "$rsync_ssh" "$DROVER_LINUX_HOST:$remote_run/logs/" "$logs/"
cp "$scratch/SHA256SUMS" "$logs/"
echo "Packages: $destination"
echo "Logs: $logs"
echo "Remote snapshot: $remote_run/tree"
ls -ln "$destination/"
