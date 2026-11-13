import { startService } from './service.mjs';
import { startFixture } from '../fixtures/source.mjs';

const fixture = process.env.SOURCE_URL ? { url: process.env.SOURCE_URL, close: async () => {} } : await startFixture();
const service = await startService({
  source: fixture.url,
  directory: process.env.DATA_DIR ?? '/tmp/capture-receipts',
  port: Number(process.env.PORT ?? 3000),
  autoStart: process.env.AUTO_START === '1',
  intervalMs: Number(process.env.INTERVAL_MS ?? 2000),
  maxFrameRetries: Number(process.env.MAX_FRAME_RETRIES ?? 2),
});
console.log(JSON.stringify({ service: service.url, source: fixture.url, mapping: service.collector.plan?.version ?? null }));

const close = async () => { await service.close(); await fixture.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
