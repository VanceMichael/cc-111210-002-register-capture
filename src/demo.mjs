import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });

  // 既有能力：单段寄存器查看并留存。
  const single = await fetch(service.url + '/receive?key=demo');
  const singleReceipt = await single.json();

  // 新能力：查看请求规划，再执行一次成组一致采样。
  const plan = await (await fetch(service.url + '/plan')).json();
  const grouped = await (await fetch(service.url + '/collect/once', { method: 'POST' })).json();
  const status = await (await fetch(service.url + '/collect/status')).json();

  console.log(JSON.stringify({
    source: source.url,
    singleInspectStatus: single.status,
    singleReceipt,
    groupPlan: plan,
    groupedCycle: {
      count: grouped.count,
      records: grouped.records,
    },
    collectorStatus: {
      mappingVersion: status.mappingVersion,
      stats: status.stats,
    },
  }, null, 2));
  if (!single.ok || grouped.count === 0) process.exitCode = 1;
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
