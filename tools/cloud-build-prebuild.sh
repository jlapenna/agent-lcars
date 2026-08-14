#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# Remove stale task outputs before Nx runs so any cache hit has to restore the
# complete declared output instead of inheriting files from an earlier task.
# Keep .nx/cache because it is content-addressed and may still be useful within
# one workspace lifetime. Managed App Hosting archive builds observed in #1030
# start in fresh workspaces, so preserving this directory does not itself
# provide a cache across deployments.
echo "Cleaning up dist and tsbuildinfo while preserving the Nx cache..."
rm -rf dist
find . -name "*.tsbuildinfo" -type f -delete
find apps libs -name "dist" -type d -prune -exec rm -rf '{}' +
