# PeriodIQ Android Source

Local-first period tracking and cycle prediction app built with Kotlin + WebView. The statistical cycle prediction engine is implemented in **pure Kotlin** (`algo/`). Zero servers, zero network permissions — all data stays on-device.

> Statistical estimation tool only. Not a medical device; must not be used for diagnosis, treatment, or contraception.

## Structure

| Path | Description |
|---|---|
| `android/app/` | Kotlin app (WebView host, JS bridge, SQLite data layer, local reminders, pure Kotlin `algo/` engine), resources, and Gradle build config. |
| `android/frontend/` | Single source of truth for mobile UI assets; synced into `android/app/src/main/assets/www/` during Gradle builds. |
| Gradle wrapper | `android/build.gradle.kts`, `android/settings.gradle.kts`, `android/gradle.properties`, `android/gradlew`, `android/gradlew.bat`, `android/gradle/`. |

## Version

- Android: **`3.2.0` (`versionCode 26`)**, defined in `android/app/build.gradle.kts`.
- Maintained independently from the Windows desktop line (`3.0.8`).

## Prerequisites

| Dependency | Details |
|---|---|
| JDK | Java 11+ (Gradle uses `compileOptions` / `jvmTarget = 11`). |
| Android SDK | `compileSdk = 35`, `targetSdk = 35`, `minSdk = 26` (`ANDROID_HOME` / `ANDROID_SDK_ROOT`). |
| Gradle | Included via `android/gradlew` wrapper; no global Gradle installation required. |
| Release Signing | Required only for release builds via `-Ppiq.keystore.properties=<path>`, `PIQ_KEYSTORE_PROPERTIES`, or repo-root `keystore.properties` (gitignored). Release tasks fail closed if missing. |

## Build & Test

No Python or external scripts are required. From `android/`:

```bash
# Run JVM unit tests (includes statistical algorithm golden tests)
./gradlew testDebugUnitTest

# Assemble Debug APK (automatically syncs android/frontend and runs privacy gates)
./gradlew assembleDebug
```

- Debug APK output: `android/app/build/outputs/apk/debug/app-debug.apk`
- `android/app/src/main/assets/www/` is regenerated from `android/frontend/` on every build (gitignored).

## Privacy Guarantees

Verified in `android/app/src/main/AndroidManifest.xml`:
- **No `INTERNET` permission** — physically incapable of outbound network traffic.
- Only two permissions declared: `POST_NOTIFICATIONS` (optional reminder notifications, API 33+ runtime permission) and `RECEIVE_BOOT_COMPLETED` (reschedule local reminder alarms after reboot).
- `android:allowBackup="false"`; all data lives in app-private storage.
- `PiqExportProvider` (`exported="false"`) grants single-URI read-only access only when exporting.
- Built-in Gradle `privacyGate` and `privacyGatePackaged` tasks verify that no SQLite databases or backup payloads enter assets or built APKs.
