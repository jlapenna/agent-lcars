#!/bin/bash
set -e

# Serialize the externals populate across concurrently starting runners on the
# same host: externals is a shared bind mount on socket-mounted scale sets, and
# two first-boot runners racing the copy can tear each other's files. The lock
# lives in _work (shared whenever externals is; container-local otherwise, where
# the lock is uncontended and harmless). Dotfile: the workdir sweep's top-level
# glob only matches directories.
mkdir -p /home/runner/_work
exec 9>/home/runner/_work/.externals-populate.lock
flock 9

# If /home/runner/externals is empty or missing, populate it from backup
if [ ! -d "/home/runner/externals" ] || [ -z "$(ls -A /home/runner/externals)" ]; then
  echo "Populating /home/runner/externals from backup..."
  mkdir -p /home/runner/externals
  cp -r /home/runner/externals_backup/. /home/runner/externals/
fi

flock -u 9
exec 9>&-

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
