FROM python:3.15-alpine@sha256:1afb480ba8d3b3b7a8439a84f2365ce5c75ac45a79cf07daa091b49235cbe27b

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
