# CI control flags

`<LANE>_ENABLED` protects a normal verification lane: missing means enabled and
an emergency disables it with `false`. `<ACTION>_ARMED` permits an external
effect: missing means disarmed and it is enabled only with `true`.

Every engaged flag must use the shared `control-flag` action so the skipped
lane, owner-visible notice, summary, and exact restore command appear on every
affected run. A skipped required check is intentional control-flag semantics.

Names and steady-state values are declared in `config/github-variables.json`.
Runner selection is fixed by the current QueueExecutor/direct-container route;
no provider runner-label variable is supported.
