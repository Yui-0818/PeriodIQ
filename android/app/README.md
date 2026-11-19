# app — Android 应用模块

| 位置 | 内容 |
|---|---|
| `src\main\java\` | Kotlin 源：WebView 壳、JS 桥、数据层、提醒 |
| `src\main\python\` | **唯一 Python 源**（Chaquopy 打包根）：`app\algo\` 周期统计算法 |
| `src\main\assets\` | `www\` 构建期由 `~\tools\Standing\copy_frontend.py` 从 `~\Android\frontend\` 复制生成，不入库 |
| `src\main\res\` | 启动图标：`mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}\ic_launcher.png` 与同目录 `ic_launcher_round.png` 共 10 个传统 PNG；`mipmap-anydpi-v26\ic_launcher.xml` / `ic_launcher_round.xml` 自适应图标；`drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}\ic_launcher_foreground.png` 5 个前景 PNG；`drawable\ic_stat_periodiq_reminder.xml` 通知小图标；`values\ic_launcher_background.xml` 启动背景色 |
| `build.gradle.kts` | 签名闸门（release 无签名输入即失败）、隐私闸门接线、前端同步任务 |

- 禁止把 `assets\www\` 当手改目标——它每次构建都会从 `~\Android\frontend\` 重新生成并覆盖。
