#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# Ensure Go is installed and in PATH
. tools/cloud-build-ensure-go.sh

# Fix for TS6305: App Hosting preserves workspace states across builds
# which can leave stale .tsbuildinfo files or partial dist/ outputs.
echo "Cleaning up dist and tsbuildinfo to ensure a clean build..."
find . -name "*.tsbuildinfo" -type f -delete
find apps libs -name "dist" -type d -prune -exec rm -rf '{}' +
