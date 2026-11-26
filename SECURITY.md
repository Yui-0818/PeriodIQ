# Security Policy / 安全策略

## Reporting a Vulnerability

If you discover a security or privacy vulnerability in PeriodIQ (for example, an unintended data leak, WebView bridge bypass, or local storage exposure), **please do not open a public GitHub Issue**.

Instead, report it privately via email:

- **Contact**: `aaaj6719@gmail.com`
- **Subject**: `[PeriodIQ Security] <brief description>`

Please include steps to reproduce, affected platform/version (Windows or Android), and any relevant proof-of-concept details. You will receive an acknowledgement as soon as possible.

## Security Guarantees Verified in Every Build

- Android APK declares **no `INTERNET` permission** and enforces a build-time & post-packaging privacy gate (`privacyGate` / `privacyGatePackaged`) that blocks any database or backup payload from entering the APK.
- Android release builds enforce `isDebuggable = false` and fail closed if release signing credentials are missing.
- Windows local backend binds strictly to `127.0.0.1`.
