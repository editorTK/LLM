/* main.js — versión simplificada
 * - Sin o3, sin blur
 * - Solo gpt-5-mini (rápido)
 * - Un solo archivo (sin imports)
 * - KV usando kv.del() para borrar
 * - Llamada a puter.ai.chat SIN streaming + typewriter para simularlo
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
const clearAttachBtn = $("#clearAttachBtn");

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

const MODEL = "gpt-5"; // ÚNICO modelo ahora
const INPUT_MAX_HEIGHT = 160;

const state = {
  pendingImage: null,      // { path, name }
  currentChatId: null,
  chatsIndex: [],          // [{ id, name, lastUser, updatedAt }]
  seq: 0,                  // invalida respuestas viejas
  prefs: { call_you: "", style: "" },
  messages: []             // arr de {role, content}, primer elemento siempre "system"
};

//////////////////////////////
// Helpers UI               //
//////////////////////////////

function hideHero(){ hero?.classList.add("hidden"); }
function showHero(){ hero?.classList.remove("hidden"); }

function addUserBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "flex justify-end";
  const bubble = document.createElement("div");
  bubble.className = "msg msg--user max-w-[85%] md:max-w-[75%] text-sm prose prose-invert prose-pre:whitespace-pre-wrap";
  bubble.innerHTML = renderMarkdown(text);
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

async function typewriterMarkdown(node, fullMD, cps = 40, step = 3) {
  let i = 0;
  const delay = Math.max(5, Math.round(1000 / cps));
  while (i < fullMD.length) {
    i += step;
    setAssistantMarkdown(node, fullMD.slice(0, i));
    await new Promise(r => setTimeout(r, delay));
  }
  setAssistantMarkdown(node, fullMD);
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
    "Eres un asistente útil, claro y tranquilo.",
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
    row.className = "group relative";
    row.innerHTML = `
      <button class="w-full text-left px-4 py-3 hover:bg-pane">
        <div class="text-sm font-medium truncate">${escapeHTML(c.name || "Chat sin título")}</div>
        <div class="text-xs text-sub truncate">${escapeHTML(c.lastUser || "")}</div>
      </button>
      <div class="chat-row-pop absolute right-2 top-1/2 -translate-y-1/2 hidden">
        <button class="btn-pop bg-white text-black" data-action="open">Abrir</button>
        <button class="btn-pop bg-red-600 text-white" data-action="delete">Eliminar</button>
      </div>
    `;
    const openBtn = row.querySelector('[data-action="open"]');
    const delBtn = row.querySelector('[data-action="delete"]');
    const pressBtn = row.querySelector("button");
    pressBtn.addEventListener("click", () => {
      row.querySelector(".chat-row-pop").classList.toggle("hidden");
    });
    openBtn.addEventListener("click", (e) => { e.stopPropagation(); openChat(c.id); });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteChatKV(c.id);
      state.chatsIndex = state.chatsIndex.filter(x => x.id !== c.id);
      renderChatList(chatSearchEl.value || "");
      if (state.currentChatId === c.id) {
        state.currentChatId = null;
        chatEl.innerHTML = "";
        showHero();
        state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];
      }
    });
    chatListEl.appendChild(row);
  }
}

function newChat() {
  state.currentChatId = `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  state.messages = [{ role: "system", content: buildSystemPrompt(state.prefs) }];
  chatEl.innerHTML = "";
  showHero();
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

function wrapForJSON({ baseMessages, userText, pendingImage }) {
  const instruction =
`Responde ÚNICAMENTE con JSON válido, sin texto adicional.
Estructura:
{
  "answer": "texto en Markdown con la respuesta al usuario",
  "chat_name": "título breve (máx 60 caracteres) basado en su pregunta"
}`;
  // Asegurar que el primer mensaje sea el system con prefs actuales
  if (!baseMessages.length || baseMessages[0]?.role !== "system") {
    baseMessages = [{ role: "system", content: buildSystemPrompt(state.prefs) }, ...baseMessages];
  } else {
    baseMessages[0] = { role: "system", content: buildSystemPrompt(state.prefs) };
  }
  return [
    ...baseMessages,
    { role: "system", content: instruction },
    {
      role: "user",
      content: pendingImage
        ? [{ type: "file", puter_path: pendingImage.path }, { type: "text", text: userText }]
        : userText
    }
  ];
}

async function aiChatJSON(messages) {
  if (!window.puter?.ai?.chat) throw new Error("Puter.ai.chat no está disponible.");
  // Firma correcta con messages[]: (messages, testMode=false, options)
  const resp = await puter.ai.chat(messages, false, { model: MODEL, stream: false });
  const raw = normalizeText(resp);
  const parsed = extractJSON(raw);
  return {
    answer: parsed?.answer ?? raw ?? "",
    chat_name: (parsed?.chat_name ?? "").trim()
  };
}

function normalizeText(resp) {
  if (typeof resp === "string") return resp;
  if (resp?.message?.content) return String(resp.message.content);
  if (resp?.text) return String(resp.text);
  if (resp?.output_text) return String(resp.output_text);
  try { return JSON.stringify(resp); } catch { return String(resp); }
}

function extractJSON(raw) {
  const trimmed = String(raw).trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "");
  const first = trimmed.indexOf("{");
  const last  = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = trimmed.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  try { return JSON.parse(trimmed); } catch { return null; }
}

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
    try {
      const uploaded = await puter.fs.upload(files);
      const f = Array.isArray(uploaded) ? uploaded[0] : uploaded;
      state.pendingImage = { path: f.path, name: f.name || "imagen" };
      attachLabel.textContent = `Adjunto: ${state.pendingImage.name}`;
      attachRow.classList.remove("hidden");
    } catch (err) {
      alert("No se pudo subir la imagen.");
      console.error(err);
    } finally {
      fileInput.value = "";
    }
  });
  clearAttachBtn?.addEventListener("click", () => { state.pendingImage = null; attachRow.classList.add("hidden"); });

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
});

// Envío de mensaje
form?.addEventListener("submit", async (e) => {
  e.preventDefault(); e.stopPropagation();
  const text = input.value.trim();
  if (!text) return;

  if (!state.currentChatId) newChat();

  addUserBubble(text);
  const assistantBubble = addAssistantSkeleton();

  input.value = "";
  input.style.height = "auto";
  hideHero();

  // Mensaje del usuario a historial (texto o multimodal)
  if (state.pendingImage) {
    state.messages.push({ role: "user", content: [
      { type: "file", puter_path: state.pendingImage.path },
      { type: "text", text }
    ]});
  } else {
    state.messages.push({ role: "user", content: text });
  }

  // invalidar respuestas anteriores si el usuario envía rápido
  const mySeq = ++state.seq;

  // Construimos mensajes para pedir JSON en UNA llamada
  const msgs = wrapForJSON({
    baseMessages: state.messages,
    userText: text,
    pendingImage: state.pendingImage
  });

  // Consumimos el adjunto una sola vez
  state.pendingImage = null;
  attachRow?.classList.add("hidden");

  try {
    const { answer, chat_name } = await aiChatJSON(msgs);
    if (mySeq !== state.seq) return;

    // Efecto máquina de escribir (simula streaming)
    await typewriterMarkdown(assistantBubble, answer, 40, 3);

    // Guardar historial + snapshot (aparece en la lista)
    state.messages.push({ role: "assistant", content: answer });
    await saveConversation(state.currentChatId, state.messages);

    const title = (chat_name || smartNameFrom(text)).slice(0, 60);
    const meta = await saveChatMeta({ id: state.currentChatId, name: title, lastUser: text });
    const idx = state.chatsIndex.findIndex(x=>x.id===meta.id);
    if (idx >= 0) state.chatsIndex[idx] = meta; else state.chatsIndex.unshift(meta);
    state.chatsIndex.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
    renderChatList(chatSearchEl.value || "");

  } catch (err) {
    const info = classifyError(err);
    setAssistantError(
      assistantBubble,
      info.title,
      `${info.hint}${info.raw ? ` · Detalle: ${info.raw}` : ""}`
    );
    console.error("puter.ai.chat error:", err);
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