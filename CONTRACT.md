# 来源与消费契约

## 来源

入口 `/voyages/V-17/logs?after=0`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

记录身份是 voyageId 与 sequence；deviceTime 是设备时间而非到达顺序。/voyages/V-17/manifest 明确声明序号 1..3，其中序号 2 为 no-record；未在 manifest 中明确的空缺仍是未知。签名使用 HMAC-SHA256，对 JSON.stringify([voyageId,sequence,kind,deviceTime,value]) 的 UTF-8 字节计算十六进制摘要，演练密钥 local-voyage-key；corrupted 来源观察含无效签名，opening 与 updated 含可核验签名。未经验证的设备数据不应被当成已验证日志。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
