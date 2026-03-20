/**
 * ColorAI side panel: multi-session chat (local storage), markdown rendering,
 * selection quote, collapsible skills, and summary notes.
 */

import { mergeSettings } from "./llm.js";

// --- Vendor globals (marked + DOMPurify loaded before this module) ----------
const g = typeof globalThis !== "undefined" ? globalThis : window;
/** @type {typeof import('marked').marked | undefined} */
const markedLib = g.marked;
/** @type {typeof import('dompurify').default | undefined} */
const purify = g.DOMPurify;

if (markedLib?.setOptions) {
  markedLib.setOptions({ gfm: true, breaks: true });
}

/** Primary sync key; legacy `sideAiSettings` is still read for migration. */
const STORAGE_KEY = "colorAiSettings";
const STORAGE_LEGACY = "sideAiSettings";

const SESSION_SELECTIONS = "colorAiSelections";

/** All panel-only state (tabs + UI flags) lives in chrome.storage.local */
const LOCAL_PANEL_KEY = "colorAiLocalPanel";

/**
 * @typedef {{ role: 'user' | 'assistant'; content: string; hint?: string }} ChatMsg
 * @typedef {{ id: string; title: string; messages: ChatMsg[]; titleManual?: boolean }} PanelSession
 * @typedef {{ sessions: PanelSession[]; activeId: string; ui: { skillsOpen: boolean; summaryNotesOpen: boolean } }} PanelState
 */

/** @type {PanelState} */
let panelState = {
  sessions: [],
  activeId: "",
  ui: { skillsOpen: false, summaryNotesOpen: false },
};

/** Points at the active session’s `messages` array */
/** @type {ChatMsg[]} */
let chatHistory = [];

async function loadSettings() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, STORAGE_LEGACY]);
  const raw = data[STORAGE_KEY] || data[STORAGE_LEGACY] || {};
  return mergeSettings(raw);
}

async function saveSettings(partial) {
  const cur = await loadSettings();
  const next = { ...cur, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render markdown to safe HTML for assistant bubbles */
function renderMarkdown(md) {
  const raw = md || "";
  try {
    const html =
      typeof markedLib?.parse === "function"
        ? markedLib.parse(raw)
        : `<p>${escapeHtml(raw)}</p>`;
    return typeof purify?.sanitize === "function"
      ? purify.sanitize(html, { USE_PROFILES: { html: true } })
      : escapeHtml(raw);
  } catch {
    return `<p>${escapeHtml(raw)}</p>`;
  }
}

function getSelectedSkillId() {
  return document.getElementById("skill-select")?.value || "";
}

async function refreshSkillSelect() {
  const settings = await loadSettings();
  const skills = Array.isArray(settings.skills) ? settings.skills : [];
  const sel = document.getElementById("skill-select");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Default (no skill)";
  sel.appendChild(none);
  for (const s of skills) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name || "Untitled";
    sel.appendChild(opt);
  }
}

function setStatus(text) {
  document.getElementById("status").textContent = text || "";
}

function activeSession() {
  return panelState.sessions.find((s) => s.id === panelState.activeId) || null;
}

function deriveTitle(msgs) {
  const u = msgs.find((m) => m.role === "user");
  if (!u?.content?.trim()) return "New chat";
  const line = u.content.trim().split("\n")[0];
  return line.length > 28 ? `${line.slice(0, 26)}…` : line;
}

async function persistPanelState() {
  await chrome.storage.local.set({ [LOCAL_PANEL_KEY]: panelState });
}

async function loadPanelState() {
  const data = await chrome.storage.local.get(LOCAL_PANEL_KEY);
  const raw = data[LOCAL_PANEL_KEY];
  if (raw && Array.isArray(raw.sessions) && raw.sessions.length > 0) {
    let activeId = raw.activeId || raw.sessions[0].id;
    if (!raw.sessions.some((s) => s.id === activeId)) activeId = raw.sessions[0].id;
    panelState = {
      sessions: raw.sessions,
      activeId,
      ui: {
        skillsOpen: !!raw.ui?.skillsOpen,
        summaryNotesOpen: !!raw.ui?.summaryNotesOpen,
      },
    };
  } else {
    const id = crypto.randomUUID();
    panelState = {
      sessions: [{ id, title: "New chat", messages: [], titleManual: false }],
      activeId: id,
      ui: { skillsOpen: false, summaryNotesOpen: false },
    };
    await persistPanelState();
  }
  const s = activeSession();
  chatHistory = s ? s.messages : [];
  if (!s && panelState.sessions[0]) {
    panelState.activeId = panelState.sessions[0].id;
    chatHistory = panelState.sessions[0].messages;
  }
}

function applyUiChrome() {
  const skillPanel = document.getElementById("skill-panel");
  const btnSkills = document.getElementById("btn-toggle-skills");
  const notesPanel = document.getElementById("summary-notes-panel");
  const btnNotes = document.getElementById("btn-toggle-summary-notes");

  if (panelState.ui.skillsOpen) {
    skillPanel.classList.remove("is-collapsed");
    btnSkills.setAttribute("aria-expanded", "true");
  } else {
    skillPanel.classList.add("is-collapsed");
    btnSkills.setAttribute("aria-expanded", "false");
  }

  const open = panelState.ui.summaryNotesOpen;
  if (open) {
    notesPanel.classList.remove("is-collapsed");
    btnNotes.setAttribute("aria-expanded", "true");
  } else {
    notesPanel.classList.add("is-collapsed");
    btnNotes.setAttribute("aria-expanded", "false");
  }
}

function renderTabs() {
  const list = document.getElementById("session-tab-list");
  list.innerHTML = "";
  for (const s of panelState.sessions) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "session-tab";
    tab.dataset.id = s.id;
    tab.setAttribute("aria-selected", s.id === panelState.activeId ? "true" : "false");

    const title = document.createElement("span");
    title.className = "session-tab-title";
    title.textContent = s.title || "Chat";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "session-tab-close";
    close.dataset.closeId = s.id;
    close.title = "Close tab";
    close.setAttribute("aria-label", "Close tab");
    close.textContent = "×";

    tab.appendChild(title);
    tab.appendChild(close);
    list.appendChild(tab);
  }
}

/**
 * Rebuild the message list from `chatHistory` (assistant = markdown).
 */
function renderChat() {
  const chat = document.getElementById("chat");
  chat.innerHTML = "";

  for (const m of chatHistory) {
    const div = document.createElement("div");
    div.className = `bubble ${m.role}${m.role === "assistant" ? " md-bubble" : ""}`;

    const roleEl = document.createElement("div");
    roleEl.className = "role";
    roleEl.textContent = m.role === "user" ? "You" : "Assistant";
    div.appendChild(roleEl);

    if (m.role === "user" && m.hint) {
      const h = document.createElement("div");
      h.className = "hintline";
      h.textContent = m.hint;
      div.appendChild(h);
    }

    const body = document.createElement("div");
    body.className = "body";
    if (m.role === "assistant") {
      body.innerHTML = renderMarkdown(m.content);
    } else {
      body.textContent = m.content;
    }
    div.appendChild(body);
    chat.appendChild(div);
  }
  chat.scrollTop = chat.scrollHeight;
}

function syncActiveSessionTitle() {
  const s = activeSession();
  if (!s || s.titleManual) return;
  s.title = deriveTitle(s.messages);
}

/**
 * After an assistant message, refresh tab title via AI when enabled; otherwise derive from first line.
 */
async function refreshTabTitleAfterAssistantReply() {
  const s = activeSession();
  if (!s || s.titleManual) return;
  const settings = await loadSettings();
  if (settings.autoAiTabTitles === false) {
    syncActiveSessionTitle();
    renderTabs();
    await persistPanelState();
    return;
  }
  if (s.messages.length === 0) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_TAB_TITLE",
      messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    if (res?.ok && res.title) {
      s.title = res.title;
    } else {
      syncActiveSessionTitle();
    }
  } catch {
    syncActiveSessionTitle();
  }
  renderTabs();
  await persistPanelState();
}

async function suggestTabTitleForSession(sessionId) {
  const s = panelState.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (s.messages.length === 0) {
    setStatus("Nothing to name yet.");
    return;
  }
  setStatus("Suggesting title…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_TAB_TITLE",
      messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    if (!res?.ok) throw new Error(res?.error || "Title request failed");
    if (res.title) {
      s.title = res.title;
      s.titleManual = false;
      renderTabs();
      await persistPanelState();
    }
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e));
  }
}

function startTabRename(sessionId) {
  const tab = document.querySelector(`.session-tab[data-id="${sessionId}"]`);
  const titleEl = tab?.querySelector(".session-tab-title");
  if (!titleEl) return;
  const s = panelState.sessions.find((x) => x.id === sessionId);
  if (!s) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-tab-title-input";
  input.value = s.title;
  let cancelled = false;

  const finish = () => {
    if (cancelled) return;
    const v = input.value.trim();
    if (v) {
      s.title = v;
      s.titleManual = true;
    }
    titleEl.textContent = s.title;
    if (input.parentNode) input.replaceWith(titleEl);
    void persistPanelState();
    renderTabs();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      cancelled = true;
      if (input.parentNode) input.replaceWith(titleEl);
      renderTabs();
    }
  });
  input.addEventListener("blur", finish);
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function hideTabContextMenu() {
  const menu = document.getElementById("tab-context-menu");
  menu.classList.add("is-hidden");
  menu.setAttribute("aria-hidden", "true");
}

function setTitlebarMenuOpen(open) {
  const panel = document.getElementById("titlebar-menu-panel");
  const btn = document.getElementById("btn-titlebar-menu");
  if (!panel || !btn) return;
  if (open) {
    panel.classList.remove("is-hidden");
    panel.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
  } else {
    panel.classList.add("is-hidden");
    panel.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
  }
}

async function getActiveBrowserTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function readSelectionForActiveTab() {
  const tabId = await getActiveBrowserTabId();
  if (tabId == null) return { text: "", tabId: null };

  const data = await chrome.storage.session.get(SESSION_SELECTIONS);
  const bucket = data[SESSION_SELECTIONS]?.byTab || {};
  const entry = bucket[String(tabId)];
  return { text: entry?.text?.trim() || "", tabId };
}

async function refreshSelectionQuote() {
  const wrap = document.getElementById("selection-quote");
  const body = document.getElementById("selection-text");
  const { text } = await readSelectionForActiveTab();

  if (!text) {
    wrap.classList.add("is-hidden");
    body.textContent = "";
    return;
  }
  wrap.classList.remove("is-hidden");
  body.textContent = text;
}

document.getElementById("btn-clear-selection").addEventListener("click", async () => {
  const tabId = await getActiveBrowserTabId();
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_SELECTION", tabId });
  await refreshSelectionQuote();
});

async function sendChat() {
  const input = document.getElementById("input");
  const typed = (input.value || "").trim();
  if (!typed) return;

  const { text: quoted } = await readSelectionForActiveTab();
  const fullUser =
    quoted.length > 0
      ? `Selected text from page:\n"""\n${quoted}\n"""\n\n${typed}`
      : typed;

  input.value = "";
  chatHistory.push({
    role: "user",
    content: fullUser,
    hint: quoted.length > 0 ? "Includes page selection in the prompt" : undefined,
  });
  syncActiveSessionTitle();
  renderChat();
  await persistPanelState();
  renderTabs();

  setStatus("Thinking…");

  const skillId = getSelectedSkillId();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "CHAT",
      skillId,
      messages: chatHistory.map((m) => ({ role: m.role, content: m.content })),
    });
    if (!res?.ok) throw new Error(res?.error || "Request failed");
    chatHistory.push({ role: "assistant", content: res.text });
    renderChat();
    await persistPanelState();
    await refreshTabTitleAfterAssistantReply();
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e));
    chatHistory.push({ role: "assistant", content: `Error: ${String(e?.message || e)}` });
    syncActiveSessionTitle();
    renderChat();
    await persistPanelState();
    renderTabs();
  }
}

async function summarizePage() {
  setStatus("Reading page & summarizing…");
  const extra = (document.getElementById("summarize-extra")?.value || "").trim();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_TAB",
      tabId: tab?.id,
      extraInstructions: extra,
    });
    if (!res?.ok) throw new Error(res?.error || "Summarize failed");
    const header = res.meta ? `**${res.meta.title}**\n${res.meta.url}\n\n` : "";
    const full = header + res.text;
    chatHistory.push({ role: "assistant", content: full });
    renderChat();
    await persistPanelState();
    await refreshTabTitleAfterAssistantReply();
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e));
    chatHistory.push({ role: "assistant", content: `Error: ${String(e?.message || e)}` });
    syncActiveSessionTitle();
    renderChat();
    await persistPanelState();
    renderTabs();
  }
}

function switchSession(id) {
  const next = panelState.sessions.find((s) => s.id === id);
  if (!next) return;
  panelState.activeId = id;
  chatHistory = next.messages;
  renderTabs();
  renderChat();
  void persistPanelState();
}

async function createSession() {
  const id = crypto.randomUUID();
  panelState.sessions.push({ id, title: "New chat", messages: [], titleManual: false });
  panelState.activeId = id;
  chatHistory = panelState.sessions[panelState.sessions.length - 1].messages;
  document.getElementById("input").value = "";
  renderTabs();
  renderChat();
  await persistPanelState();
}

async function closeSession(id) {
  const idx = panelState.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  panelState.sessions.splice(idx, 1);
  if (panelState.sessions.length === 0) {
    const nid = crypto.randomUUID();
    panelState.sessions.push({ id: nid, title: "New chat", messages: [], titleManual: false });
    panelState.activeId = nid;
    chatHistory = panelState.sessions[0].messages;
  } else if (panelState.activeId === id) {
    const next = panelState.sessions[Math.min(idx, panelState.sessions.length - 1)];
    panelState.activeId = next.id;
    chatHistory = next.messages;
  }
  hideTabContextMenu();
  renderTabs();
  renderChat();
  await persistPanelState();
}

document.getElementById("session-tab-list").addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const closeId = t.closest(".session-tab-close")?.getAttribute("data-close-id");
  if (closeId) {
    e.stopPropagation();
    void closeSession(closeId);
    return;
  }
  const tab = t.closest(".session-tab");
  const id = tab?.getAttribute("data-id");
  if (id) switchSession(id);
});

document.getElementById("btn-new-session").addEventListener("click", () => {
  void createSession();
});

document.getElementById("btn-toggle-skills").addEventListener("click", () => {
  panelState.ui.skillsOpen = !panelState.ui.skillsOpen;
  applyUiChrome();
  void persistPanelState();
});

document.getElementById("session-tab-list").addEventListener("dblclick", (e) => {
  const title = e.target.closest(".session-tab-title");
  if (!title) return;
  e.preventDefault();
  e.stopPropagation();
  const id = title.closest(".session-tab")?.getAttribute("data-id");
  if (id) startTabRename(id);
});

let tabContextSessionId = null;

document.getElementById("session-tab-list").addEventListener("contextmenu", (e) => {
  const closeBtn = e.target.closest(".session-tab-close");
  if (closeBtn) return;
  const tab = e.target.closest(".session-tab");
  if (!tab) return;
  e.preventDefault();
  const id = tab.getAttribute("data-id");
  if (!id) return;
  tabContextSessionId = id;
  setTitlebarMenuOpen(false);
  const menu = document.getElementById("tab-context-menu");
  menu.classList.remove("is-hidden");
  menu.setAttribute("aria-hidden", "false");
  const pad = 8;
  const mw = menu.offsetWidth || 168;
  const mh = menu.offsetHeight || 72;
  const x = Math.min(e.clientX, window.innerWidth - mw - pad);
  const y = Math.min(e.clientY, window.innerHeight - mh - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
});

document.getElementById("tab-context-menu").addEventListener("click", (e) => {
  const item = e.target.closest("[data-action]");
  const action = item?.getAttribute("data-action");
  if (!action || !tabContextSessionId) return;
  e.stopPropagation();
  const id = tabContextSessionId;
  hideTabContextMenu();
  if (action === "rename") startTabRename(id);
  if (action === "ai-title") void suggestTabTitleForSession(id);
});

document.getElementById("btn-titlebar-menu")?.addEventListener("click", (e) => {
  e.stopPropagation();
  hideTabContextMenu();
  const panel = document.getElementById("titlebar-menu-panel");
  if (!panel) return;
  setTitlebarMenuOpen(panel.classList.contains("is-hidden"));
});

document.addEventListener("click", (e) => {
  if (e.target.closest("#tab-context-menu")) return;
  hideTabContextMenu();
  if (e.target.closest("#btn-titlebar-menu")) return;
  setTitlebarMenuOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideTabContextMenu();
  setTitlebarMenuOpen(false);
});

document.getElementById("btn-toggle-summary-notes").addEventListener("click", () => {
  panelState.ui.summaryNotesOpen = !panelState.ui.summaryNotesOpen;
  applyUiChrome();
  void persistPanelState();
});

document.getElementById("btn-reload").addEventListener("click", async () => {
  const cur = activeSession();
  if (cur) cur.titleManual = false;
  chatHistory.length = 0;
  document.getElementById("input").value = "";
  document.getElementById("summarize-extra").value = "";
  syncActiveSessionTitle();
  renderChat();
  renderTabs();
  setStatus("");
  await persistPanelState();
});

const skillDialog = document.getElementById("skill-dialog");
const skillForm = document.getElementById("skill-form");
let editingSkillId = null;

function openSkillDialog(skill) {
  editingSkillId = skill?.id || null;
  document.getElementById("skill-dialog-title").textContent = skill ? "Edit skill" : "New skill";
  document.getElementById("skill-name").value = skill?.name || "";
  document.getElementById("skill-prompt").value = skill?.systemPrompt || "";
  skillDialog.showModal();
}

document.getElementById("btn-skill-add").addEventListener("click", () => openSkillDialog(null));

document.getElementById("btn-skill-edit").addEventListener("click", async () => {
  const id = getSelectedSkillId();
  if (!id) {
    setStatus("Select a skill to edit.");
    return;
  }
  const settings = await loadSettings();
  const skills = settings.skills || [];
  const s = skills.find((x) => x.id === id);
  if (s) openSkillDialog(s);
});

document.getElementById("btn-skill-delete").addEventListener("click", async () => {
  const id = getSelectedSkillId();
  if (!id) {
    setStatus("Select a skill to delete.");
    return;
  }
  const settings = await loadSettings();
  const skills = (settings.skills || []).filter((x) => x.id !== id);
  await saveSettings({ skills });
  await refreshSkillSelect();
  setStatus("Skill removed.");
});

skillForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("skill-name").value.trim();
  const systemPrompt = document.getElementById("skill-prompt").value;
  const settings = await loadSettings();
  const skills = [...(settings.skills || [])];
  if (editingSkillId) {
    const i = skills.findIndex((x) => x.id === editingSkillId);
    if (i >= 0) skills[i] = { ...skills[i], name, systemPrompt };
  } else {
    const id = crypto.randomUUID();
    skills.push({ id, name, systemPrompt });
  }
  await saveSettings({ skills });
  await refreshSkillSelect();
  if (editingSkillId) {
    document.getElementById("skill-select").value = editingSkillId;
  } else {
    const last = skills[skills.length - 1];
    if (last) document.getElementById("skill-select").value = last.id;
  }
  skillDialog.close();
  setStatus("Skill saved.");
});

document.getElementById("skill-cancel").addEventListener("click", () => skillDialog.close());

document.getElementById("btn-send").addEventListener("click", sendChat);
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

document.getElementById("btn-summarize").addEventListener("click", summarizePage);

document.getElementById("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function boot() {
  await loadPanelState();
  applyUiChrome();
  renderTabs();
  renderChat();
  await refreshSkillSelect();
  await refreshSelectionQuote();
}

boot().catch((e) => setStatus(String(e)));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes[STORAGE_KEY] || changes[STORAGE_LEGACY])) {
    refreshSkillSelect().catch(() => {});
  }
  if (area === "session" && changes[SESSION_SELECTIONS]) {
    refreshSelectionQuote().catch(() => {});
  }
  if (area === "local" && changes[LOCAL_PANEL_KEY]) {
    /* optional: merge remote updates */
  }
});

chrome.tabs.onActivated.addListener(() => {
  refreshSelectionQuote().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (t?.id === tabId) refreshSelectionQuote().catch(() => {});
});
