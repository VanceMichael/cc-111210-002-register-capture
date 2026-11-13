import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'group-service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  return { directory, fixture, service };
}

async function teardown({ directory, fixture, service }) {
  await service.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}

test('请求规划接口展示分组、帧检查与拆段，单段查看命令仍然保留', async () => {
  const ctx = await setup();
  try {
    const plan = await (await fetch(ctx.service.url + '/plan')).json();
    assert.equal(plan.version, 'map-1');
    assert.equal(plan.groups.length, 2);
    const first = plan.groups[0];
    assert.deepEqual(first.frameCheck, { station: 1, area: 'holding', start: 0, count: 1, role: 'frame-before' });
    assert.ok(first.requests.every(segment => segment.count <= 4));
    assert.ok(!first.requests.some(segment => segment.start < 6 && segment.start + segment.count > 6));

    const inspect = await (await fetch(ctx.service.url + '/inspect?station=1&area=holding&start=0&count=4')).json();
    assert.equal(inspect.words.length, 4);
  } finally { await teardown(ctx); }
});

test('单次成组采集落盘，记录可追溯映射版本与原始字', async () => {
  const ctx = await setup();
  try {
    const once = await (await fetch(ctx.service.url + '/collect/once', { method: 'POST' })).json();
    assert.equal(once.count, 2);
    assert.ok(once.records.every(record => record.mappingVersion === 'map-1'));
    const list = await (await fetch(ctx.service.url + '/records')).json();
    assert.equal(list.ids.length, 2);
    const envelope = await (await fetch(ctx.service.url + '/records/' + encodeURIComponent(list.ids[0]))).json();
    assert.equal(envelope.record.mappingVersion, 'map-1');
    assert.ok(Array.isArray(envelope.record.rawSegments));
  } finally { await teardown(ctx); }
});

test('坏映射通过接口被拒绝且不影响当前映射', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(ctx.service.url + '/mapping', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '' }),
    });
    assert.equal(response.status, 400);
    const status = await (await fetch(ctx.service.url + '/collect/status')).json();
    assert.equal(status.mappingVersion, 'map-1');
  } finally { await teardown(ctx); }
});

test('映射热切换经刷新接口暂存，并在下一周期组边界生效', async () => {
  const ctx = await setup();
  try {
    await fetch(ctx.fixture.url + '/control?mapping=next');
    const refreshed = await (await fetch(ctx.service.url + '/mapping/refresh')).json();
    assert.equal(refreshed.version, 'map-2');
    assert.equal(refreshed.staged, true);
    const before = await (await fetch(ctx.service.url + '/collect/status')).json();
    assert.equal(before.mappingVersion, 'map-1');
    assert.equal(before.stagedMappingVersion, 'map-2');
    await fetch(ctx.service.url + '/collect/once', { method: 'POST' });
    const after = await (await fetch(ctx.service.url + '/collect/status')).json();
    assert.equal(after.mappingVersion, 'map-2');
  } finally { await teardown(ctx); }
});

test('站点离线不阻断其他站点的采集周期', async () => {
  const ctx = await setup();
  try {
    const mappingWithOfflineStation = {
      // 版本号与来源响应一致，避免触发映射漂移保护。
      version: 'map-1', maxWords: 4, forbidden: [[6, 7]],
      points: [
        { name: 'frame', station: 1, area: 'holding', address: 0, words: 1 },
        { name: 'job', station: 1, area: 'holding', address: 3, words: 1 },
        { name: 'remote', station: 2, area: 'holding', address: 0, words: 1 },
      ],
    };
    const applied = await (await fetch(ctx.service.url + '/mapping', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mappingWithOfflineStation),
    })).json();
    assert.equal(applied.staged, true);
    const once = await (await fetch(ctx.service.url + '/collect/once', { method: 'POST' })).json();
    const qualities = once.records.map(record => record.quality).sort();
    assert.deepEqual(qualities, ['ok', 'ok', 'station-offline']);
  } finally { await teardown(ctx); }
});

test('启停接口与健康检查反映采集状态', async () => {
  const ctx = await setup();
  try {
    const started = await (await fetch(ctx.service.url + '/collect/start?interval=500', { method: 'POST' })).json();
    assert.equal(started.intervalMs, 500);
    assert.equal((await (await fetch(ctx.service.url + '/health')).json()).collector, 'running');
    await fetch(ctx.service.url + '/collect/stop', { method: 'POST' });
    const status = await (await fetch(ctx.service.url + '/collect/status')).json();
    assert.equal(status.running, false);
  } finally { await teardown(ctx); }
});
