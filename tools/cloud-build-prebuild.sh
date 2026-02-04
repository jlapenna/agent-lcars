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

# Link shared library
echo "Linking shared library..."
if [ -d "libs/shared" ]; then
    echo "libs/shared found."
    mkdir -p node_modules/@members
    ln -sf ../../libs/shared node_modules/@members/shared
    echo "Link created: node_modules/@members/shared -> $(readlink node_modules/@members/shared)"
else
    echo "ERROR: libs/shared NOT found!"
    exit 1
fi

# Build shared library
echo "Building shared library..."
export NODE_OPTIONS="--max-old-space-size=4096"
./node_modules/.bin/nx build shared

