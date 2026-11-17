# 航次记录接收器

Node.js 本地数据接入项目。既有一次来源读取、结构化导入与操作查询保持可用；新增船岸同步接收与核对能力：按航次（voyageId）与原始序号（sequence）识别记录，先校验 HMAC-SHA256 来源签名再计入有效日志，弱网重传/补传不重复计数，并为监管查询区分待补缺口、来源声明无记录区间与验证未通过内容。来源服务和业务存储独立，来源变化不会自动刷新本地集合，需要显式执行同步。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行全部行为与本地接口测试；`npm run demo` 启动临时来源，演示首批导入、同步、重放、损坏副本与补传核对，结束时自动关闭监听并清理临时数据；`npm run acceptance` 在临时目录中验证完整生命周期。

- `npm start -- ingest [文件]`：从 `fixtures/records.json` 导入既有业务集合；
- `npm start -- query [来源]`：读取本地 `var/records.json`；
- `npm start -- sync <航次> [来源URL]`：从回环来源同步一个航次的 manifest 与全部日志页，输出接收计数与核对摘要；
- `npm start -- status <航次>`：输出该航次的监管核对视图（缺口、无记录区间、验证失败、有效日志与来路）；
- `npm start -- voyages`：列出本地已有同步状态的航次。

环境变量：`VOYAGE_STATE_PATH`（同步状态文件，默认 `var/sync-state.json`）、`VOYAGE_RECORDS_PATH`（既有集合，默认 `var/records.json`）、`VOYAGE_SOURCE_URL`（sync 的默认来源地址）、`VOYAGE_SIGNING_KEY`（覆盖演练签名密钥）。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取场景 JSON 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析日志页与 manifest 并保留原始来源属性；`src/verify.js` 实现契约规定的 HMAC-SHA256 签名校验；`src/sync-state.js` 是纯函数状态机，按 voyageId+sequence 维护条目、来路与核对推导；`src/sync-repository.js` 负责同步状态的原子持久化；`src/sync-service.js` 编排分页拉取、验证、落盘与核对；`src/operations.js` 同时提供既有业务读取入口与 `readReconciliation` 监管核对入口。来源协议见 [CONTRACT.md](CONTRACT.md)。

同步状态与既有业务集合分开存储，扩展不改变现有 CLI 和集合查询能力。设备时间（deviceTime）与接收时间（receivedAt）都不参与记录身份：有效日志按原始序号排序，重放只增加 replayCount 与 provenance，同序号不同有效负载标记为冲突并保留两个版本的来路，验证未通过的内容保留在条目中直至有效补传到达。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。

`npm start` 或 `npm start -- --help` 查看命令。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、业务查询以及同步核对的完整流程，完成后清理临时状态。
