#!/usr/bin/env node
// Install agent skills that ship inside pinned npm devDependencies into
// .agents/skills (the copies are gitignored). package.json pins each package
// and Renovate bumps it, so the installed skill always matches the lockfile
// without a vendored copy or a symlink that dangles before install. Runs from
// postinstall. When a package is missing from node_modules (for example a
// production install without devDependencies), its stale copy is removed.
//
// modern-web-guidance's skill text, guides and CLI output tell agents to run
// `npx -y modern-web-guidance@latest`, which would bypass the lockfile and
// its release-age policy. The CLI is bundled in the skill and needs only
// Node built-ins, so every invocation is rewritten to run the installed copy
// with telemetry off (skipping the upstream installer also skips its
// telemetry notice), and the npx/pnpx runner guidance is replaced. The copy
// is staged and checked first: an unpinned reference fails the install and
// leaves no copy behind.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, '.agents', 'skills');

const CLI_PACKAGE = 'modern-web-guidance';
const CLI_SKILL = 'modern-web-guidance';
const LOCAL_CLI = `DISABLE_TELEMETRY=1 node .agents/skills/${CLI_SKILL}/modern-web.mjs`;
const VERSION = String.raw`@(?:latest|next|v?\d[\w.-]*)`;
const RUNNER = String.raw`(?:(?:npx(?:\.cmd)?|pnpx|bunx)(?: --offline)?(?: -y)? |(?:pnpm|yarn) dlx |pnpm exec )`;
// A runner-prefixed call (versioned or not, as in the CLI's own output) or a
// bare versioned package reference. Marketplace names such as
// `modern-web-guidance@googlechrome` are not versions and stay as they are.
const RUNNER_INVOCATION = new RegExp(
  String.raw`(?:DISABLE_TELEMETRY=1 )?(?:${RUNNER}${CLI_PACKAGE}(?:${VERSION})?|${CLI_PACKAGE}${VERSION})`,
  'g',
);
const SKILL_RUNNER_PROSE = /directly with `npx`/g;
const SKILL_RUNNER_MENTION = /\b(?:npx|pnpx|bunx|dlx)\b/;
const UNPINNED = new RegExp(
  String.raw`${CLI_PACKAGE}${VERSION}|\b(?:npx|pnpx|bunx|dlx)\b[^\n]{0,60}\b${CLI_PACKAGE}\b`,
);
const RUNNER_SECTION = /^## Using npx \/ pnpx\n[\s\S]*?(?=^## )/m;
const LOCAL_RUNNER_SECTION = `## Running the CLI

- Run the CLI bundled with this skill from the repository root:
  \`${LOCAL_CLI} <command>\`. The repository's postinstall installs it from
  the lockfile-pinned \`${CLI_PACKAGE}\` devDependency; Renovate updates it.
- Do not fetch it with a package runner, which would bypass the pin. Search
  and retrieval read the bundled guides, so no network access is needed.

`;

/** Skills to install: [npm package, skill directory under its skills/]. */
const SKILLS = [[CLI_PACKAGE, CLI_SKILL]];

function textFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(file));
    else if (!fs.readFileSync(file).includes(0)) out.push(file);
  }
  return out;
}

function pinCli(dir) {
  for (const file of textFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    let next = text.replace(RUNNER_INVOCATION, LOCAL_CLI);
    const isSkill = path.basename(file) === 'SKILL.md';
    if (isSkill) {
      next = next
        .replace(RUNNER_SECTION, LOCAL_RUNNER_SECTION)
        .replace(SKILL_RUNNER_PROSE, 'with the bundled CLI');
    }
    if (next !== text) fs.writeFileSync(file, next);
    const match =
      next.match(UNPINNED) || (isSkill && next.match(SKILL_RUNNER_MENTION));
    if (match) {
      throw new Error(
        `unpinned ${CLI_PACKAGE} runner remains in ${path.relative(dir, file)}: ${match[0]}`,
      );
    }
  }
}

function syncSkills() {
  fs.mkdirSync(skillsDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(skillsDir, '.sync-'));
  try {
    // Stage and validate every skill before exposing any of them.
    const staged = [];
    for (const [pkg, skill] of SKILLS) {
      const src = path.join(root, 'node_modules', pkg, 'skills', skill);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
        staged.push([skill, null]); // package absent: drop any stale copy
        continue;
      }
      const copy = path.join(stage, skill);
      fs.cpSync(src, copy, { recursive: true, dereference: true });
      pinCli(copy);
      staged.push([skill, copy]);
    }
    for (const [skill, copy] of staged) {
      const dest = path.join(skillsDir, skill);
      fs.rmSync(dest, { recursive: true, force: true });
      if (copy) fs.renameSync(copy, dest);
    }
  } catch (error) {
    for (const [, skill] of SKILLS) {
      fs.rmSync(path.join(skillsDir, skill), { recursive: true, force: true });
    }
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  syncSkills();
} catch (error) {
  console.error(`sync-package-skills: ${error.message}; skills not installed`);
  process.exit(1);
}
