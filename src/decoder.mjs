// 按映射解码原始 16 位字。符号、缩放、字节序与字序完全由映射决定。

function fail(message) { throw new Error('解码失败：' + message); }

export function decodePoint(point, words) {
  if (!Array.isArray(words) || words.length !== point.words || words.some(w => !Number.isInteger(w) || w < 0 || w > 65535)) {
    fail(`测点 ${point.name} 的原始字数量或取值不合法`);
  }
  if (point.type === 'float32') {
    const ordered = point.wordOrder === 'BA' ? [words[1], words[0]] : [words[0], words[1]];
    const bytes = point.byteOrder === 'BE'
      ? [ordered[0] >> 8, ordered[0] & 255, ordered[1] >> 8, ordered[1] & 255]
      : [ordered[0] & 255, ordered[0] >> 8, ordered[1] & 255, ordered[1] >> 8];
    const value = Buffer.from(bytes).readFloatBE(0);
    if (!Number.isFinite(value)) fail(`测点 ${point.name} 解出非有限浮点`);
    return value;
  }

  let raw = words[0];
  if (point.mask !== null) raw &= point.mask;
  let value = point.signed && raw >= 32768 ? raw - 65536 : raw;
  value *= point.scale;
  return value;
}

// 从一组合并后的寄存器跨度中截取每个测点对应的原始字。
export function decodeGroup(group, merged) {
  return group.points.map(point => {
    const offset = point.address - group.start;
    const rawWords = merged.slice(offset, offset + point.words);
    const value = decodePoint(point, rawWords);
    return { name: point.name, value, rawWords };
  });
}

export function mergeSegmentWords(group, segmentResults) {
  const merged = new Array(group.end - group.start).fill(null);
  for (const result of segmentResults) {
    const offset = result.start - group.start;
    for (let index = 0; index < result.words.length; index += 1) merged[offset + index] = result.words[index];
  }
  if (merged.some(word => word === null)) fail(`组 ${group.id} 的读段没有覆盖完整寄存器跨度`);
  return merged;
}
