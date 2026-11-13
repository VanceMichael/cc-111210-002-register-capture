import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { GroupCollector } from './collector.mjs';
import { fetchMapping } from './gateway.mjs';

export async function startService({ source, directory, port = 0, autoStart = false, intervalMs = 2000, maxFrameRetries = 2 }) {
  const store = new ReceiptStore(directory);
  const collector = await GroupCollector.create({ base: source, directory, maxFrameRetries });
  try {
    collector.applyMapping(await fetchMapping(source));
  } catch (error) {
    // 来源暂时不可用时服务仍可启动，映射可稍后通过 /mapping/refresh 拉取。
  }
  if (autoStart && collector.plan) collector.start(intervalMs);

  const service = await listen(async (url, request) => {
    if (url.pathname === '/health') {
      return { body: { state: 'ready', collector: collector.status().running ? 'running' : 'idle' } };
    }

    // 现场核对保留：单段寄存器查看，不经过成组规划。
    if (url.pathname === '/inspect') {
      return { body: await inspect(source, Object.fromEntries(url.searchParams)) };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      return { body: await store.save(key, await inspect(source, Object.fromEntries(url.searchParams))) };
    }
    if (url.pathname.startsWith('/receipts/')) {
      return { body: await store.read(url.pathname.split('/').pop()) };
    }

    if (url.pathname === '/mapping' && request.method === 'GET') {
      if (!collector.plan) return { status: 409, body: { error: '映射尚未加载' } };
      return { body: { mapping: collector.mapping, plan: collector.plan, staged: collector.staged?.version ?? null } };
    }

    // 请求规划：组、帧前后读、拆段结果。
    if (url.pathname === '/plan') {
      if (!collector.plan) return { status: 409, body: { error: '映射尚未加载' } };
      return {
        body: {
          version: collector.plan.version,
          groups: collector.plan.groups.map(group => ({
            id: group.id, station: group.station, area: group.area,
            span: [group.start, group.end - 1], points: group.pointNames,
            frameCheck: group.frameBefore,
            requests: group.segments,
          })),
        },
      };
    }

    if (url.pathname === '/mapping/refresh') {
      return { body: await collector.refreshMapping() };
    }

    if (url.pathname === '/mapping' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(request)); }
      catch { throw new Error('请求体必须是合法 JSON 映射'); }
      return { body: collector.applyMapping(body) };
    }

    if (url.pathname === '/collect/status') return { body: collector.status() };

    if (url.pathname === '/collect/start' && request.method === 'POST') {
      const interval = Number(url.searchParams.get('interval') ?? intervalMs);
      if (!Number.isInteger(interval) || interval < 100) throw new Error('采样间隔必须是不小于 100ms 的整数');
      return { body: collector.start(interval) };
    }
    if (url.pathname === '/collect/stop' && request.method === 'POST') {
      await collector.stop();
      return { body: { stopped: true, status: collector.status() } };
    }
    if (url.pathname === '/collect/once' && request.method === 'POST') {
      const records = await collector.runCycleOnce();
      return { body: { count: records.length, records: records.map(summarize) } };
    }

    if (url.pathname === '/records') return { body: { ids: await collector.listRecords() } };
    if (url.pathname.startsWith('/records/')) {
      return { body: await collector.readRecord(decodeURIComponent(url.pathname.split('/').pop())) };
    }

    return { status: 404, body: { error: '接口不存在' } };
  }, port);

  return {
    ...service,
    collector,
    close: async () => { await collector.stop(); await service.close(); },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function summarize(record) {
  return {
    id: record.id, groupId: record.groupId, station: record.station,
    mappingVersion: record.mappingVersion, quality: record.quality,
    frame: record.frame, points: record.points?.map(point => ({ name: point.name, value: point.value })) ?? null,
    error: record.error,
  };
}
