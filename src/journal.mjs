// 采集运行日志：原子写入，重启时把未完成周期定性为中断，杜绝半成品数据被当成有效记录。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Journal {
  constructor(directory, clock = () => Date.now()) {
    this.directory = join(directory, '.journal');
    this.path = join(this.directory, 'state.json');
    this.clock = clock;
    this.state = { activeCycle: null, history: [] };
  }

  async load(historyLimit = 20) {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.state = { activeCycle: raw.activeCycle ?? null, history: Array.isArray(raw.history) ? raw.history : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { activeCycle: null, history: [] };
      return { recovered: false };
    }
    let recovery = { recovered: false };
    if (this.state.activeCycle) {
      const interrupted = this.state.activeCycle;
      recovery = {
        recovered: true,
        runId: interrupted.runId,
        cycle: interrupted.cycle,
        mappingVersion: interrupted.mappingVersion,
        unfinishedGroups: interrupted.groups.filter(group => group.state !== 'done').map(group => group.id),
      };
      this.state.history.unshift({
        runId: interrupted.runId,
        cycle: interrupted.cycle,
        mappingVersion: interrupted.mappingVersion,
        startedAt: interrupted.startedAt,
        interruptedAt: this.clock(),
        outcome: 'interrupted',
        unfinishedGroups: recovery.unfinishedGroups,
      });
      this.state.history = this.state.history.slice(0, historyLimit);
      this.state.activeCycle = null;
      await this.persist();
    }
    return recovery;
  }

  async beginCycle({ runId, cycle, mappingVersion, groupIds }) {
    this.state.activeCycle = {
      runId, cycle, mappingVersion,
      startedAt: this.clock(),
      groups: groupIds.map(id => ({ id, state: 'pending' })),
    };
    await this.persist();
  }

  // 组边界热切换：新映射下未采的组回到待处理，已完成组的身份保留在 doneGroups。
  async switchPlan(mappingVersion, groupIds, doneGroups) {
    if (!this.state.activeCycle) return;
    const done = new Set(doneGroups);
    this.state.activeCycle.mappingVersion = mappingVersion;
    this.state.activeCycle.groups = groupIds.map(id => ({ id, state: done.has(id) ? 'done' : 'pending' }));
    await this.persist();
  }

  async markGroup(groupId, groupState) {
    if (!this.state.activeCycle) return;
    const entry = this.state.activeCycle.groups.find(group => group.id === groupId);
    if (entry) { entry.state = groupState; await this.persist(); }
  }

  async endCycle(outcome, extra = {}) {
    if (!this.state.activeCycle) return null;
    const finished = {
      ...this.state.activeCycle,
      finishedAt: this.clock(),
      outcome,
      ...extra,
    };
    this.state.history.unshift(finished);
    this.state.history = this.state.history.slice(0, 20);
    this.state.activeCycle = null;
    await this.persist();
    return finished;
  }

  async persist() {
    await mkdir(this.directory, { recursive: true });
    const temporary = this.path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx' });
    await rename(temporary, this.path);
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      activeCycle: this.state.activeCycle,
      lastCycles: this.state.history.slice(0, 5),
    }));
  }
}
