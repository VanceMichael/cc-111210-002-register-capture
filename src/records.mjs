// 成组采样记录持久化：每条记录携带确切映射版本与原始字，摘要自校验。
import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkId(id) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('记录标识无效');
}

export class RecordStore {
  constructor(directory) { this.directory = directory; }

  async save(record) {
    checkId(record.id);
    await mkdir(this.directory, { recursive: true });
    const payload = JSON.stringify(record);
    const envelope = { id: record.id, digest: digest(payload), record };
    const path = join(this.directory, record.id + '.json');
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(envelope, null, 2), { flag: 'wx' });
    await rename(temporary, path);
    return envelope;
  }

  async read(id) {
    checkId(id);
    const envelope = JSON.parse(await readFile(join(this.directory, id + '.json'), 'utf8'));
    if (digest(JSON.stringify(envelope.record)) !== envelope.digest) throw new Error('记录校验失败');
    return envelope;
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5))
      .sort();
  }
}
