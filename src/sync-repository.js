import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSyncState, fromSerializable, toSerializable } from './sync-state.js';

// 同步状态独立于既有业务集合（var/records.json），不改变现有 CLI 与查询能力。
export class SyncRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      return fromSerializable(value);
    } catch (error) {
      if (error.code === 'ENOENT') return createSyncState();
      throw error;
    }
  }

  async write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(toSerializable(state), null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
