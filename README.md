# ColorAI — Chrome extension

A **Manifest V3** extension with a **side panel** for chat, **page summarization**, and **custom skills** (per-skill system prompts). Supports **Ollama** (local), **OpenAI**, and **Google Gemini**.


| Provider   | What you need                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Ollama** | [Ollama](https://ollama.com/) running locally — default `http://127.0.0.1:11434`. If you see **403**, see **Ollama + Chrome** below. |
| **OpenAI** | API key from [OpenAI](https://platform.openai.com/)                                                                                  |
| **Gemini** | API key from [Google AI Studio](https://aistudio.google.com/)                                                                        |


### Ollama + Chrome (403)

The extension calls Ollama with `**Origin: chrome-extension://…`**. Ollama often returns **403** unless that origin is allowed.

**Fix A — `OLLAMA_ORIGINS` (official Ollama setting):**

- `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`  
- Or only this extension: `OLLAMA_ORIGINS="chrome-extension://YOUR_EXTENSION_ID" ollama serve` (ID from `chrome://extensions`).

Important: the **Ollama desktop app** may **not** load variables from your shell. In that case use **Fix B** or start Ollama from a terminal where `OLLAMA_ORIGINS` is set.

**Fix B — local proxy (no Ollama env change):**

1. Keep Ollama on `http://127.0.0.1:11434` (default).
2. In the project folder run:
  `node scripts/colorai-ollama-proxy.mjs`  
   This listens on `**http://127.0.0.1:11435`** and forwards to Ollama **without** the browser `Origin` header.
3. In ColorAI **Options**, set **Ollama base URL** to `**http://127.0.0.1:11435`** and **Save**.

## Install (developer / unpacked)

1. Chrome → **Extensions** → enable **Developer mode**.
2. **Load unpacked** and select this folder (`chrome-sideai-plugin`).
3. Click the extension icon — the **side panel** opens (opens on toolbar click).

## Configure

- Open **ColorAI settings** from the gear in the side panel, or right‑click the extension → **Options**.
- Pick a provider, enter URL / API key, then use **Test & list models** to load models into the dropdown. Choose a model and **Save**.
- Settings are stored under `**colorAiSettings`** in sync storage. Older installs may still read `**sideAiSettings**` once; saving migrates to the new key.

## Use

- **Tabs**: use **+** to start a new conversation; each tab’s messages are saved in `**chrome.storage.local`** (`colorAiLocalPanel`). Close a tab with **×**.
- **Messages panel**: the **▼** control on the right of the “Messages” bar collapses or expands the chat area.
- **Summary notes**: optional field for “Summarize page” — **▶** next to **Summarize page** toggles it (hidden by default).
- **Reload (↻)** in the header clears the **current tab’s** messages and the composer.
- **Summarize page** reads the active tab (main/article-like content) and appends a summary to the chat.
- **Selection**: select text on a page — it appears in the **Selection** strip above the message box. Your message is sent with that text included in the prompt (use **Dismiss** to clear the strip).
- **Skills**: add names + system prompts in the side panel. Choose a skill before chatting to apply that instruction set.
- **Markdown**: assistant replies are rendered as **Markdown** (GFM) with sanitization via **marked** + **DOMPurify** (`vendor/`).

## Permissions

- `**http://*/*`** and `**https://*/***` — required so `chrome.scripting` can read page content for summarize and so `content.js` can forward text selection.
- `**storage**` — settings and session selection cache.

## Notes

- **Microsoft Office / Word Online preload warning**: Messages like “preloaded using link preload but not used” come from **Microsoft’s own pages** (Office scripts), not from ColorAI. You can ignore them or hide console warnings while debugging the extension.
- **Restricted pages** (`chrome://`, the Web Store, some PDF viewers) cannot be scripted; summarization may fail — use a normal `http`/`https` page.
- API keys live in `**chrome.storage.sync`** on this profile.

## Files


| File                                           | Role                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `manifest.json`                                | MV3, side panel, content script, permissions                           |
| `background.js`                                | Side panel behavior, summarize, selection session store, `LIST_MODELS` |
| `content.js`                                   | Forwards text selection to the background (debounced)                  |
| `llm.js`                                       | Chat adapters + model listing for each provider                        |
| `sidepanel.*`                                  | Chat UI, tabs (local), skills, selection strip                         |
| `vendor/marked.min.js`, `vendor/purify.min.js` | Markdown render + HTML sanitize                                        |
| `options.*`                                    | Provider settings, **Test & list models**                              |
| `scripts/colorai-ollama-proxy.mjs`             | Optional local proxy to avoid Ollama 403 without `OLLAMA_ORIGINS`      |


