/**
 * ColorAI side panel: multi-session chat (local storage), markdown rendering,
 * selection quote, skills, and collapsible message / summary areas.
 */

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
 * @typedef {{ id: string; title: string; messages: ChatMsg[] }} PanelSession
 * @typedef {{ sessions: PanelSession[]; activeId: string; ui: { chatCollapsed: boolean; summaryNotesOpen: boolean } }} PanelState
 */

/** @type {PanelState} */
let panelState = {
  sessions: [],
  activeId: "",
  ui: { chatCollapsed: false, summaryNotesOpen: false },
};

/** Points at the active session’s `messages` array */
/** @type {ChatMsg[]} */
let chatHistory = [];

async function loadSettings() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, STORAGE_LEGACY]);
  return data[STORAGE_KEY] || data[STORAGE_LEGACY] || {};
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
        chatCollapsed: !!raw.ui?.chatCollapsed,
        summaryNotesOpen: !!raw.ui?.summaryNotesOpen,
      },
    };
  } else {
    const id = crypto.randomUUID();
    panelState = {
      sessions: [{ id, title: "New chat", messages: [] }],
      activeId: id,
      ui: { chatCollapsed: false, summaryNotesOpen: false },
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
  const card = document.getElementById("chat-card");
  const btnChat = document.getElementById("btn-toggle-chat");
  const notesPanel = document.getElementById("summary-notes-panel");
  const btnNotes = document.getElementById("btn-toggle-summary-notes");

  if (panelState.ui.chatCollapsed) {
    card.classList.add("is-chat-collapsed");
    btnChat.setAttribute("aria-expanded", "false");
  } else {
    card.classList.remove("is-chat-collapsed");
    btnChat.setAttribute("aria-expanded", "true");
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
  if (!s) return;
  s.title = deriveTitle(s.messages);
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
    syncActiveSessionTitle();
    renderChat();
    await persistPanelState();
    renderTabs();
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e));
    chatHistory.push({ role: "assistant", content: `Error: ${String(e?.message || e)}` });
    renderChat();
    await persistPanelState();
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
    syncActiveSessionTitle();
    renderChat();
    await persistPanelState();
    renderTabs();
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e));
    chatHistory.push({ role: "assistant", content: `Error: ${String(e?.message || e)}` });
    renderChat();
    await persistPanelState();
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
  panelState.sessions.push({ id, title: "New chat", messages: [] });
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
    panelState.sessions.push({ id: nid, title: "New chat", messages: [] });
    panelState.activeId = nid;
    chatHistory = panelState.sessions[0].messages;
  } else if (panelState.activeId === id) {
    const next = panelState.sessions[Math.min(idx, panelState.sessions.length - 1)];
    panelState.activeId = next.id;
    chatHistory = next.messages;
  }
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

document.getElementById("btn-toggle-chat").addEventListener("click", () => {
  panelState.ui.chatCollapsed = !panelState.ui.chatCollapsed;
  applyUiChrome();
  void persistPanelState();
});

document.getElementById("btn-toggle-summary-notes").addEventListener("click", () => {
  panelState.ui.summaryNotesOpen = !panelState.ui.summaryNotesOpen;
  applyUiChrome();
  void persistPanelState();
});

document.getElementById("btn-reload").addEventListener("click", async () => {
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
