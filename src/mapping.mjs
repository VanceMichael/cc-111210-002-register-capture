// 映射校验与成组请求规划。
// 所有坏映射在加载阶段直接拒绝，不允许带病进入采样运行期。
import { createHash } from 'node:crypto';

const TYPES = new Set(['uint16', 'int16', 'float32']);
const WORD_ORDERS = new Set(['AB', 'BA']);
const BYTE_ORDERS = new Set(['BE', 'LE']);

function fail(message) { throw new Error('映射无效：' + message); }
function isNonNegativeInt(value) { return Number.isInteger(value) && value >= 0; }

export function validateMapping(raw) {
  if (!raw || typeof raw !== 'object') fail('根节点必须是对象');
  const version = raw.version;
  if (typeof version !== 'string' || version.trim() === '') fail('version 必须是非空字符串');
  if (!Number.isInteger(raw.maxWords) || raw.maxWords < 1) fail('maxWords 必须是正整数');

  const forbidden = [];
  if (raw.forbidden !== undefined) {
    if (!Array.isArray(raw.forbidden)) fail('forbidden 必须是数组');
    for (const hole of raw.forbidden) {
      if (!Array.isArray(hole) || hole.length !== 2 || !hole.every(isNonNegativeInt) || hole[0] > hole[1]) {
        fail('禁读区间必须是 [起始, 结束] 的非负整数对');
      }
      for (const [start, end] of forbidden) {
        if (!(hole[1] < start || hole[0] > end)) fail(`禁读区间 ${hole} 与 ${[start, end]} 重叠`);
      }
      forbidden.push([hole[0], hole[1]]);
    }
    forbidden.sort((a, b) => a[0] - b[0]);
  }

  const frame = { address: 0, ...(raw.frame ?? {}) };
  if (!isNonNegativeInt(frame.address)) fail('帧号地址必须是非负整数');
  if (forbidden.some(([start, end]) => frame.address >= start && frame.address <= end)) {
    fail('帧号地址落在禁读空洞内');
  }

  if (!Array.isArray(raw.points) || raw.points.length === 0) fail('points 必须是非空数组');
  const names = new Set();
  const points = raw.points.map((point) => {
    if (!point || typeof point !== 'object') fail('测点必须是对象');
    const { name, station, area, address, words } = point;
    if (typeof name !== 'string' || name.trim() === '') fail('测点名称必须是非空字符串');
    if (names.has(name)) fail(`测点名称重复：${name}`);
    names.add(name);
    if (!Number.isInteger(station) || station < 1) fail(`测点 ${name} 的 station 必须是正整数`);
    if (typeof area !== 'string' || area.trim() === '') fail(`测点 ${name} 的 area 必须是非空字符串`);
    if (!isNonNegativeInt(address)) fail(`测点 ${name} 的地址必须是非负整数`);
    if (!Number.isInteger(words) || words < 1) fail(`测点 ${name} 的字数必须是正整数`);

    const type = point.type ?? 'uint16';
    if (!TYPES.has(type)) fail(`测点 ${name} 的类型 ${type} 不支持`);
    if (type === 'float32' && words !== 2) fail(`浮点测点 ${name} 必须恰好占两个寄存器`);

    const hasMask = point.mask !== undefined && point.mask !== null;
    const normalized = {
      name, station, area, address, words, type,
      wordOrder: point.wordOrder ?? null,
      byteOrder: point.byteOrder ?? null,
      mask: hasMask ? point.mask : null,
      signed: point.signed ?? (type === 'int16'),
      scale: point.scale ?? 1,
    };
    if (type === 'float32') {
      if (!WORD_ORDERS.has(normalized.wordOrder)) fail(`浮点测点 ${name} 必须声明合法字序 AB/BA`);
      if (!BYTE_ORDERS.has(normalized.byteOrder)) fail(`浮点测点 ${name} 必须声明合法字节序 BE/LE`);
    } else if (normalized.wordOrder !== null || normalized.byteOrder !== null) {
      fail(`测点 ${name} 只有 float32 才能声明字序/字节序`);
    }
    if (normalized.mask !== null) {
      if (words !== 1) fail(`位字段测点 ${name} 必须落在单个寄存器内`);
      if (!Number.isInteger(normalized.mask) || normalized.mask < 1 || normalized.mask > 65535) {
        fail(`测点 ${name} 的位掩码超出 16 位范围`);
      }
    }
    if (typeof normalized.signed !== 'boolean') fail(`测点 ${name} 的 signed 必须是布尔值`);
    if (typeof normalized.scale !== 'number' || !Number.isFinite(normalized.scale)) fail(`测点 ${name} 的缩放必须是有限数`);

    const hit = forbidden.find(([start, end]) => address <= end && address + words - 1 >= start);
    if (hit) fail(`测点 ${name} 的寄存器区间与禁读空洞 ${hit} 相交`);
    return normalized;
  });

  const maxWords = raw.maxWords;
  return Object.freeze({ version, digest: mappingDigest({ version, maxWords, forbidden, frame, points }), maxWords, forbidden, frame, points });
}

// 规范化内容摘要：版本号相同但内容变化的映射也必须被识别为不同映射。
export function mappingDigest(canonical) {
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function touchesForbidden(start, end, forbidden) {
  return forbidden.some(([holeStart, holeEnd]) => start <= holeEnd && end - 1 >= holeStart);
}

// 把测点规划成帧一致组，每组再切成网关允许的读请求段。
export function planGroups(mapping) {
  const validated = mapping.version !== undefined && mapping.points !== undefined ? mapping : validateMapping(mapping);
  const buckets = new Map();
  for (const point of validated.points) {
    const key = `${point.station}\u0000${point.area}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point);
  }

  const groups = [];
  let sequence = 0;
  for (const [, bucketPoints] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...bucketPoints].sort((a, b) => a.address - b.address || a.name.localeCompare(b.name));
    let spans = [];
    let current = null;
    for (const point of sorted) {
      const pointEnd = point.address + point.words;
      if (current === null) {
        current = { station: point.station, area: point.area, start: point.address, end: pointEnd, points: [point] };
      } else {
        const mergedEnd = Math.max(current.end, pointEnd);
        const crossesHole = point.address > current.end
          ? touchesForbidden(current.end, point.address, validated.forbidden)
          : touchesForbidden(current.start, mergedEnd, validated.forbidden);
        if (point.address <= current.end && !crossesHole) {
          current.end = mergedEnd;
          current.points.push(point);
        } else {
          spans.push(current);
          current = { station: point.station, area: point.area, start: point.address, end: pointEnd, points: [point] };
        }
      }
    }
    if (current !== null) spans.push(current);

    for (const span of spans) {
      sequence += 1;
      const segments = [];
      let position = span.start;
      while (position < span.end) {
        let count = Math.min(validated.maxWords, span.end - position);
        for (const [holeStart] of validated.forbidden) {
          if (holeStart > position && holeStart < position + count) count = holeStart - position;
        }
        if (count < 1) fail(`组 ${sequence} 无法绕开禁读空洞`);
        segments.push(Object.freeze({ station: span.station, area: span.area, start: position, count }));
        position += count;
        const hole = validated.forbidden.find(([holeStart, holeEnd]) => holeStart === position);
        if (hole) position = hole[1] + 1;
      }
      groups.push(Object.freeze({
        id: `g${sequence}`,
        station: span.station,
        area: span.area,
        start: span.start,
        end: span.end,
        pointNames: Object.freeze(span.points.map(point => point.name)),
        points: Object.freeze(span.points),
        segments: Object.freeze(segments),
        frameBefore: Object.freeze({ station: span.station, area: span.area, start: validated.frame.address, count: 1, role: 'frame-before' }),
        frameAfter: Object.freeze({ station: span.station, area: span.area, start: validated.frame.address, count: 1, role: 'frame-after' }),
      }));
    }
  }
  return Object.freeze({ version: validated.version, frame: validated.frame, groups: Object.freeze(groups) });
}
