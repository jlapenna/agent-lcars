#!/bin/bash

set -e

if [ -z "$CLOUD_BUILD" ]; then
    echo "Not running in Cloud Build. Skipping prebuild script."
    return 0 2>/dev/null || exit 0
fi

# Ensure Go is installed and in PATH
. tools/cloud-build-ensure-go.sh

# Link shared library
echo "Linking shared library..."
mkdir -p node_modules/@members
ln -sf ../../libs/shared node_modules/@members/shared
