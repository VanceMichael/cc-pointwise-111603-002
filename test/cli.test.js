import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/source-process.js', import.meta.url));
const scenarioUrl = new URL('../fixtures/sync-source.json', import.meta.url).href;

// 来源服务器运行在独立子进程，CLI 子进程的同步等待不会阻塞它的事件循环。
async function startSourceProcess() {
  const child = spawn(process.execPath, [helperPath, scenarioUrl], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('source process did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((value) => value.startsWith('http://'));
      if (line) { clearTimeout(timer); resolve(line.trim()); }
    });
    child.on('exit', (code) => reject(new Error(`source process exited early: ${code}`)));
  });
  return { url, child };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('命令帮助列出全部入口且正常退出', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.deepEqual(help.commands, ['ingest', 'query', 'sync', 'status', 'voyages']);
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = runCli(['invalid-action']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingest, query, sync, status or voyages/);
});

test('sync 与 status 通过命令行完成接收和监管核对', async () => {
  const source = await startSourceProcess();
  const directory = await mkdtemp(join(tmpdir(), 'cli-sync-'));
  try {
    const statePath = join(directory, 'state.json');
    const synced = runCli(['sync', 'V-20', source.url], { VOYAGE_STATE_PATH: statePath });
    assert.equal(synced.status, 0, synced.stderr);
    const summary = JSON.parse(synced.stdout);
    assert.equal(summary.counts.accepted, 2);
    assert.deepEqual(summary.gaps, [{ from: 3, to: 3 }]);

    const status = runCli(['status', 'V-20'], { VOYAGE_STATE_PATH: statePath });
    assert.equal(status.status, 0, status.stderr);
    const view = JSON.parse(status.stdout);
    assert.deepEqual(view.noRecordRanges, [{ from: 2, to: 2 }]);
    assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [1, 4]);

    const voyages = runCli(['voyages'], { VOYAGE_STATE_PATH: statePath });
    assert.deepEqual(JSON.parse(voyages.stdout), ['V-20']);

    const replayed = runCli(['sync', 'V-20', source.url], { VOYAGE_STATE_PATH: statePath });
    const replaySummary = JSON.parse(replayed.stdout);
    assert.equal(replaySummary.counts.accepted, 0);
    assert.equal(replaySummary.counts.replay, 2);
  } finally {
    source.child.kill('SIGTERM');
    await once(source.child, 'exit');
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺少来源地址时 sync 明确报错', () => {
  const result = runCli(['sync', 'V-20'], { VOYAGE_STATE_PATH: join(tmpdir(), 'missing.json') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VOYAGE_SOURCE_URL/);
});
