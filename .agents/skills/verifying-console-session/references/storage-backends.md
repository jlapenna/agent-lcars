# Saved-session storage backends

Read this before choosing `--storage`, `--state-file`, `--project` or
`--secret-name`, or when a backend path, file mode or permission is in
question. The safety boundary in [SKILL.md](../SKILL.md#safety-boundary)
still applies: the stored state is a bearer credential.

## Local file (default)

The default `local` backend is ready without infrastructure. It writes a raw,
directly reusable Playwright storage state with directory mode `0700` and file
mode `0600`:

```text
${XDG_STATE_HOME:-~/.local/state}/agent-lcars/sessions/<role>.json
```

Override it with `--state-file <path>` when another test harness needs a known
location. Its containing directory must already be private (`0700`), or the
tool refuses to write without changing the caller-owned directory's
permissions. Keep that location outside the repository; `.auth/` is ignored
only as a last defensive layer, not an invitation to put credentials in the
tree.

## Secret Manager (`--storage secret`)

The optional `secret` backend stores base64-encoded storage state as a new
version of an existing secret in project `agent-lcars`:

| Role    | Default secret                    |
| ------- | --------------------------------- |
| `admin` | `AGENT_LCARS_ADMIN_STORAGE_STATE` |
| `user`  | `AGENT_LCARS_USER_STORAGE_STATE`  |

Use `--project` or `--secret-name` only for an intentionally provisioned
alternative. Capture needs permission to add a version; reuse needs
secret-version access. The scripts never create the container or its grants;
if either is missing, stop for the maintainer.
