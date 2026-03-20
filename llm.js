/**
 * LLM adapters for ColorAI: Ollama (local), OpenAI, and Google Gemini.
 * Shared by the service worker (chat/summarize) and options page (merge defaults).
 */

/** @typedef {{ role: 'system' | 'user' | 'assistant'; content: string }} ChatMessage */

/** Default settings merged with user overrides from chrome.storage.sync */
const DEFAULT_SETTINGS = {
  provider: "ollama",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
};

/**
 * @param {Record<string, unknown>} raw
 * @returns {typeof DEFAULT_SETTINGS & Record<string, unknown>}
 */
export function mergeSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...raw };
}

/** Strip trailing slashes from Ollama base URL */
function normalizeOllamaUrl(base) {
  const u = (base || "").replace(/\/+$/, "");
  return u || DEFAULT_SETTINGS.ollamaBaseUrl;
}

/**
 * Build a helpful error when Ollama returns HTTP errors. Chrome extensions send
 * `Origin: chrome-extension://…`; Ollama ≥ recent versions return **403** unless that
 * origin is allowed via the `OLLAMA_ORIGINS` environment variable.
 * @param {number} status
 * @param {string} bodySnippet
 */
function formatOllamaHttpError(status, bodySnippet) {
  const detail = (bodySnippet || "").trim() || "(empty response body)";
  if (status === 403) {
    return [
      "Ollama returned 403: the browser sends Origin chrome-extension://… and Ollama rejects it by default.",
      'Option A — restart Ollama with: OLLAMA_ORIGINS="chrome-extension://*" ollama serve',
      "Option B — no Ollama config: run `node scripts/colorai-ollama-proxy.mjs` and set ColorAI base URL to http://127.0.0.1:11435",
      `Details: ${detail.slice(0, 300)}`,
    ].join(" ");
  }
  return `Ollama ${status}: ${detail.slice(0, 500)}`;
}

/**
 * Send a chat completion using whichever provider is selected in settings.
 * @param {ChatMessage[]} messages
 * @param {Record<string, unknown>} settings
 */
export async function completeChat(messages, settings) {
  const s = mergeSettings(settings);
  switch (s.provider) {
    case "openai":
      return completeOpenAI(messages, s);
    case "gemini":
      return completeGemini(messages, s);
    case "ollama":
    default:
      return completeOllama(messages, s);
  }
}

/** @param {typeof DEFAULT_SETTINGS & Record<string, unknown>} s */
async function completeOllama(messages, s) {
  const url = `${normalizeOllamaUrl(s.ollamaBaseUrl)}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: s.ollamaModel || "llama3.2",
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatOllamaHttpError(res.status, t));
  }
  const data = await res.json();
  const text = data?.message?.content ?? data?.response ?? "";
  if (!text) throw new Error("Ollama returned an empty reply.");
  return text;
}

/** @param {typeof DEFAULT_SETTINGS & Record<string, unknown>} s */
async function completeOpenAI(messages, s) {
  const key = (s.openaiApiKey || "").trim();
  if (!key) throw new Error("OpenAI API key is not set. Open extension options.");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: s.openaiModel || "gpt-4o-mini",
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("OpenAI returned an empty reply.");
  return text;
}

/** @param {typeof DEFAULT_SETTINGS & Record<string, unknown>} s */
async function completeGemini(messages, s) {
  const key = (s.geminiApiKey || "").trim();
  if (!key) throw new Error("Gemini API key is not set. Open extension options.");

  const model = (s.geminiModel || "gemini-2.0-flash").replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;

  let systemText = "";
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemText += (systemText ? "\n" : "") + m.content;
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  const body = {
    contents,
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
  if (!text) throw new Error("Gemini returned an empty reply.");
  return text;
}

// --- List models (settings “Test” / discovery) --------------------------------

/**
 * Fetch model IDs the user can pick, for the active provider.
 * @param {Record<string, unknown>} settings Partial or full settings (e.g. from options form)
 */
export async function listModelsForProvider(settings) {
  const s = mergeSettings(settings);
  switch (s.provider) {
    case "openai":
      return listOpenAIModels(s);
    case "gemini":
      return listGeminiModels(s);
    case "ollama":
    default:
      return listOllamaModels(s);
  }
}

/** @param {typeof DEFAULT_SETTINGS & Record<string, unknown>} s */
async function listOllamaModels(s) {
  const base = normalizeOllamaUrl(s.ollamaBaseUrl);
  const res = await fetch(`${base}/api/tags`, { method: "GET" });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatOllamaHttpError(res.status, t));
  }
  const data = await res.json();
  const names = (data?.models || []).map((m) => m.name).filter(Boolean);
  return [...new Set(names)].sort();
}

/** Prefer chat/completion model IDs; OpenAI returns a large catalog */
async function listOpenAIModels(s) {
  const key = (s.openaiApiKey || "").trim();
  if (!key) throw new Error("OpenAI API key is required to list models.");

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const ids = (data?.data || []).map((m) => m.id).filter(Boolean);

  const isChatLike = (id) =>
    /^gpt-4|^gpt-3\.5|^gpt-5|^o1|^o3|^chatgpt-4o|^davinci-002|^babbage-002/.test(id) ||
    id.includes("instruct") ||
    id.includes("turbo");

  const filtered = ids.filter(isChatLike);
  const list = filtered.length ? filtered : ids;
  const sorted = [...new Set(list)].sort();
  /** OpenAI returns hundreds of entries; cap for a usable dropdown */
  return sorted.slice(0, 400);
}

/** @param {typeof DEFAULT_SETTINGS & Record<string, unknown>} s */
async function listGeminiModels(s) {
  const key = (s.geminiApiKey || "").trim();
  if (!key) throw new Error("Gemini API key is required to list models.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const models = data?.models || [];
  const names = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
  return [...new Set(names)].sort();
}
