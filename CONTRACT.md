# 来源与消费契约

## 来源

入口 `/voyages/<voyageId>/logs?after=0`，JSON items 为本页项目，next 是后续相对路径或 null，采集端需要逐页拉取直到 next 为 null，并对分页循环/超限做防护。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；`fixtures/sync-source.json` 提供分页、补传、时钟漂移与损坏观察场景；可添加新的来源观察验证行为。

记录身份是 voyageId 与 sequence；deviceTime 是设备时间而非到达顺序，弱网重传、补传与时钟漂移都不能让同一序号被当成新记录。/voyages/<voyageId>/manifest 明确声明 through 范围与 noRecord 序号：出现在 noRecord 中的序号是来源明确声明无记录，未在 manifest 中明确的空缺仍是未知缺口。若声明无记录的序号后来收到验证通过的记录，以验证通过的记录为准。签名使用 HMAC-SHA256，对 JSON.stringify([voyageId,sequence,kind,deviceTime,value]) 的 UTF-8 字节计算十六进制摘要，演练密钥 local-voyage-key（可用环境变量 VOYAGE_SIGNING_KEY 覆盖）；corrupted 来源观察含无效签名，opening 与 updated 含可核验签名。未经验证的设备数据不应被当成已验证日志。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes，既有 CLI 与结构化导入行为保持不变。船岸同步状态独立保存在 `var/sync-state.json`（可用 VOYAGE_STATE_PATH 覆盖），由 `readReconciliation(syncRepository, voyageId)` 输出监管核对视图：

- `gaps`：manifest 范围内既无有效记录、也未声明无记录的待补缺口（区间）；
- `noRecordRanges`：来源 manifest 明确声明无记录的序号区间；
- `verificationFailures`：收到过但签名验证未通过的序号、原因与尝试次数；
- `canonicalLogs`：按原始序号排列的已验证日志，含 replayCount 与每次接收的 provenance（receivedAt/deviceTime/signature/payloadKey）；
- `conflictingSequences`/`outsideManifest`：同序号不同有效负载的冲突，以及超出 manifest through 的记录；
- `complete`：manifest 已观察且不存在待补缺口与验证失败。

补传或新的 manifest 观察后，核对结论由持久化状态重新推导并随之更新；重放只增加来路计数，不新增有效日志，旧副本不会按到达时间被当成新记录。同步先完整拉取 manifest 与全部日志页再统一落盘，拉取失败不破坏既有状态。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
