# Contributing to PeriodIQ / 贡献指南

Thank you for your interest in improving PeriodIQ!

## Code & Contribution Guidelines

1. **Privacy-First Invariant**: Never introduce outbound network requests, analytics, telemetry, crash reporting, or `android.permission.INTERNET` on Android. Windows backend must remain bound to `127.0.0.1` only.
2. **Local-Only Data**: Never commit personal health data, databases (`*.db`, `*.sqlite`), signing keys (`*.keystore`, `keystore.properties`), or build outputs.
3. **Testing**:
   - Android: run `./gradlew testDebugUnitTest assembleDebug` inside `android/`.
   - Windows: verify backend and UI locally with an isolated `MENSTRUAL_DB_PATH`.

## Contributor License Agreement (Important)

Because PeriodIQ is dual-licensed (source-available under **PolyForm Noncommercial 1.0.0** for noncommercial use, and available under separate **Commercial Licenses** negotiated directly with the author):

By submitting a Pull Request, patch, or other contribution to this repository, you agree that:
1. You have the legal right to submit the contribution; and
2. You grant **Yui_0818** a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute, and sublicense your contribution under **both** the PolyForm Noncommercial License 1.0.0 and any separate commercial or open-source licenses offered by the author for PeriodIQ.

---

### 贡献者授权声明（中文）

由于 PeriodIQ 采用「非商用公开源码（PolyForm Noncommercial 1.0.0）+ 作者独立商业授权」的双重许可模式：

向本仓库提交 Pull Request 或代码补丁，即表示你确认对该贡献拥有合法权利，并授予作者 **Yui_0818** 永久、全球、非独占、免版税、不可撤销的许可，允许作者在 PolyForm Noncommercial 1.0.0 及作者另行授予的商业授权中使用、修改、分发和再许可该贡献。
