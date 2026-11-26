# Privacy Policy / 隐私政策

**Last Updated**: 2026-11-26

PeriodIQ is built on a strict **local-first, zero-telemetry** architecture. Your cycle, symptom, mood, and journal records belong exclusively to you.

## 1. Zero Data Collection

- **No servers, no cloud sync, no accounts**: PeriodIQ does not operate any remote backend. All data is stored locally in an on-device SQLite database.
- **No analytics, no ads, no crash reporting**: Neither the Windows nor Android app integrates any third-party SDKs for analytics, advertising, or error telemetry.

## 2. Network Isolation

- **Android**: The app **does not declare `android.permission.INTERNET`** in `AndroidManifest.xml`. It is technically incapable of making network connections. All UI assets and prediction algorithms run 100% locally on-device.
- **Windows**: The local FastAPI backend binds strictly to `127.0.0.1` (loopback only). All frontend assets are bundled locally with zero external CDN requests.

## 3. Data Control & Retention

- **Import / Export**: You can export your cycle data as JSON or CSV at any time. Importing creates an automatic local snapshot before replacing data. Daily journal entries and mood tags are kept local and excluded from import/export packages by design.
- **Uninstall**: Uninstalling the Windows application does not automatically delete your local user data directory so you do not accidentally lose records. On Android, clearing app data or uninstalling removes the app's private SQLite database according to standard Android OS behavior.

## 4. Medical Disclaimer

PeriodIQ performs statistical estimation based on historical cycle records. It is **not a medical device** and must not be used for medical diagnosis, treatment, or contraception.

---

## 隐私声明（中文摘要）

- **零收集、零上传**：无账号服务器、无云同步、无统计埋点、无广告或崩溃上报；所有周期、症状、心情与日记仅保存在本机 SQLite 数据库中。
- **物理级断网**：Android 端不声明 `INTERNET` 权限，纯本地运行；Windows 端后端仅监听本机回环地址 `127.0.0.1`，所有前端资源离线打包、无外链请求。
- **数据自主可控**：支持 JSON/CSV 整包导入导出（导入前自动快照），Windows 端卸载不删除用户数据。
- **免责声明**：本工具仅做统计推算，非医疗器械，不可用于诊断、治疗或避孕。
