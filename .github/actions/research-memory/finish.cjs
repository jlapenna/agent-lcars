const fs = require('node:fs');
const path = require('node:path');

const group = process.env.STATE_group;
if (!group) throw new Error('The job memory measurement did not initialize.');
const read = (name) => fs.readFileSync(path.join(group, name), 'utf8').trim();
const limit = read('memory.max');
if (limit !== process.env.STATE_limit)
  throw new Error('Runner memory limit changed.');
const peak = Number(read('memory.peak'));
if (!Number.isSafeInteger(peak) || peak <= 0)
  throw new Error('Invalid memory peak.');
console.log(
  'CI_MEMORY ' +
    JSON.stringify({
      schema: 1,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB,
      source: process.env.GITHUB_SHA,
      runner: process.env.RUNNER_NAME,
      peak_bytes: peak,
      limit_bytes: Number(limit),
      cpu_max: read('cpu.max'),
      memory_events: read('memory.events'),
      measured_at: new Date().toISOString(),
    }),
);
