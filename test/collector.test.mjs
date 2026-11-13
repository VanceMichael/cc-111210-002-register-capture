import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from '../src/http.mjs';
import { GroupCollector } from '../src/collector.mjs';
import { startFixture } from '../fixtures/source.mjs';

const mapping = {
  version: 'map-1', maxWords: 4, forbidden: [[6, 7]],
  points: [
    { name: 'frame', station: 1, area: 'holding', address: 0, words: 1 },
    { name: 'weight', station: 1, area: 'holding', address: 1, words: 2, type: 'float32', wordOrder: 'BA', byteOrder: 'BE' },
    { name: 'job', station: 1, area: 'holding', address: 3, words: 1 },
    { name: 'temperature', station: 1, area: 'holding', address: 8, words: 1, signed: true, scale: 0.1 },
    { name: 'remote', station: 2, area: 'holding', address: 0, words: 1 },
  ],
};

// 可编程的假网关：可控制每帧帧号、离线站点和读请求计数。
// flipAfter：在第 N 次成功读之后翻转帧号（一次性），用于模拟设备恰好在一组采样中途换帧。
async function startFakeGateway({ frame = 9, flipEvery = null, flipAfter = null, offlineStations = new Set() } = {}) {
  let readCount = 0;
  let currentFrame = frame;
  return listen(async url => {
    if (url.pathname === '/mapping') return { body: mapping };
    if (url.pathname !== '/read') return { status: 404, body: {} };
    const station = Number(url.searchParams.get('station'));
    const start = Number(url.searchParams.get('start'));
    const count = Number(url.searchParams.get('count'));
    if (offlineStations.has(station)) return { status: 503, body: { error: '站点离线' } };
    readCount += 1;
    if (flipEvery !== null && readCount % flipEvery === 0) currentFrame += 1;
    if (flipAfter !== null && readCount === flipAfter) currentFrame += 1;
    const registers = [currentFrame, 0, 0x4148, 101, 3, 0, 0, 0, 65526, 0];
    return { body: { station, area: 'holding', start, words: registers.slice(start, start + count), mapping: 'map-1' } };
  });
}

async function withCollector(gatewayUrl, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'collector-'));
  const collector = await GroupCollector.create({ base: gatewayUrl, directory, maxFrameRetries: 2, ...options });
  if (options.initialMapping !== null) collector.applyMapping(options.initialMapping ?? mapping);
  return { collector, directory, cleanup: async () => await rm(directory, { recursive: true, force: true }) };
}

test('成组采样：帧号一致时一次通过，记录带映射版本和原始字', async () => {
  const gateway = await startFakeGateway({ frame: 11 });
  const { collector, directory, cleanup } = await withCollector(gateway.url);
  try {
    const records = await collector.runCycleOnce();
    assert.equal(records.length, 3);
    const groupRecord = records.find(r => r.pointNames.includes('weight'));
    assert.equal(groupRecord.quality, 'ok');
    assert.equal(groupRecord.mappingVersion, 'map-1');
    assert.deepEqual(groupRecord.frame, { before: 11, after: 11, consistent: true, retries: 0 });
    const weight = groupRecord.points.find(p => p.name === 'weight');
    assert.equal(weight.value, 12.5);
    assert.deepEqual(weight.rawWords, [0, 0x4148]);
    const envelope = JSON.parse(await readFile(join(directory, groupRecord.id + '.json'), 'utf8'));
    assert.equal(envelope.record.rawSegments[0].words[0], 11);
    assert.equal((await collector.readRecord(groupRecord.id)).id, envelope.id);
    assert.ok((await collector.listRecords()).includes(groupRecord.id));
  } finally { await collector.stop(); await gateway.close(); await cleanup(); }
});

test('换帧：组在有限次重试后成功，且重试只发生在该组', async () => {
  // 第一组要读 5 次（帧前、两段、帧后），在第 2 次读后换帧 -> 首轮帧号不一致；
  // 第二次尝试期间设备稳定 -> 帧号一致通过，后续组不受影响。
  const gateway = await startFakeGateway({ frame: 5, flipAfter: 2 });
  const { collector, cleanup } = await withCollector(gateway.url);
  try {
    const records = await collector.runCycleOnce();
    const first = records.find(r => r.groupId === 'g1');
    assert.equal(first.quality, 'ok');
    assert.equal(first.frame.retries, 1);
    assert.equal(first.attempts.length, 2);
    assert.equal(records.find(r => r.groupId === 'g2').frame.retries, 0);
  } finally { await gateway.close(); await cleanup(); }
});

test('换帧耗尽：输出 frame-mismatch 质量标志，不给数值也不补旧值', async () => {
  // 每两次读翻转一次帧号，帧前读与帧后读必然不同，重试也不会成功。
  const flipping = await startFakeGateway({ frame: 3, flipEvery: 2 });
  const directory = await mkdtemp(join(tmpdir(), 'collector-fail-'));
  try {
    const collector = await GroupCollector.create({ base: flipping.url, directory, maxFrameRetries: 1 });
    collector.applyMapping(mapping);
    const records = await collector.runCycleOnce();
    const failed = records.find(r => r.groupId === 'g1');
    assert.equal(failed.quality, 'frame-mismatch');
    assert.equal(failed.points, null);
    assert.match(failed.error, /帧号/);
    assert.equal(failed.frame.consistent, false);
    assert.ok(failed.rawSegments.length > 0);
  } finally { await flipping.close(); await rm(directory, { recursive: true, force: true }); }
});

test('部分站点离线：该组标记 station-offline，其他站点继续采', async () => {
  const gateway = await startFakeGateway({ offlineStations: new Set([2]) });
  const { collector, cleanup } = await withCollector(gateway.url);
  try {
    const records = await collector.runCycleOnce();
    const offline = records.find(r => r.station === 2);
    assert.equal(offline.quality, 'station-offline');
    assert.equal(offline.points, null);
    assert.equal(records.find(r => r.station === 1 && r.groupId === 'g1').quality, 'ok');
    assert.equal(collector.status().stats.groupsByQuality['station-offline'], 1);
  } finally { await gateway.close(); await cleanup(); }
});

test('映射热切换在组边界生效，旧组留存旧版本、新组带新版本', async () => {
  const gateway = await startFakeGateway({ frame: 4 });
  const { collector, cleanup } = await withCollector(gateway.url);
  try {
    const map2 = { ...mapping, version: 'map-2', points: mapping.points.filter(p => p.name !== 'remote') };
    collector.applyMapping(map2);
    assert.equal(collector.status().stagedMappingVersion, 'map-2');
    // 手动驱动：先完成 map-1 的一个组，再让边界切换发生。
    const plan1 = collector.plan;
    const record = await collector.sampleGroup(plan1.groups[0], { cycle: 1 });
    assert.equal(record.mappingVersion, 'map-1');
    const swap = collector.swapAtBoundary();
    assert.deepEqual(swap, { swapped: true, previous: 'map-1', version: 'map-2' });
    const record2 = await collector.sampleGroup(collector.plan.groups[0], { cycle: 1 });
    assert.equal(record2.mappingVersion, 'map-2');
    assert.notEqual(record.id, record2.id);
  } finally { await gateway.close(); await cleanup(); }
});

test('热切换必须落在组边界：采样中途暂存映射不会污染当前组', async () => {
  const gateway = await startFakeGateway();
  const { collector, cleanup } = await withCollector(gateway.url);
  try {
    const planBefore = collector.plan;
    collector.applyMapping({ ...mapping, version: 'map-3' });
    assert.equal(collector.plan, planBefore);
    assert.throws(() => collector.applyMapping({ ...mapping, version: '' }), /映射无效/);
    assert.equal(collector.plan.version, 'map-1');
  } finally { await gateway.close(); await cleanup(); }
});

test('响应映射代号漂移时输出 mapping-drift，不按旧映射强行解码', async () => {
  const gateway = await startFakeGateway();
  const { collector, cleanup } = await withCollector(gateway.url);
  const driftGateway = await listen(async url => {
    if (url.pathname === '/mapping') return { body: mapping };
    const response = await fetch(new URL(url.pathname + url.search, gateway.url));
    const body = await response.json();
    return { body: { ...body, mapping: 'map-9' } };
  });
  try {
    collector.base = driftGateway.url;
    const record = await collector.sampleGroup(collector.plan.groups[0], { cycle: 1 });
    assert.equal(record.quality, 'mapping-drift');
    assert.equal(record.points, null);
    assert.deepEqual(record.observedMappings, ['map-9']);
  } finally { await driftGateway.close(); await gateway.close(); await cleanup(); }
});

test('停止与重启：未完成组被日志定性为中断，重启后整组重采', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'journal-'));
  const gateway = await startFakeGateway({ frame: 6 });
  try {
    const collector = await GroupCollector.create({ base: gateway.url, directory, maxFrameRetries: 2 });
    collector.applyMapping(mapping);
    const plan = collector.plan;
    collector.cycle = 1;
    await collector.journal.beginCycle({ runId: collector.runId, cycle: 1, mappingVersion: 'map-1', groupIds: plan.groups.map(g => g.id) });
    const first = await collector.sampleGroup(plan.groups[0], { cycle: 1 });
    await collector.records.save(first);
    await collector.journal.markGroup(plan.groups[0].id, 'done');
    // 模拟进程被杀死：不写完成标记，直接丢弃实例。
    const restarted = await GroupCollector.create({ base: gateway.url, directory, maxFrameRetries: 2 });
    assert.equal(restarted.recovery.recovered, true);
    assert.deepEqual(restarted.recovery.unfinishedGroups, ['g2', 'g3']);
    assert.equal(restarted.journal.snapshot().lastCycles[0].outcome, 'interrupted');
    restarted.applyMapping(mapping);
    const records = await restarted.runCycleOnce();
    assert.equal(records.length, 3);
    assert.ok(records.every(record => record.frame.consistent));
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true }); }
});

test('停止信号：周期内优雅停止，已落盘组保留，未开始的组不产生半成品', async () => {
  const gateway = await startFakeGateway();
  const directory = await mkdtemp(join(tmpdir(), 'stop-'));
  try {
    const collector = await GroupCollector.create({ base: gateway.url, directory });
    collector.applyMapping(mapping);
    // 第一组落盘后立即请求停止，第二组尚未开始。
    collector.onRecord = () => { collector.stopping = true; };
    const records = await collector.runCycleOnce();
    assert.equal(records.length, 1);
    assert.equal(records[0].quality, 'ok');
    assert.equal(collector.journal.snapshot().lastCycles[0].outcome, 'stopped');
    assert.deepEqual(collector.journal.snapshot().lastCycles[0].unfinishedGroups, ['g2', 'g3']);
    assert.deepEqual(await collector.listRecords(), [records[0].id]);
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true }); }
});

test('真实演练源端到端：规划请求合法且温度按映射解码', async () => {
  const fixture = await startFixture();
  const raw = await (await fetch(fixture.url + '/mapping')).json();
  const { collector, cleanup } = await withCollector(fixture.url, { initialMapping: null });
  try {
    collector.applyMapping(raw);
    const records = await collector.runCycleOnce();
    assert.equal(records.length, 2);
    const temperatureGroup = records.find(r => r.pointNames.includes('temperature'));
    assert.equal(temperatureGroup.points.find(p => p.name === 'temperature').value, -1);
    assert.equal(temperatureGroup.quality, 'ok');
    // 每条记录都能追溯到映射版本、内容摘要和完整原始字。
    assert.ok(records.every(r => r.mappingVersion === 'map-1' && r.mappingDigest && r.rawSegments.length > 0));
  } finally { await fixture.close(); await cleanup(); }
});
