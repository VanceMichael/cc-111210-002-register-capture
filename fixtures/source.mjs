import { listen } from '../src/http.mjs';
export const mapping = { version: 'map-1', maxWords: 4, forbidden: [[6, 7]], points: [
  { name: 'frame', station: 1, area: 'holding', address: 0, words: 1 },
  { name: 'weight', station: 1, area: 'holding', address: 1, words: 2, type: 'float32', wordOrder: 'BA', byteOrder: 'BE' },
  { name: 'job', station: 1, area: 'holding', address: 3, words: 1 },
  { name: 'active', station: 1, area: 'holding', address: 4, words: 1, mask: 1 },
  { name: 'alarm', station: 1, area: 'holding', address: 4, words: 1, mask: 2 },
  { name: 'temperature', station: 1, area: 'holding', address: 8, words: 1, signed: true, scale: 0.1 },
] };
export async function startFixture() {
  let frame = 7; let change = false; let version = 1;
  return listen(async url => {
    if (url.pathname === '/mapping') return { body: { ...mapping, version: 'map-' + version } };
    if (url.pathname === '/control') { change = url.searchParams.get('change') === 'true'; version += url.searchParams.has('mapping') ? 1 : 0; return { body: { frame, version } }; }
    if (url.pathname !== '/read') return { status: 404, body: {} };
    const station = Number(url.searchParams.get('station')); const start = Number(url.searchParams.get('start')); const count = Number(url.searchParams.get('count'));
    if (station === 2) return { status: 503, body: { error: '站点离线' } };
    if (url.searchParams.get('area') !== 'holding' || !Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || count > 4 || start + count > 10 || (start <= 7 && start + count > 6)) throw new Error('非法读区间');
    const registers = [frame, 0, 0x4148, 101, 3, 0, 0, 0, 65526, 0];
    const words = registers.slice(start, start + count);
    if (change) { frame++; change = false; }
    return { body: { station, area: 'holding', start, words, mapping: 'map-' + version } };
  });
}
