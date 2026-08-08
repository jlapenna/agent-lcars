FROM python:3.14-alpine@sha256:a1321512d6a287428c50dcdf2ab3857761127e03a23b1f648e9c1c0de59288f8

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /var/lib/github-actions-exporter \
    && chown 65534:65534 /var/lib/github-actions-exporter

COPY exporter.py ./

USER 65534:65534

CMD ["python", "-u", "exporter.py"]
