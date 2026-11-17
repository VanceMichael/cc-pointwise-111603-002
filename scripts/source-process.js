// 测试辅助：在独立子进程中启动来源服务器，避免同步等待的 CLI 测试阻塞服务器事件循环。
import { startSource } from '../source/server.js';

const scenarioUrl = process.argv[2];
if (!scenarioUrl) throw new Error('scenario file URL required');
const source = await startSource(new URL(scenarioUrl));
process.stdout.write(`${source.url}\n`);

async function shutdown() {
  await source.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
