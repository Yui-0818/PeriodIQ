# app — Android Application Module

| Path | Description |
|---|---|
| `src/main/java/` | Kotlin sources: WebView host, JS bridge, SQLite data layer, reminder scheduler, and pure Kotlin `algo/` engine. |
| `src/main/java/.../algo/` | Pure Kotlin statistical cycle engine (`AlgoBayesian`, `AlgoConfig`, `AlgoEval`, `AlgoFertility`, `AlgoStats`, `AlgoTrace`, `PiqAlgo`). |
| `src/test/java/` | JVM unit tests including `AlgoGoldenTest.kt` (backed by `src/test/resources/golden_algo_vectors.json`) and data/import/reminder contract tests. |
| `src/main/assets/www/` | Generated during Gradle builds from `android/frontend/` (gitignored; do not edit manually). |
| `src/main/res/` | Adaptive & legacy launcher icons, monochrome notification icon, light/dark splash & theme resources. |
| `build.gradle.kts` | Pure Gradle frontend sync, fail-closed release signing gate, and pre/post-packaging privacy gates. |

## Build Tasks

- `syncFrontendAssets`: Cleans and copies `android/frontend/` into `app/src/main/assets/www/`, excluding markdown docs and rejecting any prohibited database files.
- `privacyGate`: Scans `src/main/assets`, `src/main/res`, and intermediate merged assets before build; fails immediately if any database or backup payload is found.
- `privacyGatePackaged`: Runs automatically after `assembleDebug`, `assembleRelease`, `bundleRelease`, and `package*` tasks, recursively inspecting built APK zip contents.
