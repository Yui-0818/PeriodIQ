# Changelog / 更新日志

## Android 3.2.0 (versionCode 26) — 2026-11-26

### Highlights
- **Pure Kotlin Prediction Engine**: Migrated the entire cycle statistical prediction engine to pure Kotlin (`algo/`) and retired the Python/Chaquopy runtime, significantly reducing APK size (~3.0 MB release APK) and improving cold-start speed.
- **Pure Gradle Build**: Frontend asset sync and build-time/post-packaging privacy gates now run natively in Gradle Kotlin with zero external Python tooling required.
- **Interactive Motion & Polish**: Added subtle tilt-sensor parallax effects, bundled `NotoSansSC` typography, and refined light/dark theme cold-start splash rendering.
- **Tri-lingual Support**: Full Simplified Chinese (`简体中文`), English, and Spanish (`Español`) UI and native system strings with instant switching.
- **Reliability & UX**:
  - End-to-end local reminder scheduling & notification deep linking.
  - Corruption-safe SQLite recovery with automatic fallback backup.
  - Improved CSV/JSON import validation, accessibility labels, keyboard/dock layout handling, and day-detail editing safeguards.

## Windows 3.0.8 — Frozen Release Line

### Highlights
- Local-first desktop application powered by Python 3.11 + FastAPI + SQLite (`127.0.0.1` loopback only) wrapped in a lightweight C# WinForms + WebView2 native host.
- Full cycle logging, statistical prediction with error bounds, monthly calendar view, insights & trends, same-day journal & mood tracking, JSON/CSV import/export with automatic pre-import snapshots, and tri-lingual UI.
- Distributed via Windows installer (`PeriodIQ-Setup-3.0.8.exe`); uninstalling preserves user data.
