import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMapping, planGroups } from '../src/mapping.mjs';
import { decodePoint, decodeGroup, mergeSegmentWords } from '../src/decoder.mjs';

const baseMapping = {
  version: 'map-1', maxWords: 4, forbidden: [[6, 7]],
  points: [
    { name: 'frame', station: 1, area: 'holding', address: 0, words: 1 },
    { name: 'weight', station: 1, area: 'holding', address: 1, words: 2, type: 'float32', wordOrder: 'BA', byteOrder: 'BE' },
    { name: 'job', station: 1, area: 'holding', address: 3, words: 1 },
    { name: 'active', station: 1, area: 'holding', address: 4, words: 1, mask: 1 },
    { name: 'alarm', station: 1, area: 'holding', address: 4, words: 1, mask: 2 },
    { name: 'temperature', station: 1, area: 'holding', address: 8, words: 1, signed: true, scale: 0.1 },
  ],
};

test('规划：同区合并成组，禁读空洞和最大字数强制拆段', () => {
  const plan = planGroups(validateMapping(baseMapping));
  assert.equal(plan.groups.length, 2);
  const [first, second] = plan.groups;
  assert.deepEqual(first.pointNames, ['frame', 'weight', 'job', 'active', 'alarm']);
  assert.equal(first.segments.length, 2);
  assert.deepEqual(first.segments.map(s => [s.start, s.count]), [[0, 4], [4, 1]]);
  assert.equal(first.frameBefore.role, 'frame-before');
  assert.equal(first.frameAfter.start, 0);
  assert.deepEqual([second.start, second.end, second.segments[0].start, second.segments[0].count], [8, 9, 8, 1]);
});

test('规划：不同站号或区域不能合并', () => {
  const mapping = {
    version: 'v', maxWords: 8,
    points: [
      { name: 'a', station: 1, area: 'holding', address: 0, words: 1 },
      { name: 'b', station: 2, area: 'holding', address: 1, words: 1 },
      { name: 'c', station: 1, area: 'input', address: 2, words: 1 },
    ],
  };
  const groups = planGroups(validateMapping(mapping)).groups;
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => group.segments.length === 1));
});

test('规划：禁读空洞强制拆成两个组，读段都不穿越空洞', () => {
  const mapping = {
    version: 'v', maxWords: 4, forbidden: [[6, 7]],
    points: [
      { name: 'a', station: 1, area: 'holding', address: 5, words: 1 },
      { name: 'b', station: 1, area: 'holding', address: 8, words: 1 },
    ],
  };
  const groups = planGroups(validateMapping(mapping)).groups;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].segments.map(s => [s.start, s.count]), [[5, 1]]);
  assert.deepEqual(groups[1].segments.map(s => [s.start, s.count]), [[8, 1]]);
});

test('坏映射在加载阶段被拒绝，不会进入运行期', () => {
  const bad = [
    { ...baseMapping, version: '' },
    { ...baseMapping, maxWords: 0 },
    { ...baseMapping, points: baseMapping.points.map(p => p.name === 'weight' ? { ...p, wordOrder: 'ZZ' } : p) },
    { ...baseMapping, points: baseMapping.points.map(p => p.name === 'weight' ? { ...p, words: 1 } : p) },
    { ...baseMapping, points: baseMapping.points.map(p => p.name === 'active' ? { ...p, mask: 70000 } : p) },
    { ...baseMapping, points: baseMapping.points.map(p => p.name === 'job' ? { ...p, address: 6 } : p) },
    { ...baseMapping, forbidden: [[6, 7], [7, 8]] },
    { ...baseMapping, points: [...baseMapping.points, { ...baseMapping.points[0], name: 'frame' }] },
  ];
  for (const mapping of bad) assert.throws(() => validateMapping(mapping), /映射无效/);
});

test('解码：字序字节序、位字段、符号与缩放都由映射决定', () => {
  const points = validateMapping(baseMapping).points;
  const floatPoint = points.find(point => point.name === 'weight');
  // BA + BE：物理高字在后，寄存器序 0x0000,0x4148 -> 字节 41 48 00 00 = 12.5
  assert.equal(decodePoint(floatPoint, [0x0000, 0x4148]), 12.5);
  // AB + BE：物理高字在前，寄存器序 0x4148,0x0000
  assert.equal(decodePoint({ ...floatPoint, wordOrder: 'AB' }, [0x4148, 0x0000]), 12.5);
  // AB + LE：每字内部字节翻转，寄存器序 0x4841,0x0000
  assert.equal(decodePoint({ ...floatPoint, wordOrder: 'AB', byteOrder: 'LE' }, [0x4841, 0x0000]), 12.5);
  assert.equal(decodePoint(points.find(point => point.name === 'active'), [3]), 1);
  assert.equal(decodePoint(points.find(point => point.name === 'alarm'), [3]), 2);
  assert.equal(decodePoint(points.find(point => point.name === 'temperature'), [65526]), -1);
  assert.throws(() => decodePoint(points.find(point => point.name === 'temperature'), [65536]), /解码失败/);
});

test('组解码保留每个测点的原始字，共享寄存器各取各位', () => {
  const plan = planGroups(validateMapping(baseMapping));
  const group = plan.groups[0];
  const merged = mergeSegmentWords(group, [
    { start: 0, words: [9, 0, 0x4148, 101] },
    { start: 4, words: [3] },
  ]);
  const decoded = decodeGroup(group, merged);
  assert.deepEqual(decoded.find(p => p.name === 'active').rawWords, [3]);
  assert.equal(decoded.find(p => p.name === 'active').value, 1);
  assert.equal(decoded.find(p => p.name === 'alarm').value, 2);
  assert.equal(decoded.find(p => p.name === 'weight').value, 12.5);
  assert.deepEqual(decoded.find(p => p.name === 'weight').rawWords, [0, 0x4148]);
  assert.throws(() => mergeSegmentWords(group, [{ start: 0, words: [9, 0, 0x4148, 101] }]), /没有覆盖/);
});
