import { el } from "./04-dom.js";
import { activeConversation, basename, saveState, setStatus, uuid } from "./05-util.js";
export function getAttachments() {
  const c = activeConversation();
  if (!c) return [];
  if (!c.attachments) c.attachments = [];
  return c.attachments;
}
export function setAttachments(arr) {
  const c = activeConversation();
  if (!c) return;
  c.attachments = arr || [];
  saveState();
  renderAttachmentStrip();
}

// Render the attachment thumbnails above the composer.
export function renderAttachmentStrip() {
  const strip = el.attachmentStrip;
  if (!strip) return;
  const atts = getAttachments();
  if (!atts.length) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  for (const att of atts) {
    const thumb = document.createElement("div");
    thumb.className = "attachment-thumb";
    thumb.title = att.name || "attachment";
    if (att.kind === "image" && att.dataUrl) {
      const img = document.createElement("img");
      img.src = att.dataUrl;
      img.alt = att.name || "image";
      thumb.appendChild(img);
      thumb.addEventListener("click", () => openImagePreview(att.dataUrl));
    } else {
      const icon = document.createElement("span");
      icon.className = "att-file-icon";
      icon.textContent = "📄";
      thumb.appendChild(icon);
      const nm = document.createElement("span");
      nm.className = "att-name";
      nm.textContent = att.name || "file";
      thumb.appendChild(nm);
    }
    const rm = document.createElement("button");
    rm.className = "att-remove";
    rm.type = "button";
    rm.innerHTML = "&times;";
    rm.title = "Remove attachment";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAttachment(att.id);
    });
    thumb.appendChild(rm);
    strip.appendChild(thumb);
  }
}

export function removeAttachment(id) {
  const atts = getAttachments().filter((a) => a.id !== id);
  setAttachments(atts);
}

// Open the full-size image preview modal.
export function openImagePreview(dataUrl) {
  if (!el.imagePreviewModal || !el.imagePreviewImg) return;
  el.imagePreviewImg.src = dataUrl;
  el.imagePreviewModal.classList.remove("hidden");
}
export function closeImagePreview() {
  if (!el.imagePreviewModal) return;
  el.imagePreviewModal.classList.add("hidden");
  el.imagePreviewImg.src = "";
}

// Add a file via the file picker (fileAccess openDialog).
export async function addFileFromPicker() {
  try {
    const path = await window.chatoss.files.openDialog({ multiple: false });
    if (!path) return; // cancelled/denied
    await addFileByPath(path);
  } catch (e) {
    console.warn("addFileFromPicker", e);
    setStatus("Could not open that file: " + (e && e.message ? e.message : String(e)));
  }
}

// Add a file from a known path: read its bytes, detect if it's an image.
export async function addFileByPath(path) {
  const name = basename(path);
  const ext = name.split(".").pop().toLowerCase();
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
  if (imageExts.includes(ext)) {
    // Image: read as base64 and build a data URL.
    try {
      const b64 = await window.chatoss.files.readFile(path, { binary: true });
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext;
      const dataUrl = "data:" + mime + ";base64," + b64;
      addAttachment({ id: uuid(), name, kind: "image", dataUrl });
    } catch (e) {
      console.warn("readFile image", e);
      setStatus("Could not read that image: " + (e && e.message ? e.message : String(e)));
    }
  } else {
    // Text/code file: read as text and store for embedding in the message.
    try {
      const text = await window.chatoss.files.readFile(path);
      addAttachment({ id: uuid(), name, kind: "file", text, path });
    } catch (e) {
      // Binary non-image file: store just the path/name as context.
      console.warn("readFile", e);
      addAttachment({ id: uuid(), name, kind: "file", text: null, path });
    }
  }
}

// Add a dropped file (from fileDrop onDrop). The drop callback gives file
// objects with .text() and .arrayBuffer() methods, NOT paths.
export async function addDroppedFile(file) {
  const name = file.name || "dropped-file";
  const type = file.type || "";
  if (type.startsWith("image/")) {
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const dataUrl = "data:" + type + ";base64," + b64;
      addAttachment({ id: uuid(), name, kind: "image", dataUrl });
    } catch (e) { console.warn("dropped image", e); }
  } else {
    try {
      const text = await file.text();
      addAttachment({ id: uuid(), name, kind: "file", text });
    } catch (e) {
      addAttachment({ id: uuid(), name, kind: "file", text: null });
    }
  }
}

export function addAttachment(att) {
  const atts = getAttachments();
  atts.push(att);
  saveState();
  renderAttachmentStrip();
}

// Convert an ArrayBuffer to a base64 string (for dropped image data URLs).
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Build the content for runTurn: if there are image attachments, return an
// array of text + image parts (multimodal); otherwise return the plain string.
export function buildMessageContent(userText) {
  const atts = getAttachments();
  const images = atts.filter((a) => a.kind === "image" && a.dataUrl);
  const files = atts.filter((a) => a.kind === "file");

  // Embed file contents into the text portion.
  let text = userText;
  if (files.length) {
    const fileBlocks = [];
    for (const f of files) {
      if (f.text) {
        fileBlocks.push("--- File: " + f.name + " ---\n" + f.text);
      } else {
        fileBlocks.push("--- File: " + f.name + " (binary — path: " + (f.path || "?") + ") ---");
      }
    }
    text = text + "\n\n[Attached files]\n" + fileBlocks.join("\n\n");
  }

  // If there are images, send multimodal content (text + image_url parts).
  if (images.length) {
    const parts = [{ type: "text", text }];
    for (const img of images) {
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
    return parts;
  }
  return text;
}

// Clear attachments after a message is sent.
export function clearAttachments() {
  setAttachments([]);
}

// ---------- Copy conversation ----------
// Serialize a conversation's full message history (user + assistant + system,
// including thinking and tool-call activity) into readable plain text.
export function conversationToText(c) {
  if (!c || !c.messages || !c.messages.length) return "";
  const parts = [];
  for (const m of c.messages) {
    const role = m.role || "system";
    const label = m.event ? "Event" : (role === "user" ? "You" : role === "assistant" ? "Assistant" : "System");
    let block = label + ":\n" + (m.content || "");
    if (m.thinking) block += "\n\nThinking:\n" + m.thinking;
    if (m.toolCalls && m.toolCalls.length) {
      const lines = m.toolCalls.map((t) => {
        let s = "• " + t.name + "(" + (t.args ? JSON.stringify(t.args) : "") + ")";
        if (t.result !== undefined) s += "\n  " + (typeof t.result === "string" ? t.result : JSON.stringify(t.result));
        if (t.error) s += "\n  " + t.error;
        return s;
      });
      block += "\n\nTools:\n" + lines.join("\n");
    }
    parts.push(block);
  }
  return parts.join("\n\n");
}

export let copyConvTimer = null;
// Enable/disable the toolbar button to match whether a conversation is loaded.
export function syncCopyConvBtn() {
  const btn = el.copyConvBtn;
  if (!btn) return;
  const c = activeConversation();
  const hasContent = !!(c && c.messages && c.messages.length);
  btn.disabled = !hasContent;
  if (!hasContent) {
    btn.classList.remove("copied");
    const lab = btn.querySelector(".copy-conv-label");
    if (lab) lab.textContent = "Copy";
  }
}
// Copy the ENTIRE active conversation to the clipboard, with a brief
// "Copied!" confirmation on the button. No-op when no conversation is loaded.
export async function copyConversation() {
  const c = activeConversation();
  if (!c || !c.messages || !c.messages.length) return; // no conversation → no-op
  const text = conversationToText(c);
  if (!text) return;
  try {
    await window.chatoss.clipboard.writeText(text);
  } catch (e) {
    console.warn("clipboard write", e);
    setStatus("Clipboard unavailable — enable it in Permissions.");
    return;
  }
  const btn = el.copyConvBtn;
  if (!btn) return;
  const lab = btn.querySelector(".copy-conv-label");
  if (lab) lab.textContent = "Copied!";
  btn.classList.add("copied");
  btn.disabled = true;
  clearTimeout(copyConvTimer);
  copyConvTimer = setTimeout(() => {
    btn.classList.remove("copied");
    if (lab) lab.textContent = "Copy";
    syncCopyConvBtn();
  }, 1600);
}

// ---------- Build system prompt ----------
