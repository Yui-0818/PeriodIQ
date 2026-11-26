# android/frontend — Mobile UI Source

Single source of truth for the PeriodIQ Android WebView frontend (currently matching Android **3.2.0 / versionCode 26**). Designed with vanilla HTML/CSS/JavaScript — zero build step, zero external CDN dependencies, works offline via `file://` or WebView `AssetLoader`.

## Layout

```text
android/frontend/
  index.html          App shell (Today / Calendar / History / Insights / You / Journal + Auth gate)
  manifest.json       Web manifest (verified during Gradle asset sync)
  css/                base / fonts / today / calendar / history / insights / you / journal / auth / shell
  js/                 core.js / main.js (bootstrap & wiring)
  js/core/            state / transport / hydrate / api.* / errors / i18n / platform / fx / edit / app / mock
  js/i18n/            zh-CN / en / es locale dictionaries
  js/pages/           today(+ring) / calendar(+grid+detail) / history / insights(+chart) / you / journal / auth
  js/shell/           desktop.js (window controls bridge)
  fonts/              Locally bundled Inter & NotoSansSC woff2 subsets
```

> Do not edit `android/app/src/main/assets/www/` directly — it is regenerated from this directory on every Gradle build.
