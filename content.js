/**
 * Content script: forwards the current text selection to the background worker so
 * the side panel can show a “quoted selection” strip above the composer.
 *
 * Debounced to avoid spamming messages while the user drags the selection.
 */

(function initSelectionBridge() {
  const MAX_LEN = 50_000;
  /** @type {string | null} Last payload sent — skip duplicates to reduce traffic on heavy editors (Word Online, etc.). */
  let lastSent = null;
  let timer = null;

  function pushSelection() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      let text = "";
      try {
        text = window.getSelection()?.toString() ?? "";
      } catch {
        text = "";
      }
      text = text.trim();
      if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + "\n…";

      if (text === lastSent) return;
      lastSent = text;

      chrome.runtime.sendMessage(
        {
          type: "SELECTION_TEXT",
          text,
          url: location.href,
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }, 400);
  }

  document.addEventListener("selectionchange", pushSelection);
  document.addEventListener("mouseup", pushSelection);
})();
