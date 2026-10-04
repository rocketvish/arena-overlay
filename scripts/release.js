#!/usr/bin/env node
/**
 * release.js — build, publish and verify a GitHub release in one step.
 *
 *   npm run release                         # leaves the release as a draft to review
 *   npm run release -- --notes notes.md     # also publishes it (marks Latest)
 *
 * Why the draft is created up front: electron-builder runs two GitHub
 * publisher instances (installer and blockmap). When no release exists yet,
 * each creates its own, leaving two drafts with the files split between them.
 * With a draft already there, both upload into it (see electron-publish's
 * getOrCreateRelease).
 *
 * Requires the GitHub CLI (`gh auth login`).
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const { owner, repo } = pkg.build.publish;
const tag = `v${pkg.version}`;

const args = process.argv.slice(2);
const notesFile = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null;

const sh = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf-8', ...opts }).trim();
const run = (cmd, cmdArgs, env = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed`);
};
const gh = (...a) => sh('gh', a);
const step = (s) => console.log(`\n▶ ${s}`);

function releasesForTag() {
  return JSON.parse(gh('api', `repos/${owner}/${repo}/releases`, '--paginate'))
    .filter((r) => r.tag_name === tag);
}

function main() {
  step(`Checks for ${tag}`);
  if (sh('git', ['status', '--porcelain'])) throw new Error('Working tree has uncommitted changes — commit first.');
  const head = sh('git', ['rev-parse', 'HEAD']);
  if (sh('git', ['rev-parse', 'origin/master']) !== head) throw new Error('HEAD is not pushed to origin/master — push first.');
  const existing = releasesForTag();
  if (existing.some((r) => !r.draft)) throw new Error(`${tag} is already published — bump the version.`);
  for (const r of existing.slice(1)) gh('api', '-X', 'DELETE', `repos/${owner}/${repo}/releases/${r.id}`); // leftovers

  step('Tests');
  run('npm', ['test']);

  step('Renderer build');
  run('npm', ['run', 'build']);

  step('Draft release (before electron-builder, so both publishers share it)');
  if (!releasesForTag().length) {
    gh('release', 'create', tag, '--draft', '--target', head, '--title', tag, '--notes', 'Draft — notes to follow.');
  }

  step('Package and upload');
  run('npx', ['electron-builder', '--win', '--publish=always'], {
    GH_TOKEN: process.env.GH_TOKEN || gh('auth', 'token'),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });

  step('Verify');
  const rels = releasesForTag();
  if (rels.length !== 1) throw new Error(`expected exactly one ${tag} release, found ${rels.length}`);
  const rel = rels[0];
  const names = rel.assets.map((a) => a.name).sort();
  const exeName = `Arena-Overlay-Setup-${pkg.version}.exe`;
  for (const want of [exeName, `${exeName}.blockmap`, 'latest.yml']) {
    if (!names.includes(want)) throw new Error(`release is missing ${want} (has: ${names.join(', ')})`);
  }
  const outDir = path.join(root, pkg.build.directories.output);
  const latest = fs.readFileSync(path.join(outDir, 'latest.yml'), 'utf-8');
  const want = latest.match(/^sha512: (.+)$/m)[1].trim();
  const localExe = path.join(outDir, `${pkg.build.productName} Setup ${pkg.version}.exe`);
  const got = crypto.createHash('sha512').update(fs.readFileSync(localExe)).digest('base64');
  if (got !== want) throw new Error('local installer does not match latest.yml');
  const uploaded = rel.assets.find((a) => a.name === exeName);
  if (uploaded.size !== fs.statSync(localExe).size) throw new Error('uploaded installer size differs from local build');
  console.log(`  one release, ${names.length} assets, installer checksum matches latest.yml`);

  if (!notesFile) {
    console.log(`\nDraft ready: ${rel.html_url}\nPublish with: npm run release -- --notes <file>   (or edit it on GitHub)`);
    return;
  }
  step('Publish');
  gh('api', '-X', 'PATCH', `repos/${owner}/${repo}/releases/${rel.id}`,
    '-f', `tag_name=${tag}`, '-f', `target_commitish=${head}`,
    '-F', `body=@${path.resolve(notesFile)}`, '-F', 'draft=false', '-f', 'make_latest=true');
  const firstLine = fs.readFileSync(notesFile, 'utf-8').match(/^#\s+(.+)$/m)?.[1];
  if (firstLine) gh('api', '-X', 'PATCH', `repos/${owner}/${repo}/releases/${rel.id}`, '-f', `name=${firstLine}`);
  console.log(`  published ${tag}: ${rel.html_url.replace('/untagged-', '/tag/')}`);
}

try {
  main();
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
}
