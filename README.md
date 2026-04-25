# LLM Thinking Translator

LLM Thinking Translator is a Manifest V3 browser extension for Chromium-based browsers (Edge, Chrome, Brave, etc.). It translates visible English thinking / reasoning panels on ChatGPT, Claude, and Gemini into Simplified Chinese.

Important boundary: the extension only reads text that is already rendered in the page DOM and visible to the user. It does not access hidden model internals, bypass platform restrictions, or extract anything that the page itself has not exposed.

## Supported Sites

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

## Installation

### From GitHub Release (Recommended)

1. Go to the [Releases page](https://github.com/MOLAaaaaaaa/llm-thinking-translator/releases) and download the latest release zip.
2. Unzip the file to a folder on your computer.
3. Open `edge://extensions/` (or `chrome://extensions/` for Chrome).
4. Enable **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked**.
6. Select the unzipped folder.
7. Refresh the target AI web page.

### From Source

1. Clone this repository.
2. Open `edge://extensions/` (or `chrome://extensions/` for Chrome).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository root folder.
6. Refresh the target AI web page.

## Usage

The extension shows a small launcher button in the bottom-right corner of supported pages. Click it to open or hide the control panel.

Keyboard shortcuts:

- `Alt + Shift + L`: toggle the panel
- `Alt + Shift + R`: rescan the current page
- `Alt + Shift + T`: manually pick a DOM node to translate

The debug panel is hidden by default for release-style use. When debug mode is enabled, the extension can show candidate outlines, selectors, and diagnostic details.

## Translation Providers

The default provider is Google GTX:

```text
https://translate.googleapis.com/translate_a/single?client=gtx
```

It is useful for quick testing and light usage. You can also switch to:

- Custom HTTP POST endpoint
- OpenAI-compatible Chat Completions endpoint

AI API keys are stored in `chrome.storage.local`, not browser-sync storage.

## DOM Strategy

The extension uses structural selectors instead of keyword-only detection. This avoids translating whole assistant responses just because they contain words such as `thinking`, `reasoning`, or `analysis`.

Current platform rules:

- ChatGPT: targets known `text-token-text-secondary origin-start` thought blocks.
- Claude: targets known `text-text-300` reasoning blocks.
- Gemini: targets `model-thoughts`, with separate handling for collapsed and expanded thought states.

Chinese text is skipped. Only primarily English content is translated.

## Development

Load this directory as an unpacked extension while developing.

## Building a Release

Run the packaging script to create a zip file for distribution:

```powershell
.\scripts\pack.ps1
```

The output will be placed in the `dist/` directory.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

# LLM Thinking Translator

LLM Thinking Translator 是一个基于 Manifest V3 的浏览器扩展，适用于 Chromium 内核浏览器（Edge、Chrome、Brave 等）。它可以将 ChatGPT、Claude 和 Gemini 页面上可见的英文思考/推理面板翻译为简体中文。

重要边界：本扩展仅读取已在页面 DOM 中渲染且对用户可见的文本。它不会访问隐藏的模型内部机制、绕过平台限制或提取页面本身未暴露的任何内容。

## 支持的站点

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

## 安装

### 从 GitHub Release 安装（推荐）

1. 前往 [Releases 页面](https://github.com/MOLAaaaaaaa/llm-thinking-translator/releases)，下载最新的发布压缩包。
2. 将文件解压到本地文件夹。
3. 打开 `edge://extensions/`（Chrome 用户请打开 `chrome://extensions/`）。
4. 开启右上角的**开发者模式**。
5. 点击**加载解压缩的扩展**。
6. 选择解压后的文件夹。
7. 刷新目标 AI 网页。

### 从源码安装

1. 克隆本仓库。
2. 打开 `edge://extensions/`（Chrome 用户请打开 `chrome://extensions/`）。
3. 开启右上角的**开发者模式**。
4. 点击**加载解压缩的扩展**。
5. 选择仓库根目录。
6. 刷新目标 AI 网页。

## 使用方法

扩展会在支持页面的右下角显示一个启动按钮，点击即可打开或隐藏控制面板。

键盘快捷键：

- `Alt + Shift + L`：切换面板
- `Alt + Shift + R`：重新扫描当前页面
- `Alt + Shift + T`：手动选取 DOM 节点进行翻译

调试面板默认隐藏，适合正式使用。开启调试模式后，扩展可以显示候选框、选择器和诊断详情。

## 翻译服务

默认使用 Google GTX：

```text
https://translate.googleapis.com/translate_a/single?client=gtx
```

适合快速测试和轻度使用。你也可以切换到：

- 自定义 HTTP POST 端点
- OpenAI 兼容的 Chat Completions 端点

AI API 密钥存储在 `chrome.storage.local` 中，而非浏览器同步存储。

## DOM 策略

扩展使用结构化选择器而非仅关键词检测。这避免了仅因为包含 `thinking`、`reasoning` 或 `analysis` 等词而翻译整个助手回复。

当前平台规则：

- ChatGPT：针对已知的 `text-token-text-secondary origin-start` 思考块。
- Claude：针对已知的 `text-text-300` 推理块。
- Gemini：针对 `model-thoughts`，分别处理折叠和展开的思考状态。

中文文本会被跳过。仅翻译主要为英文的内容。

## 开发

开发时将本目录作为解压缩扩展加载即可。

## 构建发布版本

运行打包脚本生成分发用的 zip 文件：

```powershell
.\scripts\pack.ps1
```

输出文件将放在 `dist/` 目录下。

## 许可证

MIT 许可证。详见 [LICENSE](LICENSE)。
