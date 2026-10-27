# Build from an operator-qualified, digest-pinned image containing node, Goose,
# and the profile's tools. This target never installs mutable latest tools.
ARG GOOSE_BASE_IMAGE
FROM ${GOOSE_BASE_IMAGE} AS assembled
ARG GOOSE_BASE_IMAGE
USER root
COPY runtime/goose-*.mjs /usr/local/lib/agent-lcars/runtime/
RUN printf '%s\n' "$GOOSE_BASE_IMAGE" | grep -Eq '^.+@sha256:[a-f0-9]{64}$' \
    && command -v node && command -v goose \
    && node --test /usr/local/lib/agent-lcars/runtime/goose-executor.test.mjs \
    && mkdir -p /usr/local/share \
    && bytes="$(du -sx --apparent-size --block-size=1 / 2>/dev/null | cut -f1)" \
    && test "$bytes" -le 8589934592 \
    && printf '{"version":1,"filesystemBytes":%s}\n' "$bytes" > /usr/local/share/lcars-goose-image-budget.json \
    && chmod 0444 /usr/local/share/lcars-goose-image-budget.json

# Flatten inherited layers: deleted files in the base must not escape image
# accounting. Runtime budgets both compressed and unpacked image storage.
FROM scratch
COPY --from=assembled / /
USER 1001:1001
ENTRYPOINT ["node", "/usr/local/lib/agent-lcars/runtime/goose-worker.mjs"]
