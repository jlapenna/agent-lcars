#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# App Hosting preserves workspace state across builds. Remove stale task
# outputs before Nx runs so a cache hit has to restore the complete declared
# output instead of inheriting files from the previous build. Keep .nx/cache:
# it is content-addressed and is the managed builder's only configured
# cross-build Nx cache layer.
echo "Cleaning up dist and tsbuildinfo while preserving the Nx cache..."
rm -rf dist
find . -name "*.tsbuildinfo" -type f -delete
find apps libs -name "dist" -type d -prune -exec rm -rf '{}' +
