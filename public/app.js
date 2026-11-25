// Agenda por Voz - front-end
const $ = (s) => document.querySelector(s);

// ---------- Estado ----------
let pin = safeGet("pin") || "";
let viewYear, viewMonth; // mês exibido
let selected = toISO(new Date()); // dia selecionado (AAAA-MM-DD)
let monthEvents = []; // eventos do intervalo visível
let lastCreated = []; // ids criados pelo último áudio (para desfazer)
let editingId = null;

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function safeDel(k) { try { localStorage.removeItem(k); } catch {} }

// ---------- Datas ----------
function toISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function fromISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
const fmtMonth = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const fmtDay = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short" });

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "x-pin": pin } });
  if (res.status === 401) { lock(); throw new Error("PIN inválido"); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
const json = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------- PIN ----------
function lock() { safeDel("pin"); pin = ""; $("#app").hidden = true; $("#lock").hidden = false; $("#pinInput").focus(); }
$("#pinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  pin = $("#pinInput").value.trim();
  try {
    await api("/api/ping");
    safeSet("pin", pin);
    $("#pinError").hidden = true;
    start();
  } catch { $("#pinError").hidden = false; }
});

// ---------- Calendário ----------
async function loadMonth() {
  const first = new Date(viewYear, viewMonth, 1);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  $("#monthTitle").textContent = cap(fmtMonth.format(first));
  try { monthEvents = await api(`/api/events?from=${toISO(gridStart)}&to=${toISO(gridEnd)}`); }
  catch { monthEvents = []; }
  renderGrid(gridStart);
  renderDay();
}

function renderGrid(gridStart) {
  const today = toISO(new Date());
  const counts = {};
  for (const e of monthEvents) counts[e.date] = (counts[e.date] || 0) + 1;
  const grid = $("#grid");
  grid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const iso = toISO(d);
    const b = document.createElement("button");
    b.className = "cell";
    if (d.getMonth() !== viewMonth) b.classList.add("other");
    if (iso === today) b.classList.add("today");
    if (iso === selected) b.classList.add("selected");
    b.setAttribute("aria-label", `${fmtDay.format(d)}${counts[iso] ? `, ${counts[iso]} compromisso(s)` : ""}`);
    const n = Math.min(counts[iso] || 0, 3);
    b.innerHTML = `<span class="num">${d.getDate()}</span><span class="dots">${"<i></i>".repeat(n)}</span>`;
    b.onclick = () => {
      selected = iso;
      if (d.getMonth() !== viewMonth) { viewYear = d.getFullYear(); viewMonth = d.getMonth(); loadMonth(); }
      else { renderGrid(gridStart); renderDay(); }
    };
    grid.appendChild(b);
  }
}

function renderDay(highlightIds = []) {
  $("#dayTitle").textContent = cap(fmtDay.format(fromISO(selected)));
  const list = $("#events");
  list.innerHTML = "";
  const items = monthEvents.filter((e) => e.date === selected);
  if (!items.length) { list.innerHTML = `<li class="empty">Nada marcado neste dia.</li>`; return; }
  for (const e of items) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "event" + (highlightIds.includes(e.id) ? " new" : "");
    const time = e.start ? (e.end ? `${e.start}<br><span class="badge">${e.end}</span>` : e.start) : "Dia";
    const meta = [e.location, e.notes].filter(Boolean).map(esc).join(" · ");
    b.innerHTML = `<span class="time">${time}</span><span class="info"><div class="title">${esc(e.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ""}</span>${e.source === "voz" ? '<span class="badge" title="Criado por voz">🎙</span>' : ""}`;
    b.onclick = () => openEditor(e);
    li.appendChild(b);
    list.appendChild(li);
  }
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

$("#prevMonth").onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } loadMonth(); };
$("#nextMonth").onclick = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } loadMonth(); };
$("#monthTitle").onclick = () => { const t = new Date(); viewYear = t.getFullYear(); viewMonth = t.getMonth(); selected = toISO(t); loadMonth(); };

// ---------- Editor ----------
const editor = $("#editor"), form = $("#editForm");
function openEditor(e) {
  editingId = e?.id || null;
  $("#editTitle").textContent = editingId ? "Editar compromisso" : "Novo compromisso";
  form.title.value = e?.title || "";
  form.date.value = e?.date || selected;
  form.start.value = e?.start || "";
  form.end.value = e?.end || "";
  form.location.value = e?.location || "";
  form.notes.value = e?.notes || "";
  $("#editTranscript").textContent = e?.transcript ? `Áudio: “${e.transcript}”` : "";
  $("#deleteBtn").hidden = !editingId;
  editor.showModal();
}
$("#addBtn").onclick = () => openEditor(null);
$("#cancelBtn").onclick = () => editor.close();
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = {
    title: form.title.value.trim(), date: form.date.value,
    start: form.start.value || null, end: form.end.value || null,
    location: form.location.value.trim() || null, notes: form.notes.value.trim() || null,
  };
  try {
    if (editingId) await api(`/api/events/${editingId}`, json(body, "PUT"));
    else await api("/api/events", json(body));
    editor.close();
    goTo(body.date);
  } catch (err) { alert(err.message); }
});
$("#deleteBtn").onclick = async () => {
  if (!editingId || !confirm("Excluir este compromisso?")) return;
  await api(`/api/events/${editingId}`, { method: "DELETE" });
  editor.close();
  loadMonth();
};

function goTo(iso, highlight = []) {
  selected = iso;
  const d = fromISO(iso);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  return loadMonth().then(() => renderDay(highlight));
}

// ---------- Resultado ----------
let toastTimer;
function showResult({ intent, from, reply, transcript, events }) {
  if (intent === "consultar") {
    // Pergunta: mostra a resposta, lê em voz alta e abre o dia no calendário
    lastCreated = [];
    $("#toastText").innerText = reply || "";
    $("#toastTranscript").textContent = transcript ? `“${transcript}”` : "";
    $("#undoBtn").hidden = true;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("#toast").hidden = true), 20000);
    speak(reply);
    if (from) goTo(from, (events || []).map((e) => e.id));
    return;
  }
  lastCreated = (events || []).map((e) => e.id);
  let text = reply || "";
  if (events?.length > 1) text += "\n" + events.map((e) => `• ${e.title} – ${fmtShort.format(fromISO(e.date))}${e.start ? " " + e.start : ""}`).join("\n");
  $("#toastText").innerText = text;
  $("#toastTranscript").textContent = transcript ? `“${transcript}”` : "";
  $("#undoBtn").hidden = !lastCreated.length;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 12000);
  if (events?.length) goTo(events[0].date, lastCreated);
}
function speak(text) {
  try {
    if (!text || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[•—–]/g, ",").replace(/(\d{2}):(\d{2})/g, "$1 e $2"));
    u.lang = "pt-BR";
    speechSynthesis.speak(u);
  } catch {}
}
function showError(msg) {
  $("#toastText").textContent = "⚠️ " + msg;
  $("#toastTranscript").textContent = "";
  $("#undoBtn").hidden = true;
  $("#toast").hidden = false;
}
$("#toastClose").onclick = () => { $("#toast").hidden = true; try { speechSynthesis.cancel(); } catch {} };
$("#undoBtn").onclick = async () => {
  for (const id of lastCreated) await api(`/api/events/${id}`, { method: "DELETE" });
  lastCreated = [];
  $("#toast").hidden = true;
  loadMonth();
};

// ---------- Gravação ----------
const mic = $("#micBtn");
let recorder = null, chunks = [], recStart = 0, recTimer = null, stream = null;

function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

mic.onclick = async () => {
  if (recorder?.state === "recording") { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError("Este navegador não grava áudio. Use o botão ⌨ para digitar.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError("Permita o uso do microfone para gravar.");
    return;
  }
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = sendAudio;
  recorder.start();
  recStart = Date.now();
  mic.classList.add("recording");
  $("#hint").textContent = "Gravando… toque de novo para enviar";
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("#recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s >= 120) recorder.stop(); // limite de 2 minutos
  }, 250);
};

async function sendAudio() {
  clearInterval(recTimer);
  stream?.getTracks().forEach((t) => t.stop());
  mic.classList.remove("recording");
  $("#recTime").textContent = "";
  const type = recorder.mimeType || "audio/webm";
  const blob = new Blob(chunks, { type });
  if (Date.now() - recStart < 700 || blob.size < 1000) {
    $("#hint").textContent = "Áudio muito curto. Toque e fale o compromisso.";
    return;
  }
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `audio.${ext}`);
  mic.classList.add("busy");
  $("#hint").textContent = "Entendendo seu áudio…";
  try {
    showResult(await api("/api/voice", { method: "POST", body: fd }));
  } catch (err) {
    showError(err.message);
  } finally {
    mic.classList.remove("busy");
    $("#hint").textContent = "Fale para marcar ou pergunte: “o que eu tenho amanhã?”";
  }
}

// ---------- Digitar ----------
const typer = $("#typer"), typeForm = $("#typeForm");
$("#typeBtn").onclick = () => { typeForm.text.value = ""; typer.showModal(); };
$("#typeCancel").onclick = () => typer.close();
typeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = typeForm.text.value.trim();
  if (!text) return;
  typer.close();
  mic.classList.add("busy");
  $("#hint").textContent = "Entendendo…";
  try { showResult(await api("/api/text", json({ text }))); }
  catch (err) { showError(err.message); }
  finally { mic.classList.remove("busy"); $("#hint").textContent = "Fale para marcar ou pergunte: “o que eu tenho amanhã?”"; }
});

// ---------- Início ----------
function start() {
  $("#lock").hidden = true;
  $("#app").hidden = false;
  const t = new Date();
  viewYear = t.getFullYear(); viewMonth = t.getMonth();
  loadMonth();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

if (pin) api("/api/ping").then(start).catch(lock);
else lock();
