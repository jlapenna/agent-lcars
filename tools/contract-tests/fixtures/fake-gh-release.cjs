#!/usr/bin/env node
// A stand-in for the `gh` calls the workstation CLI publisher makes. It keeps
// one release in a JSON file, changes it the way GitHub does, and records
// every call, so a test can run the workflow's own script and read both what
// it asked for and what it left behind.
//
// State (FAKE_GH_STATE):
//   release   null, or { body, draft, assets: [{ id, name }] }
//   sums      content of the published SHA256SUMS asset
//   compare   answer to a compare call's `.status`
//   jobs      the CI run's jobs, [{ name, conclusion }]
//   fail      names of calls that fail: 'read', 'compare', 'jobs', 'rename',
//             'upload:<name>' (the upload fails, after --clobber deleted),
//             or 'before-upload:<name>' (stopped before the command ran)
//   nextId    next asset id
// Calls are appended to FAKE_GH_LOG, one line each.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
fs.appendFileSync(
  process.env.FAKE_GH_LOG,
  `${args.join(' ').replace(/\n/g, ' ')}\n`,
);

function die(message) {
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
}
const failing = (name) => (state.fail ?? []).includes(name);
/** The value after a flag, removing both from `list`. */
function take(list, ...names) {
  const index = list.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  return list.splice(index, 2)[1];
}
function respond(value, jq) {
  if (!jq) return process.stdout.write(`${JSON.stringify(value)}\n`);
  const result = spawnSync('jq', ['-r', jq], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
  if (result.status !== 0) die(`jq failed: ${result.stderr}`);
  process.stdout.write(result.stdout);
}
const released = () => state.release ?? die('release not found');

if (args[0] === 'api') {
  const rest = args.slice(1);
  const method = take(rest, '--method', '-X') ?? 'GET';
  const jq = take(rest, '--jq', '-q');
  const field = take(rest, '-f');
  const silent = rest.includes('--silent');
  const route = rest.find((arg) => !arg.startsWith('-'));

  if (/\/releases\/tags\/workstation-cli$/.test(route) && method === 'GET') {
    if (failing('read')) die('Service Unavailable (HTTP 503)');
    // GitHub does not find a draft by its tag.
    if (!state.release || state.release.draft) die('Not Found (HTTP 404)');
    if (!silent) respond(state.release, jq);
  } else if (/\/actions\/runs\/\d+\/jobs/.test(route)) {
    if (failing('jobs')) die('Service Unavailable (HTTP 503)');
    respond({ jobs: state.jobs ?? [] }, jq);
  } else if (/\/compare\//.test(route)) {
    if (failing('compare')) die('Not Found (HTTP 404)');
    respond({ status: state.compare }, jq);
  } else if (/\/releases\/assets\/\d+$/.test(route)) {
    const id = Number(route.split('/').pop());
    const asset = released().assets.find((entry) => entry.id === id);
    if (!asset) die('Not Found (HTTP 404)');
    if (method === 'DELETE') {
      state.release.assets = state.release.assets.filter(
        (entry) => entry !== asset,
      );
    } else if (method === 'PATCH') {
      if (failing('rename')) die('Service Unavailable (HTTP 503)');
      const name = field.replace(/^name=/, '');
      if (state.release.assets.some((entry) => entry.name === name))
        die('Validation Failed (HTTP 422)');
      asset.name = name;
    } else die(`unexpected method ${method}`);
    save();
  } else die(`unexpected api route ${route}`);
} else if (args[0] === 'release') {
  const [, verb, tag, ...rest] = args;
  if (tag !== 'workstation-cli') die(`unexpected tag ${tag}`);
  if (verb === 'create') {
    if (state.release) die('a release with the same tag name already exists');
    const notes = take(rest, '--notes');
    take(rest, '--target');
    take(rest, '--title');
    const files = rest.filter((arg) => !arg.startsWith('-'));
    // With assets, the real command leaves a draft until they are uploaded.
    state.release = { body: notes, draft: files.length > 0, assets: [] };
  } else if (verb === 'edit') {
    released().body = take(rest, '--notes') ?? state.release.body;
    if (rest.includes('--draft=false')) state.release.draft = false;
  } else if (verb === 'upload') {
    const file = rest.find((arg) => !arg.startsWith('-'));
    const name = path.basename(file);
    // The job stopped before this command ran at all.
    if (failing(`before-upload:${name}`)) die('interrupted');
    const existing = released().assets.find((entry) => entry.name === name);
    if (existing && !rest.includes('--clobber')) die('asset already exists');
    // --clobber deletes first: a failed upload loses what was there.
    state.release.assets = state.release.assets.filter(
      (entry) => entry !== existing,
    );
    if (failing(`upload:${name}`)) {
      save();
      die('upload failed');
    }
    state.release.assets.push({ id: state.nextId++, name });
    if (name === 'SHA256SUMS') state.sums = fs.readFileSync(file, 'utf8');
  } else if (verb === 'download') {
    const dir = take(rest, '--dir');
    if (take(rest, '--pattern') !== 'SHA256SUMS') die('unexpected pattern');
    if (!released().assets.some((entry) => entry.name === 'SHA256SUMS'))
      die('no assets match the file pattern');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), state.sums);
  } else die(`unexpected release command ${verb}`);
  save();
} else die(`unexpected command ${args[0]}`);
