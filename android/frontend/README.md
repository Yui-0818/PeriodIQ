# Android/frontend — 移动端前端源码

> **定位**：移动端唯一源码（后续移动 UI 改造在此）。`file://` 直开 `~\Android\frontend\index.html` 必须可用。
> **Win 端**：使用已冻结的 `~\Win\frontend\` 副本（来源 tag `demo_over_2`、版本 3.0.0），不随本目录更新。
> **冻结快照**：`~\前端demo\app拆解版\old2\` 是 B1–B10 的快照，只读；原 demo 收在 `~\前端demo\app拆解版\old1\`（`1cd5082`），不修改。

## 单向归档

```text
开发/修改  → 只改 ~\Android\frontend\
稳定快照   → 镜像到 ~\前端demo\app拆解版（archive: 提交）
```

- 禁止反向把 demo/old2 的改动搬回 `Android\frontend\`。
- old2 不修改；新的修复只在当前 `Android\frontend\`。
- 只有确认稳定后才新增归档快照；不要把未验证的版本覆盖 demo 原内容。

## 目录

```text
Android\frontend\
  index.html          入口；六页 + #pg-auth gate + #app-titlebar 占位
  manifest.json       构建期存在性校验（copy_frontend.py 仅检查文件存在）
  CONTEXT.md          当前技术上下文（模块/页面/接口/契约/缺口）
  css\                base / fonts / today / calendar / history / insights /
                      you / you.data / journal / auth / shell
  js\                 core.js / main.js（装配与启动）
  js\core\            state / transport / hydrate / api.* / errors / i18n /
                      platform / fx / edit / app / mock
  js\i18n\            zh-CN / en / es 词典（i18n.js 的三语数据）
  js\pages\           today(+ring) / calendar(+grid+detail) / history /
                      insights(+chart) / you(+settings+transfer+dialog+scene) /
                      journal / auth
  js\shell\           desktop.js（Win WebView2 窗控桥）
  fonts\              Inter woff2 本地子集
```

## 当前基线

- B1–B10 已完成：Today、Calendar、History、Insights、You/Data、Journal、Auth、Win Shell；W1 桌面系列（W1-1R…W1-5B）已完成，移动端 3.0.0 已冻结。
- 移动端：390×844 / 360×800；`file://`；dark/light；reduce。
- Journal：Calendar header `#jrn` 进入，Today 仅当天可写，过去只读/倒序，300 码点。
- Auth：未登录显示 `#pg-auth` gate；登录/注册/Keep；登出/改密/删号回登录。
- Shell：仅 `body.piq-shell` 下显示 44px 标题栏；无 `piq-shell` 的移动端零影响。

## 验收基线

- 390×844、360×800：无横向溢出、无 console 错误、目标 ≥44px。
- 涉及数据层：额外用真实后端隔离库验证，不能只看 `file://` mock。
- Auth/Journal 的真实后端路径：登录/注册、登出、改密回登录，Journal 300/只读/空态。
- Shell：1024×768 / 800×600（4:3；800 允许纵向滚动、不得横向溢出），标题栏、页名、窗控消息、auth gate 避让。
- 单文件 ≤30KB；已登记超限 `mock.js` 31,182 B、`you.css` 39,776 B、`insights.css` 36,257 B（W1 已验收，不拆分）；禁止 ES module/外链/构建步骤。

## 下一步

移动端后续重构在本目录进行；Win 使用已冻结的 `~\Win\frontend\` 副本；当前缺口见 `~\docs\STATUS.md`。
