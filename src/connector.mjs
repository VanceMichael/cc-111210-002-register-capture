import { get } from './http.mjs';
export function decodeWord(words, { signed = false, scale = 1 } = {}) {
  if (words.length !== 1 || !Number.isInteger(words[0]) || words[0] < 0 || words[0] > 65535) throw new Error('寄存器字无效');
  return (signed && words[0] >= 32768 ? words[0] - 65536 : words[0]) * scale;
}
export async function inspect(base, options = {}) {
  return (await get(base, `/read?station=${options.station ?? 1}&area=holding&start=0&count=4`)).json();
}
