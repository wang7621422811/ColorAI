/**
 * ColorAI options page: provider selection, credentials, model pickers, and
 * “Test & list models” which calls the background worker (see `LIST_MODELS`).
 */

import { mergeSettings } from "./llm.js";

const STORAGE_KEY = "colorAiSettings";
const STORAGE_LEGACY = "sideAiSettings";

function $(id) {
  return document.getElementById(id);
}

function showPanels(provider) {
  $("panel-ollama").style.display = provider === "ollama" ? "block" : "none";
  $("panel-openai").style.display = provider === "openai" ? "block" : "none";
  $("panel-gemini").style.display = provider === "gemini" ? "block" : "none";
}

function readProviderFromForm() {
  const r = document.querySelector('input[name="provider"]:checked');
  return r?.value || "ollama";
}

/**
 * Build a draft settings object from the form so we can test listing models
 * before the user clicks Save.
 */
function draftFromForm() {
  return {
    provider: readProviderFromForm(),
    ollamaBaseUrl: $("ollamaBaseUrl").value.trim(),
    ollamaModel: $("ollamaModel").value,
    openaiApiKey: $("openaiApiKey").value.trim(),
    openaiModel: $("openaiModel").value,
    geminiApiKey: $("geminiApiKey").value.trim(),
    geminiModel: $("geminiModel").value,
    preferredInstruction: $("preferredInstruction").value,
    autoAiTabTitles: $("autoAiTabTitles").checked,
  };
}

/**
 * Fill a `<select>` with model IDs, preserving `current` if missing from the list.
 * @param {HTMLSelectElement} el
 * @param {string[]} models
 * @param {string} current
 */
function populateModelSelect(el, models, current) {
  const set = new Set(models);
  if (current && !set.has(current)) {
    models = [current, ...models];
  }
  el.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = models.length ? "— Select a model —" : "— Fetch models first —";
  el.appendChild(placeholder);
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    el.appendChild(opt);
  }
  if (current && [...el.options].some((o) => o.value === current)) {
    el.value = current;
  }
}

/**
 * Ask the service worker to query the provider’s model list (Ollama tags, OpenAI /v1/models, Gemini list).
 */
async function fetchModelsForActiveProvider(statusEl) {
  statusEl.textContent = "Loading…";
  const draft = draftFromForm();
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_MODELS", draft });
    if (!res?.ok) throw new Error(res?.error || "Failed to list models");
    const models = res.models || [];
    const provider = draft.provider;

    if (provider === "ollama") {
      populateModelSelect($("ollamaModel"), models, $("ollamaModel").value);
    } else if (provider === "openai") {
      populateModelSelect($("openaiModel"), models, $("openaiModel").value);
    } else {
      populateModelSelect($("geminiModel"), models, $("geminiModel").value);
    }

    statusEl.textContent = `${models.length} models`;
    setTimeout(() => {
      statusEl.textContent = "";
    }, 4000);
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  }
}

document.querySelectorAll('input[name="provider"]').forEach((el) => {
  el.addEventListener("change", () => showPanels(readProviderFromForm()));
});

function selectProvider(value) {
  const r = document.querySelector(`input[name="provider"][value="${value}"]`);
  if (r) r.checked = true;
  showPanels(value);
}

/** Each test button switches to that provider first so the list matches the section you clicked. */
$("btn-test-ollama").addEventListener("click", () => {
  selectProvider("ollama");
  fetchModelsForActiveProvider($("test-status-ollama"));
});
$("btn-test-openai").addEventListener("click", () => {
  selectProvider("openai");
  fetchModelsForActiveProvider($("test-status-openai"));
});
$("btn-test-gemini").addEventListener("click", () => {
  selectProvider("gemini");
  fetchModelsForActiveProvider($("test-status-gemini"));
});

async function load() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, STORAGE_LEGACY]);
  const s = mergeSettings(data[STORAGE_KEY] || data[STORAGE_LEGACY] || {});

  const p = s.provider || "ollama";
  const radio = document.querySelector(`input[name="provider"][value="${p}"]`);
  if (radio) radio.checked = true;
  else document.querySelector('input[name="provider"][value="ollama"]').checked = true;

  $("ollamaBaseUrl").value = s.ollamaBaseUrl || "";
  $("openaiApiKey").value = s.openaiApiKey || "";
  $("geminiApiKey").value = s.geminiApiKey || "";

  $("preferredInstruction").value = s.preferredInstruction || "";
  $("autoAiTabTitles").checked = s.autoAiTabTitles !== false;

  populateModelSelect($("ollamaModel"), [], s.ollamaModel || "");
  if (s.ollamaModel) $("ollamaModel").value = s.ollamaModel;

  populateModelSelect($("openaiModel"), [], s.openaiModel || "");
  if (s.openaiModel) $("openaiModel").value = s.openaiModel;

  populateModelSelect($("geminiModel"), [], s.geminiModel || "");
  if (s.geminiModel) $("geminiModel").value = s.geminiModel;

  showPanels(readProviderFromForm());
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prev = await chrome.storage.sync.get([STORAGE_KEY, STORAGE_LEGACY]);
  const cur = prev[STORAGE_KEY] || prev[STORAGE_LEGACY] || {};

  const next = {
    ...cur,
    provider: readProviderFromForm(),
    ollamaBaseUrl: $("ollamaBaseUrl").value.trim(),
    ollamaModel: $("ollamaModel").value.trim(),
    openaiApiKey: $("openaiApiKey").value.trim(),
    openaiModel: $("openaiModel").value.trim(),
    geminiApiKey: $("geminiApiKey").value.trim(),
    geminiModel: $("geminiModel").value.trim(),
    preferredInstruction: $("preferredInstruction").value,
    autoAiTabTitles: $("autoAiTabTitles").checked,
  };

  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  if (prev[STORAGE_LEGACY]) {
    await chrome.storage.sync.remove(STORAGE_LEGACY);
  }

  $("save-status").textContent = "Saved.";
  setTimeout(() => {
    $("save-status").textContent = "";
  }, 2500);
});

load().catch((err) => {
  $("save-status").textContent = String(err?.message || err);
});
