# CI control flags

`<LANE>_ENABLED` protects a normal verification lane: missing means enabled and
an emergency disables it with `false`. `<ACTION>_ARMED` permits an external
effect: missing means disarmed and it is enabled only with `true`.

Every engaged flag must use the shared `control-flag` action so the skipped
lane, owner-visible notice, summary, and exact restore command appear on every
affected run. A skipped required check is intentional control-flag semantics.

Names and steady-state values are declared in `config/github-variables.json`.
Runner-selection variables are retired except `AGENT_RUNNER_LABEL`, which is a
shared workflow input rather than an operational switch.
