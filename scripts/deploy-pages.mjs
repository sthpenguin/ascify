#!/usr/bin/env node
/**
 * Publish dist/ to the `gh-pages` branch.
 *
 * This is the no-Actions deployment path. `.github/workflows/deploy.yml` is the
 * preferred route and needs no manual step, but it only works when GitHub
 * Actions can allocate a runner for the repository. When it cannot, Pages can
 * still serve from a branch, and this script is that path.
 *
 * The built output is committed from a scratch directory with its own fresh
 * repository rather than from a branch of this one. That matters: the project
 * .gitignore deliberately blocks `dist/` and `*.png`, so committing the build
 * from here would silently drop every generated icon. A clean tree has no
 * ignore rules to fight.
 *
 *   node scripts/deploy-pages.mjs [--skip-build]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BRANCH = 'gh-pages';
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

const log = (msg) => process.stdout.write(`${msg}\n`);

if (!process.argv.includes('--skip-build')) {
  log('building…');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

if (!existsSync(join(dist, 'index.html'))) {
  process.stderr.write('deploy-pages: dist/index.html is missing — build first\n');
  process.exit(1);
}

const remote = run('git', ['remote', 'get-url', 'origin']);
const sha = run('git', ['rev-parse', '--short', 'HEAD']);
const subject = run('git', ['log', '-1', '--pretty=%s']);
const name = run('git', ['config', 'user.name']);
const email = run('git', ['config', 'user.email']);

const staging = mkdtempSync(join(tmpdir(), 'ascify-pages-'));
try {
  cpSync(dist, staging, { recursive: true });

  // Tells Pages to serve the files as-is instead of running them through
  // Jekyll, which would drop anything beginning with an underscore.
  writeFileSync(join(staging, '.nojekyll'), '');

  run('git', ['init', '-q', '-b', BRANCH], staging);
  run('git', ['config', 'user.name', name], staging);
  run('git', ['config', 'user.email', email], staging);
  run('git', ['add', '-A'], staging);
  run('git', ['commit', '-q', '-m', `deploy: ${sha} ${subject}`], staging);

  log(`pushing ${BRANCH} → ${remote.replace(/\/\/.*@/, '//')}`);
  // Force-push: this branch is build output, not history worth preserving.
  run('git', ['push', '-q', '--force', remote, `${BRANCH}:${BRANCH}`], staging);

  const fileCount = run('git', ['ls-files'], staging).split('\n').length;
  log(`published ${fileCount} files from ${sha}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

log('done — Pages will rebuild from the branch within a minute or so');
