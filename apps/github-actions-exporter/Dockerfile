FROM python:3.14-alpine@sha256:a1321512d6a287428c50dcdf2ab3857761127e03a23b1f648e9c1c0de59288f8

WORKDIR /app

COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock \
    && mkdir -p /var/lib/github-actions-exporter \
    && chown 65534:65534 /var/lib/github-actions-exporter

# The remote BuildKit source context can materialize source files as 0600.
# Set the runtime contract explicitly: this image executes as nobody below.
COPY --chmod=0644 exporter.py ./

USER 65534:65534

CMD ["python", "-u", "exporter.py"]
