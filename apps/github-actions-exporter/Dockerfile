FROM python:3.14-alpine@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc

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
