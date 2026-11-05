# Repository jobs

`frontend-performance-quality` measures, investigates and fixes Console
performance and quality issues every Tuesday at 14:00 UTC. Sprinkles owns a
separate job covering its three frontends every Monday at 14:00 UTC. Both use
the existing cron scheduler. The recipe retains evidence and uses the normal
protected PR path.

See [repository-owned jobs](../../docs/repository-jobs.md#configuration-and-operation)
for the resource contract and activation: jobs merged here activate
automatically; an operator disable is a sticky veto.

`skill-evals` scores this repository's agent skills every Sunday (see
`.lcars/jobs/skill-evals/job.yaml` for the time) with `repo-skill-evals` and
keeps the report and per-skill result as artifacts; it changes nothing.
