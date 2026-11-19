# PeriodIQ Android 端源码

Kotlin + WebView + Chaquopy 的本地优先经期记录与预测应用。没有服务器、没有联网权限，数据只留在设备上。

> 统计推算工具，不是医学诊断，也不能作为避孕依据。

## 结构

| 路径 | 内容 |
|---|---|
| `app/` | Kotlin 应用、Python 算法源、资源与构建配置。 |
| `frontend/` | 移动端静态前端源码；构建时需要同步到 `app/src/main/assets/www/`。 |
| Gradle 文件 | `build.gradle.kts`、`settings.gradle.kts`、`gradle.properties`、`gradlew`、`gradle/`。 |

## 说明

- 当前仓库只包含运行源码与前端；构建所需的同步/隐私闸门脚本在本机维护，不随仓库发布，因此不保证在干净环境直接构建。
- 预编译 APK 暂不提供。
- 数据存应用私有目录，`allowBackup="false"`；只申请通知与重启恢复提醒权限。
- 浅色/深色/跟随系统；多用户本地口令隔离。

## 版本

与 Win 端同版本线，当前 `3.0.8`。
