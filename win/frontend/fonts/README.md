# fonts — 本地字体子集

> 目的：把设计稿使用的 Inter 从「Google Fonts 外链」改为**本地文件**。
> 背景：外链会在 Android（无 INTERNET 权限）静默失败、在 Win 桌面端出网、
> 并让 `file://` 的 `load` 事件不收敛（2026-11-02 审计缺陷 #2）。

## 文件

| 文件 | 大小 | 字节数 | sha256（前 16） | 用途 |
|---|---|---|---|---|
| `Inter-var-latin.woff2` | 48 KB | 48,256 | `3100e775e8616cd2` | 主字形（英文正文/标题），可变字重 100–900 |
| `Inter-var-latin-ext.woff2` | 83 KB | 85,068 | `34b9c504cab7a73e` | 拉丁扩展（变音符语言） |
| `Inter-italic-var-latin.woff2` | 51 KB | 51,832 | `7291b5970da22374` | 斜体主字形（可变字重 100–900） |
| `Inter-italic-var-latin-ext.woff2` | 90 KB | 91,900 | `71254244ccb1ec21` | 斜体拉丁扩展 |

四个文件均已校验 `wOF2` 魔数，可直接被 `@font-face` 引用。

## 来源与许可

- 来源：Google Fonts CSS2 API（`family=Inter:wght@100..900` 与 `ital,wght@1,100..900`），**Inter v20** 子集。
- 设计者：Rasmus Andersson；许可证：**SIL Open Font License 1.1**（随字体分发，不得单独售卖）。
- 只取 `latin` 与 `latin-ext`：UI 文案为英文；CJK 不在 Inter 覆盖范围内（中文由系统字体栈兜底）。未下载的 4 个子集（cyrillic-ext / cyrillic / greek-ext / greek / vietnamese）按需再补。

## 引用方式（P1 / TP-3 使用）

本地 `@font-face`，**不得**在 `index.html` 保留外链 `<link>`：

```css
@font-face{
  font-family:'Inter';
  font-style:normal;
  font-weight:100 900;
  font-display:swap;
  src:url('../fonts/Inter-var-latin.woff2') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
```

其余三个文件按同样的 `unicode-range` 与 `font-style` 追加（latin-ext / italic-latin / italic-latin-ext）。

## 重新获取（换版本或补子集时）

```bash
# 1) 取 CSS，读出对应子集的 woff2 URL
curl -s 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap'
curl -s 'https://fonts.googleapis.com/css2?family=Inter:ital,wght@1,100..900&display=swap'
# 2) 下载（本机 schannel 不可用，用 Python 的 OpenSSL 通道）
python - <<'PY'
import urllib.request
urllib.request.urlretrieve('https://fonts.gstatic.com/s/inter/v20/<hash>.woff2', 'Inter-var-latin.woff2')
PY
```

> 注意：`curl` / PowerShell 在本机因沙箱剥离 TLS 凭证会失败（`SEC_E_NO_CREDENTIALS`），
> 用 Python `urllib` 可正常下载。
