/**
 * Service worker for ColorAI: side-panel behavior, tab scripting for summarize,
 * selection persistence (session storage), and LLM requests from the side panel.
 */

import { completeChat, listModelsForProvider, mergeSettings } from "./llm.js";

/** Sync storage key (legacy `sideAiSettings` still read for migration). */
const STORAGE_SYNC_PRIMARY = "colorAiSettings";
const STORAGE_SYNC_LEGACY = "sideAiSettings";

/** Session key: last text selection per tab (for the quote strip in the side panel). */
const SESSION_SELECTIONS = "colorAiSelections";

/**
 * Load merged settings; prefers `colorAiSettings`, falls back to legacy key.
 */
async function loadSettings() {
  const data = await chrome.storage.sync.get([STORAGE_SYNC_PRIMARY, STORAGE_SYNC_LEGACY]);
  const raw = data[STORAGE_SYNC_PRIMARY] || data[STORAGE_SYNC_LEGACY] || {};
  return mergeSettings(raw);
}

/**
 * Resolve custom skill by id from stored `skills` array.
 * @param {unknown[]} skills
 * @param {string} [id]
 */
function skillById(skills, id) {
  if (!id || !Array.isArray(skills)) return null;
  return skills.find((x) => x.id === id) || null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

/**
 * Read main/article text from a tab via `scripting.executeScript` (same logic as before).
 * @param {number} tabId
 */
async function getPageFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || "";
      const url = location.href;
      const article =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.querySelector('[role="main"]') ||
        document.body;
      const clone = article.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, iframe, svg, nav, footer").forEach((el) => el.remove());
      const text = (clone.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120_000);
      return { title, url, text, length: text.length };
    },
  });
  return result?.result;
}

/**
 * Store the latest text selection for `sender.tab.id` so the side panel can quote it.
 * Empty text removes the entry for that tab.
 */
async function rememberSelection(sender, text, pageUrl) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const prev = (await chrome.storage.session.get(SESSION_SELECTIONS))[SESSION_SELECTIONS] || { byTab: {} };
  const byTab = { ...prev.byTab };
  const key = String(tabId);

  if (!text) {
    delete byTab[key];
  } else {
    byTab[key] = { text, url: pageUrl || "" };
  }

  await chrome.storage.session.set({ [SESSION_SELECTIONS]: { byTab } });
}

/**
 * `sendResponse` throws if the sender tab navigated or the port closed (common on Office/Word Online).
 * Swallowing avoids noisy `runtime.lastError` logs in the console.
 * @param {(payload: unknown) => void} sendResponse
 * @param {unknown} payload
 */
function safeSend(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    /* port already closed */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /**
   * Selection updates fire very often on rich editors (Word Online, Teams). We must reply
   * synchronously and return `false` so Chrome does not keep the message channel open; async
   * `await storage` here is what triggers “message channel closed before a response was received”.
   */
  if (message?.type === "SELECTION_TEXT") {
    const text = (message.text || "").trim();
    void rememberSelection(sender, text, message.url).catch(() => {});
    safeSend(sendResponse, { ok: true });
    return false;
  }

  (async () => {
    try {
      /** Side panel: user dismissed the quote strip — clear stored selection for a tab */
      if (message?.type === "CLEAR_SELECTION") {
        const tabId = message.tabId;
        if (tabId == null) {
          safeSend(sendResponse, { ok: false });
          return;
        }
        const prev = (await chrome.storage.session.get(SESSION_SELECTIONS))[SESSION_SELECTIONS] || { byTab: {} };
        const byTab = { ...prev.byTab };
        delete byTab[String(tabId)];
        await chrome.storage.session.set({ [SESSION_SELECTIONS]: { byTab } });
        safeSend(sendResponse, { ok: true });
        return;
      }

      /** Options page: discover models for the chosen provider (uses draft form + saved settings). */
      if (message?.type === "LIST_MODELS") {
        const saved = await loadSettings();
        const draft = message.draft && typeof message.draft === "object" ? message.draft : {};
        const merged = mergeSettings({ ...saved, ...draft });
        const models = await listModelsForProvider(merged);
        safeSend(sendResponse, { ok: true, models });
        return;
      }

      if (message?.type === "CHAT") {
        const settings = await loadSettings();
        const skills = settings.skills || [];
        const skill = skillById(skills, message.skillId);
        const msgs = [];
        if (skill?.systemPrompt?.trim()) {
          msgs.push({ role: "system", content: skill.systemPrompt.trim() });
        }
        const pref = String(settings.preferredInstruction || "").trim();
        if (pref) {
          msgs.push({ role: "system", content: pref });
        }
        for (const m of message.messages || []) {
          msgs.push({ role: m.role, content: m.content });
        }
        const text = await completeChat(msgs, settings);
        safeSend(sendResponse, { ok: true, text });
        return;
      }

      if (message?.type === "GENERATE_TAB_TITLE") {
        const settings = await loadSettings();
        const raw = Array.isArray(message.messages) ? message.messages : [];
        const lines = [];
        for (const m of raw.slice(-8)) {
          const role = m?.role === "assistant" ? "assistant" : "user";
          const content = String(m?.content || "").trim().slice(0, 2_500);
          if (content) lines.push(`${role}: ${content}`);
        }
        const transcript = lines.join("\n\n");
        if (!transcript) {
          safeSend(sendResponse, { ok: false, error: "No messages to name." });
          return;
        }
        const system =
          "You write very short UI tab titles for a chat app. Reply with ONLY the title text: max 6 words, no quotes, no punctuation at the end, describe the main topic. If the chat is empty or unclear, reply: Chat";
        const text = await completeChat(
          [
            { role: "system", content: system },
            { role: "user", content: `Conversation:\n${transcript}` },
          ],
          settings
        );
        let title = String(text || "")
          .trim()
          .replace(/^["'«»]|["'«»]$/g, "")
          .replace(/\s+/g, " ")
          .slice(0, 48);
        if (!title) title = "Chat";
        safeSend(sendResponse, { ok: true, title });
        return;
      }

      if (message?.type === "SUMMARIZE_TAB") {
        const settings = await loadSettings();
        let tabId = message.tabId;
        if (!tabId) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id;
        }
        if (!tabId) {
          safeSend(sendResponse, { ok: false, error: "No active tab." });
          return;
        }

        const page = await getPageFromTab(tabId);
        if (!page?.text) {
          safeSend(sendResponse, { ok: false, error: "Could not read page text (empty or restricted page)." });
          return;
        }

        const extra = (message.extraInstructions || "").trim();
        const pref = String(settings.preferredInstruction || "").trim();
        const system = [
          "You summarize web pages clearly and concisely.",
          "Use markdown: short title line, then bullet points for key ideas.",
          "If the excerpt seems truncated, mention that briefly.",
          pref ? `User default preferences: ${pref}` : "",
          extra ? `User instructions: ${extra}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const user = [
          `Page title: ${page.title}`,
          `URL: ${page.url}`,
          `Extracted text (${page.length} chars):\n\n${page.text}`,
        ].join("\n\n");

        const text = await completeChat(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          settings
        );
        safeSend(sendResponse, { ok: true, text, meta: { title: page.title, url: page.url, length: page.length } });
        return;
      }

      if (message?.type === "PING") {
        safeSend(sendResponse, { ok: true });
        return;
      }

      safeSend(sendResponse, { ok: false, error: "Unknown message type." });
    } catch (e) {
      safeSend(sendResponse, { ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
