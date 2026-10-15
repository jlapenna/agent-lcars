FROM python:3.15-alpine@sha256:ff4d3c9b1a48f646eedd93182aaea385c7a5452f4c8a8cd7cef686babacf4928

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
