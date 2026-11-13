// 成组一致采样引擎：
// - 同一组的全部读段夹在两次帧号读取之间，帧变化只重采该组；
// - 重采次数耗尽输出质量标志，绝不用旧值顶替；
// - 映射热切换只在组边界生效；
// - 单站故障只标记该组，其他站点继续；
// - 运行日志保证停止/重启后未完成组被定性为中断，重启后整组重采。
import { validateMapping, planGroups } from './mapping.mjs';
import { decodeGroup, mergeSegmentWords } from './decoder.mjs';
import { GatewayError, fetchMapping, readSegment } from './gateway.mjs';
import { RecordStore } from './records.mjs';
import { Journal } from './journal.mjs';
import { randomUUID } from 'node:crypto';

export class StoppedError extends Error {
  constructor() { super('采集已停止'); this.name = 'StoppedError'; }
}

function safeSegment(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_'); }

export class GroupCollector {
  constructor({ base, directory, clock = () => Date.now(), maxFrameRetries = 2, frameRetryDelay = 0, sleep }) {
    this.base = base;
    this.clock = clock;
    this.maxFrameRetries = maxFrameRetries;
    this.frameRetryDelay = frameRetryDelay;
    this.sleep = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.records = new RecordStore(directory);
    this.journal = new Journal(directory, clock);
    this.mapping = null;
    this.plan = null;
    this.staged = null;
    this.stagedMapping = null;
    this.running = false;
    this.stopping = false;
    this.timer = null;
    this.inFlight = null;
    this.runId = randomUUID().replace(/-/g, '').slice(0, 12);
    this.cycle = 0;
    this.recovery = null;
    this.stats = { cycles: 0, records: 0, groupsByQuality: {}, lastCycle: null, lastError: null };
    this.onRecord = null;
  }

  static async create(options) {
    const collector = new GroupCollector(options);
    collector.recovery = await collector.journal.load();
    if (options.mapping !== undefined) collector.applyMapping(options.mapping);
    return collector;
  }

  // 坏映射在加载阶段直接拒绝，当前运行不受影响。
  applyMapping(raw) {
    const mapping = validateMapping(raw);
    const plan = planGroups(mapping);
    this.stagedMapping = mapping;
    this.staged = plan;
    if (this.mapping === null) {
      this.mapping = mapping;
      this.plan = plan;
      this.staged = null;
      this.stagedMapping = null;
    }
    return { version: mapping.version, staged: this.mapping !== mapping, groups: plan.groups.length };
  }

  async refreshMapping() {
    return this.applyMapping(await fetchMapping(this.base));
  }

  hasStagedSwap() { return this.staged !== null && this.stagedMapping.digest !== this.mapping.digest; }

  // 仅允许在组边界调用。
  swapAtBoundary() {
    if (!this.hasStagedSwap()) return { swapped: false, version: this.plan.version };
    const previous = this.plan.version;
    this.mapping = this.stagedMapping;
    this.plan = this.staged;
    this.staged = null;
    this.stagedMapping = null;
    return { swapped: true, previous, version: this.plan.version };
  }

  status() {
    return {
      runId: this.runId,
      running: this.running,
      mappingVersion: this.plan?.version ?? null,
      stagedMappingVersion: this.staged?.version ?? null,
      cycle: this.cycle,
      stats: { ...this.stats, groupsByQuality: { ...this.stats.groupsByQuality } },
      recovery: this.recovery,
      journal: this.journal.snapshot(),
    };
  }

  async sampleGroup(group, context) {
    const attempts = [];
    for (let attempt = 0; attempt <= this.maxFrameRetries; attempt += 1) {
      this.ensureRunning();
      const frameBefore = await readSegment(this.base, group.frameBefore);
      this.ensureRunning();
      const segmentResults = [];
      for (const segment of group.segments) {
        this.ensureRunning();
        segmentResults.push(await readSegment(this.base, segment));
      }
      this.ensureRunning();
      const frameAfter = await readSegment(this.base, group.frameAfter);
      attempts.push({
        attempt,
        frameBefore: frameBefore.words[0],
        frameAfter: frameAfter.words[0],
        segments: segmentResults.map(result => ({ start: result.start, words: result.words })),
        observedMappings: [...new Set([frameBefore, ...segmentResults, frameAfter].map(result => result.mapping).filter(Boolean))],
      });
      if (frameBefore.words[0] === frameAfter.words[0]) {
        return this.buildRecord(group, context, {
          quality: 'ok',
          frame: { before: frameBefore.words[0], after: frameAfter.words[0], consistent: true, retries: attempt },
          attempts,
          segmentResults,
        });
      }
      if (attempt < this.maxFrameRetries && this.frameRetryDelay > 0) await this.sleep(this.frameRetryDelay);
    }
    // 帧变化耗尽重采：只输出质量标志与最后一帧原始字，不给任何数值。
    return this.buildRecord(group, context, {
      quality: 'frame-mismatch',
      frame: { before: attempts.at(-1).frameBefore, after: attempts.at(-1).frameAfter, consistent: false, retries: this.maxFrameRetries },
      attempts,
      segmentResults: null,
      error: `帧号在 ${this.maxFrameRetries + 1} 次采样中均发生变化`,
    });
  }

  ensureRunning() { if (this.stopping) throw new StoppedError(); }

  buildRecord(group, context, outcome) {
    const observedMappings = [...new Set(outcome.attempts.flatMap(attempt => attempt.observedMappings))];
    const drift = observedMappings.some(version => version !== this.plan.version);
    let quality = outcome.quality;
    if (quality === 'ok' && drift) quality = 'mapping-drift';
    const base = {
      id: `${this.runId}-c${context.cycle}-${safeSegment(this.plan.version)}-${group.id}`,
      runId: this.runId,
      cycle: context.cycle,
      groupId: group.id,
      station: group.station,
      area: group.area,
      start: group.start,
      end: group.end,
      pointNames: group.pointNames,
      mappingVersion: this.plan.version,
      mappingDigest: this.mapping.digest,
      observedMappings,
      frame: outcome.frame,
      attempts: outcome.attempts,
      quality,
      capturedAt: this.clock(),
      rawSegments: outcome.attempts.at(-1).segments,
      points: null,
      error: outcome.error ?? null,
    };
    if (quality === 'ok') {
      const merged = mergeSegmentWords(group, outcome.segmentResults);
      base.points = decodeGroup(group, merged);
    }
    return base;
  }

  async runCycleOnce() {
    if (this.plan === null) throw new Error('尚未加载任何映射');
    this.cycle += 1;
    const cycle = this.cycle;
    const doneByVersion = new Map();
    await this.journal.beginCycle({
      runId: this.runId, cycle,
      mappingVersion: this.plan.version,
      groupIds: this.plan.groups.map(group => group.id),
    });
    const records = [];
    try {
      let iterations = 0;
      for (;;) {
        iterations += 1;
        if (iterations > 1000) throw new Error('映射切换次数异常，已中止本周期');
        if (this.hasStagedSwap()) {
          const swap = this.swapAtBoundary();
          doneByVersion.set(swap.previous, doneByVersion.get(swap.previous) ?? new Set());
          await this.journal.switchPlan(
            this.plan.version,
            this.plan.groups.map(group => group.id),
            doneByVersion.get(this.plan.version) ?? new Set(),
          );
        }
        const done = doneByVersion.get(this.plan.version) ?? new Set();
        doneByVersion.set(this.plan.version, done);
        const group = this.plan.groups.find(candidate => !done.has(candidate.id));
        if (!group) break;
        this.ensureRunning();

        let record;
        try {
          record = await this.sampleGroup(group, { cycle });
        } catch (error) {
          if (error instanceof StoppedError) throw error;
          const quality = error instanceof GatewayError && error.stationOffline ? 'station-offline' : 'read-error';
          record = {
            id: `${this.runId}-c${cycle}-${safeSegment(this.plan.version)}-${group.id}`,
            runId: this.runId, cycle, groupId: group.id,
            station: group.station, area: group.area, start: group.start, end: group.end,
            pointNames: group.pointNames, mappingVersion: this.plan.version, mappingDigest: this.mapping.digest,
            observedMappings: [], frame: null, quality, capturedAt: this.clock(),
            rawSegments: [], attempts: [], points: null, error: error.message,
          };
        }
        await this.records.save(record);
        if (this.onRecord) this.onRecord(record);
        this.stats.records += 1;
        this.stats.groupsByQuality[record.quality] = (this.stats.groupsByQuality[record.quality] ?? 0) + 1;
        this.stats.lastError = record.error;
        records.push(record);
        done.add(group.id);
        await this.journal.markGroup(group.id, 'done');
      }
      await this.journal.endCycle('completed', { records: records.map(record => ({ id: record.id, quality: record.quality })) });
      this.stats.cycles += 1;
      this.stats.lastCycle = { cycle, outcome: 'completed', mappingVersion: this.plan.version, groups: records.length };
      return records;
    } catch (error) {
      if (!(error instanceof StoppedError)) this.stats.lastError = error.message;
      const unfinished = this.journal.state.activeCycle?.groups
        .filter(group => group.state !== 'done').map(group => group.id) ?? [];
      await this.journal.endCycle(error instanceof StoppedError ? 'stopped' : 'failed', { unfinishedGroups: unfinished, error: error.message });
      this.stats.lastCycle = { cycle, outcome: error instanceof StoppedError ? 'stopped' : 'failed', unfinishedGroups: unfinished };
      if (!(error instanceof StoppedError)) throw error;
      return records;
    }
  }

  start(intervalMs) {
    if (this.running) throw new Error('采集已在运行');
    if (this.plan === null) throw new Error('尚未加载任何映射');
    this.running = true;
    this.stopping = false;
    const tick = async () => {
      if (!this.running || this.inFlight) return;
      this.inFlight = (async () => {
        try { await this.runCycleOnce(); } catch (error) { this.stats.lastError = error.message; }
        finally { this.inFlight = null; }
      })();
      await this.inFlight;
    };
    this.timer = setInterval(() => { void tick(); }, intervalMs);
    return { runId: this.runId, intervalMs };
  }

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    this.stopping = false;
  }

  async listRecords() { return this.records.list(); }
  async readRecord(id) { return this.records.read(id); }
}
