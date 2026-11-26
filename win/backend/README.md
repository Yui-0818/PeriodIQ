# backend — FastAPI 后端（Win 端）

| 内容 | 说明 |
|---|---|
| `app\` | 应用源码：`main.py`（入口；`~\Win\frontend\` 冻结副本已入库，目录存在即挂载静态托管）、`routes\`、`db\`、`algo\`（预测算法）、`schemas\`、`services\`、`security.py` |
| `requirements.txt` | 依赖清单（安装见根 `README.md` 的「本机构建环境」） |
| `data\` | 开发态数据目录（运行时自动生成**空库**，不入库）。 |

- 监听只绑 `127.0.0.1`；无任何出站 HTTP 客户端。
- Win 端前端使用已冻结的 `~\Win\frontend\` 副本（来源 tag `demo_over_2`、3.0.0、已入库）；移动端源码在 `~\Android\frontend\`。缺失时启动不阻断，`GET /` 返回占位 JSON。
- 运行方式见 `~\Win\README.md`（推荐经 `~\Win\desktop\entry.py` 启动）。
