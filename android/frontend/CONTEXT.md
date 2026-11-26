# Android/frontend — 移动端技术上下文

> 记录当前移动端前端实现与契约。

## 1. 形态与硬约束

- 静态、无构建：`file://` 直开 `android/frontend/index.html` 是验收基线。
- 全部经典 `<script>`；无 `import`/`export`、无 `package.json`、无打包器、无外链资源。
- 页面共享一个全局 `core`；页面工厂返回 `{size,setSY,refresh,...}`。
- 单文件 ≤30KB；已登记超限 `mock.js` 31,182 B、`you.css` 39,776 B、`insights.css` 36,257 B（W1 已验收，不拆分）。
- 移动基线 390×844 / 360×800；dark/light；`prefers-reduced-motion`。
- 禁止直接读写 `JOURNAL`；禁止页面自行推导预测；`[data-layer]` 代码不得重写。

## 2. 模块地图

### core

- `state.js`：内存态、日期、`CYC`/`DAILY`/`JOURNAL`、派生、`_data`。
- `transport.js`：模式判定（file:// 或 `?mock=1` 为 mock，http 为 real）、`BASE=/api/v1`、token、fetch/PIQNative、错误封装。
- `hydrate.js`：启动/写后真实数据装载；Win 平台在 `/health` 之后多拉一次 `GET /device/settings`。
- `api.auth.js`：会话状态机、signOut、401 守卫、`BOOTSTRAP`。
- `api.domain.js`：真实 auth/daily/cycles/predictions/analysis 等；`A._settings` 是设备设置缓存，Win real 的 `A.settings(patch)` 写 `PUT /device/settings`，Android 逐键走 `core.platform.settingsBridge`（原生 HostSettingsBridge 八键）。
- `api.mock.js` / `mock.js`：`file://` 演示数据与同步 provider；mock 恒 authed、login/register 未接线。
- `api.surface.js`：稳定的 `core.api` 表面；journal 的 limit/countNote/truncate/moodTags。
- `errors.js`、`i18n.js` + `i18n/*`：错误与三语词典；页面当前不接 t()。
- `platform.js`：`core.platform` 探测；`settingsBridge` 仅 Android 非 null（八条提醒键，含前端键→原生键唯一映射与 JSON 解析），`windowControl/exportBridge` 仍 null。
- `fx.js` / `edit.js` / `app.js`：共享动效、边界编辑、事件/commit/页面注册/过渡/主题。
- `core.js`：薄装配，暴露 `core`。

### pages

- `today.js` + `today.ring.js`
- `calendar.js` + `calendar.grid.js` + `calendar.detail.js`
- `history.js`
- `insights.js` + `insights.chart.js`
- `you.js` + `you.settings.js` + `you.transfer.js` + `you.dialog.js` + `you.scene.js`
- `journal.js`（第六页，无 dock tab）
- `auth.js`（`#pg-auth` gate，不是 `.page`）

### shell / CSS

- `js/shell/desktop.js`：`body.piq-shell` 后注入内联标题栏模板，绑定三窗控 + 拖拽/双击消息，同步页名。
- CSS 11 个：`base`、`fonts`、`today`、`calendar`、`history`、`insights`、`you`、`you.data`、`journal`、`auth`、`shell`。
- `shell.css` 全部 selector 受 `body.piq-shell` 限定；无 `piq-shell` 时标题栏 `display:none`，移动端零影响。

## 3. 页面与入口

| 页面 | 入口 | 工厂 | 备注 |
|---|---|---|---|
| Today | `#pg-today` | `boot_today` | dock 0 |
| Calendar | `#pg-cal` | `boot_cal` | dock 1；日详情、Note、`#jrn` |
| History | `#pg-hist` | `boot_hist` | dock 2 |
| Insights | `#pg-ins` | `boot_ins` | dock 3 |
| You | `#pg-you` | `boot_you` | dock 4；主题/语言/通知/Data/Privacy |
| Journal | `#pg-journal` | `boot_journal` | 无 dock；Calendar header `#jrn` 进入；`#jback` 回 Calendar |
| Auth | `#pg-auth` | `boot_auth` | 非 `.page`；未登录全屏门；`#app` inert、dock 隐藏 |
| Shell | `#app-titlebar` | — | 仅 `body.piq-shell`；desktop.js 注入（源码静态占位） |

## 4. 状态/API essentials

- 日期：`TODAY` 为本地日历日的 UTC 天序号；`m.toN/dOf/fmt`；页面日期按 UTC 格式化。
- 数据：`CYC` 按 `s` 升序；`DAILY[n]`；`JOURNAL` 只能经 `api.journal.get/range/put/countNote/truncate/writable`。
- Journal：`range` 返回降序（有 note 的天）；`put` 仅 `TODAY` 可写；成功后 API 负责持久化与一次 commit。
- Daily：`api.getDaily(n)`、`api.isPeriodDay(n)`；非经期日可只有 journal note。
- Auth：`api.auth.state()` → `{authed,persistent,user,demo_password}`；`login/register` 成功后校验 `state().authed`，再由 auth.js reload；不读 token。
- 设备设置：Win real 的 `hydrate()` 发 `GET /device/settings` 填充 `A._settings`（只合并前端已知 8 键，失败仅 `_hydrateNote` 记一笔，不阻断启动）；Win real 的 `A.settings(patch)` 发 `PUT /device/settings`，成功后按 8 键合并回 `A._settings`；`A.settings()` 无参同步返回缓存副本。Android 不发 `GET/PUT /device/settings`：每次 `A.settings()` 读都从 `settingsBridge` 同步 hydrate 八键，`A.settings(patch)` 逐键调用 `PIQNative.setSetting` 并以原生返回的 `value` 为准更新缓存，任一键失败回 `ok:false`（页面在 `#nstat`/原生 Toast 显示）；总开关打开时宿主负责通知权限请求，拒绝后原生回滚为 false，前端短轮询重读并画回关闭。mock 仍是同步 provider。
- About：`core.api._version` 来自 `GET /health`（`realHydrate` 写入，非致命）；`you.js` 的 `paintVersion()` 在 boot / `model` 事件 / `refresh` 时渲染，无值时显示 `—` / `Version unavailable`，About 区与 html/js/css 不出现字面版本号（`manifest.json` 仅保留构建期存在性占位）。
- Shell：`body.piq-shell` + `#app-titlebar`；`desktop.js` 发 `win_start_drag`/`win_minimize`/`win_toggle_max`/`win_close`。

## 5. 关键契约

### Journal

- Today 始终在顶部可写；过去只读；倒序；空态只按真实行。
- 300 码点必须经 `api.journal.countNote/truncate`，不得用 `.length`/`.slice`。
- 失败显示 `r.message`；Today 保存/删除均经 `journal.put(TODAY, ...)`。

### Auth

- 未登录 gate 显示，`#app` inert/aria-hidden，dock 隐藏；登录/注册成功 reload 进应用。
- You 登出/改密/删号触发 signOut + auth 事件，自动回 gate；改密仍走 You 的既有两步对话框。
- 无 token/storage；mock 恒 authed，真实登录必须用真实后端验证。

### Shell

- 只有 `body.piq-shell` 才启用；44px 标题栏 + 左侧胶囊 rail（`--rail-w:88px`，<880px 74px；`--rail-cw:64px`，<880px 62px）+ 页面自定 `--shell-col`（默认 600px；Today 1560px；Calendar/History/Insights/You/Journal 为 none）；dock 无壳时为底部 394px 横排。
- `desktop.js` 注入内联标题栏模板；页名随 `.page.cur` 更新，auth gate 显示 `Access`。
- 三按钮：minimize / toggle / close；拖拽区 `.titlebar-drag`；双击切最大化。
- 无 `piq-shell` 时不得出现标题栏或布局偏移。

### 安全区/移动

- 消费 `--sai-top/right/bottom/left`，不直接写 `env(safe-area-inset-*)`；Android 由宿主注入 `--piq-inset-*`。
- 390/360 无横向溢出、无 console 错误；dock 不压内容。

## 6. 当前已知缺口

- **P2**：真实 WebView2 拖动/最小化/最大化/关闭、Aero Snap、`close_action`；Win 直接使用已冻结的 `win/frontend/` 副本，`/device/settings` 仍需真实宿主联调。
- **P4**：PyInstaller 驱动缺失、版本 C/旧镜像清理、安装包、Android release 构建与签名。
- **Android 设置链路**：`core.platform.settingsBridge` 在 Android 下非 null，封装 `PIQNative.getSetting/setSetting` 的八条提醒键；Android 平台不发 `GET/PUT /device/settings`。
- **Android 构建**：前端复制源 = `android/frontend/`（构建期复制进 `android/app/src/main/assets/www/`，排除根 `README.md`/`CONTEXT.md`）。2026-11-26 本机 Debug APK（3.2.0 / 26）已构建通过，`testDebugUnitTest` 99 tests / 0 failures；模拟器/真机回归未验证，release 构建与签名未执行（无 keystore）。
- **TWA**：Android TWA 仍是占位。
- **B10 桌面版式**：B10 旧桌面版式已被 W1-1R…W1-5B 替换，当前按 W1 基线。
- **B5 #20**：真实后端低数据/单周期回归待做。
- **B9 You Privacy**：390 下 Log out 在横向卡片外侧，需确认/修。
- 真实后端回归必须用隔离库，不得只看 `file://` mock。

## 7. 验收要点

- `file://`：390/360、dark/light、reduce；console 0；文档级无横向滚动。
- Journal/Auth：真实后端空库、注册→错误密码→登录→登出→改密→新密码登录。
- Shell：模拟 `piq-shell` 在 1024×768 / 800×600（4:3；800 允许纵向滚动、不得横向溢出）；标题栏 44px、内容不遮、页名/消息正确；无 `piq-shell` 的 390/360 不变。
- 任何数据层改动：真实后端隔离库、单次 commit、失败不写 store。
