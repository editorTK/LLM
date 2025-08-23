/* main.js — versión simplificada
 * - Sin o3
 * - Solo gpt-5-nano (rápido)
 * - Un solo archivo (sin imports)
 * - KV usando kv.del() para borrar
 * - Streaming en turnos posteriores y typewriter de respaldo
 * - Manejo de errores robusto y logs de humo
*/

//////////////////////////////
// Utilidades básicas      //
//////////////////////////////

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
}[c]));
const log = (...args) => console.log("[app]", ...args);

//////////////////////////////
// Referencias DOM         //
//////////////////////////////

// Layout principal
const chatEl = $("#chat");
const hero = $("#hero");

// Topbar / auth
const signInBtn = $("#signInBtn");

// Sidebar (chats)
const menuBtn = $("#menuBtn");
const sidebar = $("#sidebar");
const sidebarOverlay = $("#sidebarOverlay");
const closeSidebarBtn = $("#closeSidebarBtn");
const chatListEl = $("#chatList");
const chatSearchEl = $("#chatSearch");
const newChatBtn = $("#newChatBtn");
const prefsBtn = $("#prefsBtn"); // modal de personalización
const prefsModal = $("#prefsModal");
const prefsOverlay = $("#prefsOverlay");
const closePrefs = $("#closePrefs");
const savePrefsBtn = $("#savePrefs");
const prefCallYou = $("#prefCallYou");
const prefStyle = $("#prefStyle");

// Composer / herramientas
const form = $("#composer");
const input = $("#userInput");
const sendBtn = $("#sendBtn");
const toolsBtn = $("#toolsBtn");
const toolsModal = $("#toolsModal");
const toolsModalOverlay = $("#toolsModalOverlay");
const closeToolsModal = $("#closeToolsModal");

// Adjuntos
const uploadImgBtn = $("#uploadImgBtn");
const fileInput = $("#fileInput");
const attachRow = $("#attachRow");
const attachLabel = $("#attachLabel");
const attachThumb = $("#attachThumb");
const clearAttachBtn = $("#clearAttachBtn");

// Modal eliminar chat
const deleteModal = $("#deleteModal");
const deleteOverlay = $("#deleteOverlay");
const deleteText = $("#deleteText");
const cancelDeleteBtn = $("#cancelDeleteBtn");
const confirmDeleteBtn = $("#confirmDeleteBtn");

//////////////////////////////
// Markdown seguro         //
//////////////////////////////

if (window.marked) {
  marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
}
const mdRenderer = new (window.marked?.Renderer ?? function(){})();
if (mdRenderer.link) {
  mdRenderer.link = (href, title, text) =>
    `<a href="${href}"${title?` title="${title}"`:""} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
}
function renderMarkdown(md="") {
  try {
    const raw = window.marked ? marked.parse(md, { renderer: mdRenderer }) : md;
    return window.DOMPurify ? DOMPurify.sanitize(raw, { USE_PROFILES:{ html:true } }) : raw;
  } catch { return escapeHTML(md); }
}

//////////////////////////////
// Estado global           //
//////////////////////////////

const MODEL = "gpt-5-nano"; // ÚNICO modelo ahora
// URL base del backend Flask en Railway
const BACKEND_URL = "llm-production-ca64.up.railway.app"; // Reemplaza con tu URL pública
const INPUT_MAX_HEIGHT = 160;
const TIMEOUT_MS = 20000; // 20s

const state = {
  pendingImage: null,      // { path, name, preview }
  currentChatId: null,
  chatsIndex: [],          // [{ id, name, lastUser, updatedAt }]
  seq: 0,                  // invalida respuestas viejas
  prefs: { call_you: "", style: "" },
  messages: [],            // arr de {role, content}, primer elemento siempre "system"
  chatToDelete: null       // chat seleccionado para eliminar
};

//////////////////////////////
// Helpers UI               //
//////////////////////////////

function hideHero(){ hero?.classList.add("hidden"); }
function showHero(){ hero?.classList.remove("hidden"); }

function addUserBubble(text, imageUrl=null, imageName="") {
  const wrap = document.createElement("div");
  wrap.className = "flex justify-end";
  const bubble = document.createElement("div");
  bubble.className = "msg msg--user max-w-[85%] md:max-w-[75%] text-sm prose prose-invert prose-pre:whitespace-pre-wrap";
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = imageName || "imagen";
    img.className = "mb-2 rounded max-h-60 object-contain";
    img.addEventListener("error", () => {
      const fb = document.createElement("div");
      fb.className = "mb-2 text-xs text-sub";
      fb.textContent = imageName || "imagen";
      img.replaceWith(fb);
    });
    bubble.appendChild(img);
  }
  const textDiv = document.createElement("div");
  textDiv.innerHTML = renderMarkdown(text);
  bubble.appendChild(textDiv);
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollToBottom(); hideHero();
}

function addAssistantSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "flex justify-start";
  const bubble = document.createElement("div");
  bubble.className = "msg msg--assistant max-w-[85%] md:max-w-[75%] text-sm";
  bubble.innerHTML = `<span class="typing-dots"><span></span></span>`;
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function setAssistantMarkdown(node, md) {
  node.classList.add("prose","prose-invert","prose-pre:whitespace-pre-wrap");
  node.innerHTML = renderMarkdown(md);
  scrollToBottom();
}

function setAssistantError(node, title, detail="") {
  const extra = detail ? `<div class="mt-1 text-sub text-xs">${escapeHTML(detail)}</div>` : "";
  node.innerHTML = `<span class="text-red-400 font-medium">${escapeHTML(title)}</span>${extra}`;
}

function scrollToBottom(){
  requestAnimationFrame(()=>window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function autoresizeTextarea() {
  input.style.height = "auto";
  const next = Math.min(INPUT_MAX_HEIGHT, input.scrollHeight);
  input.style.height = next + "px";
  input.style.overflowY = (input.scrollHeight > INPUT_MAX_HEIGHT) ? "auto" : "hidden";
}

async function renderAssistantTypewriter(node, fullMD, cps = 40, step = 3) {
  const t0 = performance.now();
  let i = 0;
  const delay = Math.max(5, Math.round(1000 / cps));
  while (i < fullMD.length) {
    i += step;
    setAssistantMarkdown(node, fullMD.slice(0, i));
    await new Promise(r => setTimeout(r, delay));
  }
  setAssistantMarkdown(node, fullMD);
  return { text: fullMD, typeMs: performance.now() - t0 };
}

//////////////////////////////
// KV (persistencia)        //
//////////////////////////////

async function listChatMetas() {
  const entries = await puter.kv.list("chat:*", true);
  return entries
    .map(({ value }) => { try { return JSON.parse(value); } catch { return null; } })
    .filter(Boolean)
    .sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
}

async function saveChatMeta({ id, name, lastUser }) {
  const now = Date.now();
  const meta = { id, name: name || "Nuevo chat", lastUser: lastUser || "", updatedAt: now };
  await puter.kv.set(`chat:${id}`, JSON.stringify(meta));
  return meta;
}

async function saveConversation(id, messages) {
  await puter.kv.set(`chat:${id}:messages`, JSON.stringify(messages));
}

async function loadConversation(id) {
  const raw = await puter.kv.get(`chat:${id}:messages`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function deleteChatKV(id) {
  // API correcta: del()
  await puter.kv.del(`chat:${id}`);
  await puter.kv.del(`chat:${id}:messages`);
}

//////////////////////////////
// Personalización          //
//////////////////////////////

function buildSystemPrompt(prefs) {
  const base = [
    "Eres Gatito Sentimental, un personaje de las redes sociales que habla de psicología, superación personal y filosofía.",
    "Ofreces consejos y apoyo a los usuarios, pero tu asistencia también puede ser general, dependiendo de cómo se comporte el usuario.",
    "Puedes hablar con un toque informal con palabras coloquiales como 'bro'.",
    "Responde en español neutro y usa Markdown cuando aporte claridad."
  ];
  if (prefs?.call_you) base.push(`Llama al usuario "${prefs.call_you}".`);
  if (prefs?.style)    base.push(`Sigue estas pautas de estilo: ${prefs.style}`);
  return base.join(" ");
}

async function loadPrefs() {
  try {
    const raw = await puter.kv.get("prefs:chat");
    if (raw) return JSON.parse(raw);
  } catch {}
  return { call_you: "", style: "" };
}

async function savePrefs(p) {
  await puter.kv.set("prefs:chat", JSON.stringify(p));
}

function openPrefsModal() {
  prefCallYou.value = state.prefs.call_you || "";
  prefStyle.value = state.prefs.style || "";
  prefsModal.classList.remove("hidden");
}
function closePrefsModal() {
  prefsModal.classList.add("hidden");
}

function openDeleteModal(chat) {
  state.chatToDelete = chat;
  deleteText.textContent = `¿Seguro que deseas eliminar '${chat.name || "Chat sin título"}'?`;
  deleteModal.classList.remove("hidden");
}
function closeDeleteModal() {
  deleteModal.classList.add("hidden");
  state.chatToDelete = null;
}

//////////////////////////////
// Sidebar & lista chats    //
//////////////////////////////

function openSidebar() {
  sidebar.style.transform = "translateX(0)";
  sidebarOverlay.classList.remove("hidden");
}
function closeSidebar() {
  sidebar.style.transform = "translateX(-100%)";
  sidebarOverlay.classList.add("hidden");
}

function renderChatList(filter = "") {
  const q = (filter||"").trim().toLowerCase();
  chatListEl.innerHTML = "";
  const items = state.chatsIndex.filter(c =>
    !q || c.name?.toLowerCase().includes(q) || (c.lastUser?.toLowerCase().includes(q))
  );
  if (!items.length) {
    chatListEl.innerHTML = `<div class="px-4 py-3 text-sub text-sm">Sin resultados</div>`;
    return;
  }
  for (const c of items) {
    const row = document.createElement("div");
    row.innerHTML = `
      <button class="w-full text-left px-4 py-3 hover:bg-pane">
        <div class="text-sm font-medium truncate">${escapeHTML(c.name || "Chat sin título")}</div>
        <div class="text-xs text-sub truncate">${escapeHTML(c.lastUser || "")}</div>
      </button>`;
    const btn = row.querySelector("button");
    let pressTimer;
    let longPressed = false;
    const startPress = () => {
      pressTimer = setTimeout(() => { longPressed = true; openDeleteModal(c); }, 600);
    };
    const cancelPress = () => clearTimeout(pressTimer);
    btn.addEventListener("click", () => { if (!longPressed) openChat(c.id); longPressed = false; });
    btn.addEventListener("mousedown", startPress);
    btn.addEventListener("touchstart", startPress);
    ["mouseup","mouseleave","mouseout","touchend","touchcancel"].forEach(ev => btn.addEventListener(ev, cancelPress));
    chatListEl.appendChild(row);
  }
}

function newChat() {
  state.currentChatId = `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];
  chatEl.innerHTML = "";
  showHero();
  closeSidebar();
  input.focus();
}

async function openChat(id) {
  state.currentChatId = id;
  chatEl.innerHTML = "";
  const conv = await loadConversation(id);
  if (Array.isArray(conv) && conv.length) {
    state.messages = conv;
    for (const m of conv) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content :
          ((Array.isArray(m.content) ? m.content.find(x=>x.type==="text")?.text : "") || "");
        addUserBubble(text);
      } else if (m.role === "assistant") {
        const b = addAssistantSkeleton();
        const text = typeof m.content === "string" ? m.content :
          ((Array.isArray(m.content) ? m.content.find(x=>x.type==="text")?.text : "") || "");
        setAssistantMarkdown(b, text);
      }
    }
    hideHero();
  } else {
    state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];
    showHero();
  }
  closeSidebar();
}

//////////////////////////////
// Llamada a la IA          //
//////////////////////////////

function isFirstTurn(messages) {
  return !messages?.some(m => m.role === "assistant");
}

function pruneMessagesForBudget(messages, maxChars = 8000) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const head = messages[0];
  const rest = messages.slice(1);
  let total = JSON.stringify(head).length;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    const len = JSON.stringify(m).length;
    if (total + len > maxChars) break;
    total += len;
    kept.unshift(m);
  }
  return [head, ...kept];
}

function extractJSON(raw="") {
  const match = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[1] || match[0]); } catch { return {}; }
}

function buildMessagesFirstTurn(baseSystem, history, userText, pendingImage) {
  const instruction = `Responde ÚNICAMENTE con JSON válido, sin texto adicional.\nEstructura:\n{\n  "answer": "texto en Markdown con la respuesta al usuario",\n  "chat_name": "título breve (máx 60 caracteres) basado en su pregunta"\n}`;
  const base = [{ role: "system", content: baseSystem }, { role: "system", content: instruction }];
  const hist = history.slice(1);
  const user = pendingImage ? [{ type: "file", puter_path: pendingImage.path }, { type: "text", text: userText }] : userText;
  return [...base, ...hist, { role: "user", content: user }];
}

function buildMessagesNextTurns(baseSystem, history, userText, pendingImage) {
  const instruction = "Responde en Markdown. Sé claro y conciso.";
  const base = [{ role: "system", content: baseSystem }, { role: "system", content: instruction }];
  const hist = history.slice(1);
  const user = pendingImage ? [{ type: "file", puter_path: pendingImage.path }, { type: "text", text: userText }] : userText;
  return [...base, ...hist, { role: "user", content: user }];
}

// --- Backend helpers ---
async function callBackendNoStream(messages){
  const r = await fetch(`${BACKEND_URL}/chat`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ messages, stream:false })
  });
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || `HTTP ${r.status}`);
  return (await r.json()).text || "";
}

async function* sseReader(response){
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf=""; for(;;){
    const {value, done} = await reader.read(); if(done) break;
    buf += dec.decode(value, {stream:true});
    let i; while((i = buf.indexOf("\n\n")) >= 0){
      const evt = buf.slice(0,i).trim(); buf = buf.slice(i+2);
      if(!evt.startsWith("data:")) continue;
      const payload = evt.slice(5).trim(); if(payload === "[DONE]") return;
      try { yield JSON.parse(payload); } catch {}
    }
  }
}

async function callBackendStream(messages, onDelta){
  const r = await fetch(`${BACKEND_URL}/chat`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ messages, stream:true })
  });
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || `HTTP ${r.status}`);
  for await (const part of sseReader(r)) if(part?.text) onDelta(part.text);
}

function appendTimingTag(node, { model, genMs, typeMs, uploadMs }) {
  const tag = document.createElement("div");
  tag.className = "mt-1 text-[10px] text-sub";
  const parts = [
    `model:${model}`,
    `ia:${Math.round(genMs)}ms`,
    `render:${Math.round(typeMs)}ms`
  ];
  if (uploadMs != null) parts.push(`upload:${Math.round(uploadMs)}ms`);
  tag.textContent = parts.join(" · ");
  node.appendChild(tag);
}

// El backend ya entrega JSON parseado, no se requieren helpers extra.

//////////////////////////////
// Eventos principales      //
//////////////////////////////

// evitar recargas “por si acaso”
if (form) { form.setAttribute("action","javascript:void(0)"); form.setAttribute("novalidate",""); }

window.addEventListener("DOMContentLoaded", async () => {
  log("DOM listo (simple)");

  // Auth Puter (opcional)
  try {
    const signed = await puter.auth.isSignedIn();
    if (!signed) signInBtn?.classList.remove("hidden");
  } catch {}
  signInBtn?.addEventListener("click", async () => {
    try { await puter.auth.signIn(); signInBtn.classList.add("hidden"); }
    catch { alert("No se pudo iniciar sesión en Puter."); }
  });

  // Abrir/cerrar sidebar (SIN BLUR)
  menuBtn?.addEventListener("click", openSidebar);
  closeSidebarBtn?.addEventListener("click", closeSidebar);
  sidebarOverlay?.addEventListener("click", closeSidebar);

  // Modal herramientas (solo imagen)
  toolsBtn?.addEventListener("click", () => toolsModal.classList.remove("hidden"));
  closeToolsModal?.addEventListener("click", () => toolsModal.classList.add("hidden"));
  toolsModalOverlay?.addEventListener("click", () => toolsModal.classList.add("hidden"));

  // Modal Personalización
  prefsBtn?.addEventListener("click", openPrefsModal);
  prefsOverlay?.addEventListener("click", closePrefsModal);
  closePrefs?.addEventListener("click", closePrefsModal);
  savePrefsBtn?.addEventListener("click", async () => {
    state.prefs = {
      call_you: (prefCallYou.value || "").trim(),
      style: (prefStyle.value || "").trim()
    };
    await savePrefs(state.prefs);
    if (state.messages.length) state.messages[0] = { role: "system", content: buildSystemPrompt(state.prefs) };
    closePrefsModal();
  });

  // Buscador y “nuevo chat”
  chatSearchEl?.addEventListener("input", (e)=> renderChatList(e.target.value));
  newChatBtn?.addEventListener("click", newChat);

  // Adjuntos
  uploadImgBtn?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    const file = files[0];
    const previewUrl = URL.createObjectURL(file);
    try {
      const up0 = performance.now();
      const uploaded = await puter.fs.upload(files);
      const uploadMs = performance.now() - up0;
      const f = Array.isArray(uploaded) ? uploaded[0] : uploaded;
      state.pendingImage = { path: f.path, name: f.name || "imagen", preview: previewUrl, uploadMs };
      attachThumb.src = previewUrl;
      attachLabel.textContent = f.name || "imagen";
      attachRow.classList.remove("hidden");
    } catch (err) {
      URL.revokeObjectURL(previewUrl);
      alert("No se pudo subir la imagen.");
      console.error(err);
    } finally {
      fileInput.value = "";
    }
  });
  clearAttachBtn?.addEventListener("click", () => {
    if (state.pendingImage?.preview) URL.revokeObjectURL(state.pendingImage.preview);
    state.pendingImage = null;
    attachRow.classList.add("hidden");
  });

  // Modal eliminar chat
  deleteOverlay?.addEventListener("click", closeDeleteModal);
  cancelDeleteBtn?.addEventListener("click", closeDeleteModal);
  confirmDeleteBtn?.addEventListener("click", async () => {
    const c = state.chatToDelete;
    if (!c) return closeDeleteModal();
    await deleteChatKV(c.id);
    state.chatsIndex = state.chatsIndex.filter(x => x.id !== c.id);
    renderChatList(chatSearchEl.value || "");
    if (state.currentChatId === c.id) {
      state.currentChatId = null;
      chatEl.innerHTML = "";
      showHero();
      state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];
    }
    closeDeleteModal();
  });

  // Autoresize input + Enter para enviar
  input?.addEventListener("input", autoresizeTextarea);
  input?.addEventListener("keydown", (e)=> {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit?.() ?? sendBtn.click(); }
  });

  // Cargar prefs e índice
  state.prefs = await loadPrefs();
  state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];

  try {
    state.chatsIndex = await listChatMetas();
  } catch (e) {
    console.warn("No se pudo cargar índice de chats:", e);
  }
  renderChatList("");

  showHero();

  // Cierre con Esc
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSidebar();
      toolsModal?.classList.add("hidden");
      closePrefsModal();
      closeDeleteModal();
    }
  });
});

// Envío de mensaje
form?.addEventListener("submit", async (e) => {
  e.preventDefault(); e.stopPropagation();
  const text = input.value.trim();
  if (!text) return;

  if (!state.currentChatId) newChat();

  const img = state.pendingImage;
  addUserBubble(text, img?.preview || null, img?.name);
  const assistantBubble = addAssistantSkeleton();

  input.value = ""; input.style.height = "auto"; hideHero();

  const firstTurn = isFirstTurn(state.messages);
  const baseSystem = buildSystemPrompt(state.prefs);
  const history = pruneMessagesForBudget(state.messages);
  const msgs = firstTurn
    ? buildMessagesFirstTurn(baseSystem, history, text, img)
    : buildMessagesNextTurns(baseSystem, history, text, img);

  // almacenar mensaje de usuario para historial
  const userMsg = img
    ? { role: "user", content: [{ type: "file", puter_path: img.path }, { type: "text", text }] }
    : { role: "user", content: text };
  state.messages.push(userMsg);

  const uploadMs = img?.uploadMs ?? null;

  // Consumir adjunto
  state.pendingImage = null;
  attachRow?.classList.add("hidden");
  if (img?.preview) URL.revokeObjectURL(img.preview);

  const mySeq = ++state.seq;
  const t0 = performance.now();
  log("IA: inicio consulta");
  const slowTimer = setTimeout(() => {
    assistantBubble.innerHTML = '<span class="text-sub text-xs">El modelo está tardando…</span>';
  }, 10000);

  let answer = "";
  let chatName = "";
  let genMs = 0;
  let typeMs = 0;

  try {
    if (!firstTurn) {
      try {
        let gotFirst = false;
        await callBackendStream(msgs, delta => {
          if (!gotFirst) { gotFirst = true; genMs = performance.now() - t0; }
          answer += delta;
          setAssistantMarkdown(assistantBubble, answer);
        });
        typeMs = performance.now() - t0 - genMs;
        if (!gotFirst) genMs = performance.now() - t0;
      } catch (streamErr) {
        console.warn("stream falló, reintentando sin streaming", streamErr);
        const t1 = performance.now();
        const raw = await callBackendNoStream(msgs);
        genMs = performance.now() - t1;
        const r = await renderAssistantTypewriter(assistantBubble, raw, 40, 3);
        answer = r.text; typeMs = r.typeMs;
      }
    } else {
      const raw = await callBackendNoStream(msgs);
      genMs = performance.now() - t0;
      const parsed = extractJSON(raw);
      answer = parsed.answer || raw;
      chatName = (parsed.chat_name || smartNameFrom(text)).slice(0,60);
      const r = await renderAssistantTypewriter(assistantBubble, answer, 40, 3);
      typeMs = r.typeMs;
    }

    clearTimeout(slowTimer);
    if (mySeq !== state.seq) return;

    state.messages.push({ role: "assistant", content: answer });
    await saveConversation(state.currentChatId, state.messages);

    let title;
    if (firstTurn) {
      title = chatName;
    } else {
      const metaCurr = state.chatsIndex.find(x => x.id === state.currentChatId);
      title = metaCurr?.name || smartNameFrom(text);
    }
    const meta = await saveChatMeta({ id: state.currentChatId, name: title, lastUser: text });
    const idx = state.chatsIndex.findIndex(x=>x.id===meta.id);
    if (idx >= 0) state.chatsIndex[idx] = meta; else state.chatsIndex.unshift(meta);
    state.chatsIndex.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
    renderChatList(chatSearchEl.value || "");

    appendTimingTag(assistantBubble, { model: MODEL, genMs, typeMs, uploadMs });
    log({ model: MODEL, genMs, typeMs, uploadMs });

  } catch (err) {
    clearTimeout(slowTimer);
    const info = classifyError(err);
    setAssistantError(
      assistantBubble,
      info.title,
      `${info.hint}${info.raw ? ` · Detalle: ${info.raw}` : ""}`
    );
    console.error("/chat error:", err);
  }
});

//////////////////////////////
// Varias utilidades más    //
//////////////////////////////

function smartNameFrom(q=""){ return (q.split(/\s+/).slice(0,6).join(" ") || "Nuevo chat"); }

function classifyError(err) {
  const msg = err?.message || "";
  const code = err?.code || err?.status || err?.name || "";
  const raw  = safeStringify(err);
  if (/network|Failed to fetch|TypeError: Failed/i.test(msg)) return { title:"Problema de red", hint:"Revisa tu conexión.", raw };
  if (/auth|unauthorized|401|signin|required|credentials/i.test(msg+code)) return { title:"No tienes sesión", hint:"Inicia sesión en Puter.", raw };
  if (/rate|quota|429/i.test(msg+code)) return { title:"Límite alcanzado", hint:"Espera y reintenta.", raw };
  if (/model|invalid|options|argument|unknown/i.test(msg+code)) return { title:"Parámetros inválidos", hint:"Verifica el modelo/opciones.", raw };
  if (/tardó demasiado|timeout/i.test(msg)) return { title:"Tiempo de espera agotado", hint:"Intenta de nuevo.", raw };
  return { title:"Error inesperado", hint:"Ocurrió un problema no manejado.", raw };
}
function safeStringify(v){ try { return JSON.stringify(v, Object.getOwnPropertyNames(v)); } catch { return String(v); } }

// Errores globales (para que no “mueran” los listeners)
window.addEventListener("error", (e) => console.error("Error global:", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("Promesa sin catch:", e.reason));

console.log('[build] backend: Flask(OpenAI gpt-5-nano) | first-turn: no-stream(JSON) | next-turns: SSE streaming | KV: Puter | fs: Puter | metrics:on');
