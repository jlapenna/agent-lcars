FROM python:3.15-alpine@sha256:a0f2e268f2ce8f3709611a90054ec6a8ae31f6251f5896b8648b9bb99835e30a

WORKDIR /app

COPY requirements.lock .
# The pinned base is already the newest python:3.15-alpine digest; pull fixed
# Alpine packages published after it was built. Nothing installs packages at
# runtime, so drop the packaging tools (and their vendored msgpack/urllib3/
# setuptools findings) once the requirements are in.
RUN apk upgrade --no-cache \
    && pip install --no-cache-dir -r requirements.lock \
    && pip uninstall -y pip setuptools wheel \
    && mkdir -p /var/lib/github-actions-exporter \
    && chown 65534:65534 /var/lib/github-actions-exporter

# The remote BuildKit source context can materialize source files as 0600.
# Set the runtime contract explicitly: this image executes as nobody below.
COPY --chmod=0644 exporter.py ./

USER 65534:65534

CMD ["python", "-u", "exporter.py"]
