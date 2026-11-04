const fs = require('node:fs');
const path = require('node:path');

const relative = fs
  .readFileSync('/proc/self/cgroup', 'utf8')
  .trim()
  .split('::')[1];
const nested = path.join('/sys/fs/cgroup', relative);
const group = fs.existsSync(path.join(nested, 'memory.peak'))
  ? nested
  : '/sys/fs/cgroup';
const limit = fs.readFileSync(path.join(group, 'memory.max'), 'utf8').trim();
const expected = process.env['INPUT_MEMORY-LIMIT-BYTES'];
if (limit !== expected) {
  throw new Error(
    `Measurement cgroup limit ${limit} differs from lane ${expected}`,
  );
}
const members = fs
  .readFileSync(path.join(group, 'cgroup.procs'), 'utf8')
  .trim()
  .split(/\s+/)
  .map(Number);
if (!members.includes(process.pid))
  throw new Error('Measurement is outside this process cgroup.');
fs.appendFileSync(process.env.GITHUB_STATE, `group=${group}\nlimit=${limit}\n`);
console.log(`Registered final-post memory measurement for ${limit}-byte lane.`);
