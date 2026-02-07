#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# Ensure Go is installed and in PATH
. tools/cloud-build-ensure-go.sh

# Debug: List root structure
echo "Current directory: $(pwd)"
echo "Root contents:"
ls -F


