// PR64-01 closure test (node:test + Node built-ins only).
// Red on base: stage-target.mjs does not exist before the per-target closures land.
// Green on HEAD: every target's staging plan excludes foreign packages, keeps its own
// runtime, and the Dockerfile keeps every protected value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(HERE, 'fixtures', 'closure', 'repo');

const stager = await import(join(HERE, 'stage-target.mjs'));

const target = (name) => stager.planClosure({ repoRoot: FIXTURE, target: name });

test('cli plan: only the cli-host workspace, every foreign package excluded', () => {
  const plan = target('cli');
  assert.deepEqual(plan.workspaces, ['packages/cli-host']);
  for (const foreign of [
    'apps/api', 'apps/worker', 'apps/web', 'packages/db',
    '@temporalio', 'pdfjs-dist', '@napi-rs/canvas',
  ]) {
    assert.ok(plan.excludes.includes(foreign), `cli plan must exclude ${foreign}`);
  }
  assert.ok(plan.keeps.includes('node-pty'), 'cli keeps node-pty');
  assert.ok(plan.keeps.includes('@space/cli-host'), 'cli keeps @space/cli-host');
  for (const f of plan.files) {
    if (f.from === 'agent-skills') return;
  }
  assert.fail('cli plan must stage agent-skills');
});

test('browser plan: api browser-host closure without cli-host, node-pty or temporal', () => {
  const plan = target('browser');
  assert.deepEqual(plan.workspaces, ['apps/api']);
  for (const foreign of [
    '@space/cli-host', 'node-pty', 'packages/cli-host',
    '@temporalio', 'apps/worker', 'packages/db',
  ]) {
    assert.ok(plan.excludes.includes(foreign), `browser plan must exclude ${foreign}`);
  }
  assert.ok(!plan.workspaces.includes('apps/web'), 'browser carries no web tree at all');
});

test('core plan: api, worker, web, db and the startup-required cli-host stay', () => {
  const plan = target('core');
  for (const ws of ['apps/api', 'apps/worker', 'apps/web', 'packages/cli-host', 'packages/db']) {
    assert.ok(plan.workspaces.includes(ws), `core keeps ${ws}`);
  }
  // apps/web is dist-only in the install list: its 22 client packages never run server-side.
  assert.ok(!plan.installWorkspaces.includes('apps/web'), 'core must not install apps/web client deps');
  for (const ws of ['apps/api', 'apps/worker', 'packages/cli-host', 'packages/db']) {
    assert.ok(plan.installWorkspaces.includes(ws), `core installs ${ws}`);
  }
  assert.ok(plan.keeps.includes('node-pty'), 'core keeps node-pty (api loads it at startup)');
  assert.ok(plan.keeps.includes('@temporalio'), 'core keeps the temporal worker stack');
  assert.ok(plan.keeps.includes('agent-skills'), 'core keeps agent-skills');
});

test('staged tree for cli contains no foreign workspace directory', () => {
  const out = mkdtempSync(join(tmpdir(), 'closure-out-cli-'));
  try {
    const manifest = stager.stageClosure({ repoRoot: FIXTURE, target: 'cli', outDir: out });
    assert.ok(existsSync(join(out, 'package.json')));
    assert.ok(existsSync(join(out, 'package-lock.json')));
    assert.ok(existsSync(join(out, 'packages/cli-host/dist/main.js')));
    assert.ok(!existsSync(join(out, 'apps')), 'cli staging must not carry apps/');
    assert.ok(!existsSync(join(out, 'packages/contracts')), 'cli staging must not carry unneeded workspaces');
    assert.equal(manifest.target, 'cli');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('per-target closures exclude foreign packages', () => {
  const cli = target('cli');
  for (const foreign of ['@temporalio', 'pdfjs-dist', '@napi-rs/canvas']) {
    assert.ok(cli.excludes.includes(foreign), `cli excludes ${foreign}`);
  }
  for (const ws of ['apps/api', 'apps/web', 'apps/worker']) {
    assert.ok(!cli.workspaces.includes(ws), `cli carries no ${ws}`);
  }
  const browser = target('browser');
  for (const foreign of ['@temporalio', 'node-pty', 'packages/cli-host']) {
    assert.ok(browser.excludes.includes(foreign), `browser excludes ${foreign}`);
  }
  for (const ws of ['apps/web', 'apps/worker']) {
    assert.ok(!browser.workspaces.includes(ws), `browser carries no ${ws}`);
  }
  const core = target('core');
  for (const keep of ['node-pty', '@space/cli-host', '@temporalio']) {
    assert.ok(core.keeps.includes(keep), `core keeps ${keep} (and with it @temporalio/worker)`);
  }
  assert.ok(!core.excludes.includes('node-pty') && !core.excludes.includes('@space/cli-host'), 'core keeps the startup stack');
});

test('Dockerfile keeps every protected value while the closures land', () => {
  const df = readFileSync(join(REPO, 'Dockerfile'), 'utf8');
  const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  const stages = new Set();
  for (const f of froms) {
    if (f.includes('@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82')) continue;
    if (!f.includes(':') && !f.includes('/')) { stages.add(f); continue; }
    assert.fail(`unpinned external base image: ${f}`);
  }
  assert.ok(stages.has('runtime-base'), 'runtime-base stage kept');
  assert.ok(df.includes('brace-expansion@5.0.12'), 'npm self-patch block kept');
  assert.ok(df.includes('npm@${NPM_VERSION}'), 'npm version pin kept');
  assert.ok(df.includes('ripgrep'), 'runtime tool line kept');
  assert.ok(df.includes('apt-get upgrade -y'), 'apt-get upgrade kept');
  assert.ok(df.includes('--gid 10001') && df.includes('--uid 10001'), 'uid/gid 10001 kept');
  assert.ok(df.includes('HEALTHCHECK'), 'HEALTHCHECK kept');
  assert.ok(df.includes('EXPOSE 4911'), 'EXPOSE 4911 kept');
  assert.ok(df.includes('@opencode/cli@2.0.32'), 'OpenCode 2.0.32 kept');
  assert.ok(df.includes('chromium') && df.includes('fonts-liberation'), 'chromium stack kept');
  assert.ok(df.includes('/staging/browser/node_modules/@temporalio'), 'browser strips the temporal stack after install');
  assert.ok(df.match(/install-workspaces\.txt/g)?.length >= 2, 'core and browser install only their install workspaces');
  assert.ok(df.includes('python3-minimal'), 'python3-minimal kept');
  assert.ok(df.includes("-name '*musl*'"), 'foreign-platform (musl/darwin/win32) package strip kept');
  assert.ok(df.includes("node_modules/@opencode -mindepth 1 -maxdepth 1 -type d -name '*musl*' -exec rm -rf {} +"), 'cli strips the musl builds of the OpenCode binary');
  assert.ok(df.includes("case \"$TARGETARCH\""), 'cross-arch native strip keyed on TARGETARCH');
  assert.ok(df.includes('/opt/spaceapp/starter-memory'), 'core installs starter-memory at /opt/spaceapp');
  assert.ok(df.includes('"$tree/node_modules/@types/node"'), 'strip removes @types/node from staged trees');
  assert.ok(df.includes('node-pty/build/Makefile'), 'node-pty build leftovers stripped');
  assert.ok(df.includes('node_modules/@space'), 'broken workspace links swept');
  for (const entry of ['core-entrypoint.sh', 'browser-entrypoint.sh', 'cli-entrypoint.sh']) {
    assert.ok(df.includes(entry), `entrypoint kept: ${entry}`);
  }
});
