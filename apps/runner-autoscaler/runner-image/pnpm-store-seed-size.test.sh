#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
max_combined_compressed_bytes=$((1536 * 1024 * 1024))
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for command in docker jq tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "pnpm store size check requires $command" >&2
    exit 1
  fi
done

compressed_layer_bytes() {
  local archive="$1"
  local manifest_digest manifest_blob
  manifest_digest="$(tar -xOf "$archive" index.json | jq -r '.manifests[0].digest')"
  manifest_blob="blobs/sha256/${manifest_digest#sha256:}"
  tar -xOf "$archive" "$manifest_blob" | jq '[.layers[].size] | add // 0'
}

for platform in linux/amd64 linux/arm64; do
  safe_platform="${platform//\//-}"
  combined_bytes=0

  for target in pnpm10-store-content pnpm-store-content; do
    archive="$tmp/${target}-${safe_platform}.oci.tar"
    docker buildx build \
      --platform "$platform" \
      --target "$target" \
      --output "type=oci,dest=$archive" \
      "$here" >/dev/null
    layer_bytes="$(compressed_layer_bytes "$archive")"
    if [[ ! "$layer_bytes" =~ ^[0-9]+$ ]] || (( layer_bytes == 0 )); then
      echo "could not measure compressed $target payload for $platform" >&2
      exit 1
    fi
    printf 'pnpm-store-seed-size: platform=%s target=%s compressed_bytes=%s\n' \
      "$platform" "$target" "$layer_bytes"
    combined_bytes=$((combined_bytes + layer_bytes))
  done

  printf 'pnpm-store-seed-size: platform=%s combined_compressed_bytes=%s budget_bytes=%s\n' \
    "$platform" "$combined_bytes" "$max_combined_compressed_bytes"
  if (( combined_bytes > max_combined_compressed_bytes )); then
    echo "pnpm store seed exceeds the 1.5 GiB compressed budget on $platform" >&2
    exit 1
  fi
done
