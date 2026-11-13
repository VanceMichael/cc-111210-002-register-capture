// 网关读客户端：只允许本地演练地址，错误携带可判定的状态码。
import { get as httpGet } from './http.mjs';

export class GatewayError extends Error {
  constructor(message, { status = null, station = null, area = null, start = null, count = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.station = station;
    this.area = area;
    this.start = start;
    this.count = count;
  }
  get stationOffline() { return this.status === 503; }
}

export async function fetchMapping(base) {
  const response = await httpGet(base, '/mapping');
  return response.json();
}

export async function readSegment(base, { station, area, start, count, role = 'data' }) {
  let response;
  try {
    response = await httpGet(base, `/read?station=${station}&area=${encodeURIComponent(area)}&start=${start}&count=${count}`, { throwOnError: false });
  } catch (error) {
    throw new GatewayError(`读请求失败（${error.message}）`, { station, area, start, count });
  }
  if (!response.ok) {
    throw new GatewayError(`来源返回 ${response.status}`, { status: response.status, station, area, start, count });
  }
  const body = await response.json();
  if (body.station !== station || body.area !== area || body.start !== start || !Array.isArray(body.words) || body.words.length !== count) {
    throw new GatewayError('来源响应与请求区间不一致', { status: response.status, station, area, start, count });
  }
  if (body.words.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) {
    throw new GatewayError('来源返回了非法寄存器字', { status: response.status, station, area, start, count });
  }
  return { role, station, area, start, count, words: body.words, mapping: body.mapping ?? null };
}
