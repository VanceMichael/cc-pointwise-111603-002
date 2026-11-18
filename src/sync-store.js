import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 同步状态独立于业务集合持久化：按航次保存 manifest、有效记录、
// 验证未通过的内容、冲突副本及各自的来路。
export class SyncStore {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !value.voyages || typeof value.voyages !== 'object' || Array.isArray(value.voyages)) {
        throw new Error('sync state file has no voyages object');
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { voyages: {} };
      throw error;
    }
  }

  async write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
