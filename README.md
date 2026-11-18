# 航次记录接收器

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。当前导入以 sourceId 保存最新观察；历史版本、完整批次、身份决策及恢复流程尚未纳入接入生命周期。

在此之上提供船岸同步接收与核对：按航次及原始序号识别记录，校验来源签名后才计入有效日志，弱网重传、补传按重放处理不重复计数，核对结论随每次同步重算并保留来路。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源、读取首批、同步两个来源观察并展示业务查询与核对视图，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作。同步与核对使用：

- `npm start -- sync <来源url> [航次]`：从回环来源拉取该航次 manifest 与全部分页日志，逐条校验签名后更新本地同步状态（`var/sync-state.json`），并把验证通过的记录投影进业务集合；航次缺省为 V-17。
- `npm start -- reconcile [航次]`：输出该航次当前核对视图，分清待补缺口、来源声明无记录的区间与验证未通过的内容。

`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放与业务查询，以及同步接收、重传去重、验证未通过隔离、补传后判断更新，完成后清理临时状态。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

同步与核对由独立模块组成，状态另行组织，不影响既有集合：

- `src/verify.js` 按契约对 `[voyageId,sequence,kind,deviceTime,value]` 做 HMAC-SHA256 校验；结构残缺、签名格式不符、摘要不一致都视为验证未通过。
- `src/sync.js` 是同步服务：先拉 manifest 再沿 next 拉完全部分页，按 (voyageId, sequence) 识别记录。同一副本重传只累计接收次数与来路，不按到达时间当成新记录；同一序号出现不同的有效内容时保留首次验证通过的记录并登记冲突。单次同步要么完整落盘要么不改动状态，弱网中断后重试即可。
- `src/sync-store.js` 把各航次的 manifest（含历史版本）、有效记录、验证未通过的内容、冲突及各自来路（来源路径、ETag、首末次接收时间、次数）持久化到 `var/sync-state.json`。
- `src/reconcile.js` 从同步状态计算核对视图：逐序号给出 verified / no-record / rejected / pending 互斥状态，输出待补缺口与声明无记录区间的压缩区间、验证未通过内容清单（含原始内容与来路）以及有效记录的接收轨迹。每次补传后重算，判断跟着更新。
- 验证通过的记录投影进业务集合（与首批导入共用一个映射，sourceId 一致），`readOperations(repository, syncStore)` 附带各航次核对视图；验证未通过的内容不进入业务集合。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。
