#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# Go is only needed for apps/agent (Go service)
# Skip Go installation for Node.js-only services
if [ -f "apps/agent/go.mod" ] || [ -f "go.mod" ]; then
    . tools/cloud-build-ensure-go.sh
fi

# Fix for TS6305: App Hosting preserves workspace states across builds
# which can leave stale .tsbuildinfo files or partial dist/ outputs.
echo "Cleaning up dist and tsbuildinfo to ensure a clean build..."
find . -name "*.tsbuildinfo" -type f -delete
find apps libs -name "dist" -type d -prune -exec rm -rf '{}' +
