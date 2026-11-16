export const schema = Object.freeze({
  "product": "航次记录接收器",
  "entity": "航行记录",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "电子航海日志的船岸同步采集"
});
