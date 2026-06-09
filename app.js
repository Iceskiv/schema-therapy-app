import { renderMap, zoomBy, zoomFit } from "./render.js";
import { downloadMapPNG, printSheets } from "./export.js";
import { clientCatalog, SAMPLE_ANALYSIS, buildSystemPrompt, OUTPUT_TOOL } from "./knowledge/schema-knowledge.js";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";
import { GoogleGenAI, createUserContent, createPartFromUri } from "https://esm.sh/@google/genai";

const $ = (s) => document.querySelector(s);
const svg = $("#map");
const GEMINI_MODEL = "gemini-2.5-flash";
const CLAUDE_MODEL = "claude-opus-4-8";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const catalog = clientCatalog(); // синхронно, з вбудованого модуля знань
let currentAudio = null;
let mediaRec = null;
let recChunks = [];
let selectedId = null;
let cloud = null;       // модуль Firebase (вантажиться динамічно)
let currentUser = null; // залогінений користувач або null

const state = {
  catalog,
  patientSummary: "",
  problems: [],
  goals: [],
  modes: [],
  planDoc: "",
  plan: {
    stage1: { description: "", modes: [], techniques: [] },
    stage2: { description: "", modes: [], techniques: [] },
    stage3: { description: "", modes: [], techniques: [] },
  },
};

// ---------- утиліти ----------
const linesToArr = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const arrToLines = (a) => (a || []).join("\n");
function toast(msg, kind = "info", ms = 4200) {
  if (!msg) return;
  const wrap = $("#toasts"); if (!wrap) return;
  const t = document.createElement("div"); t.className = "toast " + kind; t.textContent = msg;
  wrap.appendChild(t); requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
}
function setProgress(msg, kind = "") { toast(msg, kind === "err" ? "error" : "info"); }
function showOverlay(title, sub) { $("#overlayTitle").textContent = title || ""; $("#overlaySub").textContent = sub || ""; $("#overlay").classList.remove("hidden"); }
function hideOverlay() { $("#overlay").classList.add("hidden"); }
let recTimer = null, recStart = 0;
function uniqueId(base) { let id = base, i = 2; while (state.modes.some((m) => m.id === id)) id = base + "__" + i++; return id; }
function defById(id) { return (catalog.modes || []).find((m) => m.id === id) || {}; }
function mimeFromName(name) {
  const ext = (name || "").toLowerCase().split(".").pop();
  return ({ mp3: "audio/mp3", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", aiff: "audio/aiff" }[ext]) || "audio/mpeg";
}

// ---------- ключі (localStorage) ----------
function getKeys() { return { gemini: (localStorage.getItem("gk") || "").trim(), anthropic: (localStorage.getItem("ak") || "").trim() }; }
function updateKeyStatus() {
  const { gemini, anthropic } = getKeys();
  const st = $("#status");
  if (gemini && anthropic) { st.textContent = "Ключі збережено ✓"; st.className = "status ok"; }
  else { st.textContent = "⚙ Введи API-ключі"; st.className = "status warn"; }
}
function openSettings() {
  const { gemini, anthropic } = getKeys();
  $("#kGemini").value = gemini; $("#kAnthropic").value = anthropic;
  $("#settings").classList.remove("hidden");
}

// ---------- клієнтські AI-виклики ----------
async function transcribeAudio(file) {
  const { gemini } = getKeys();
  if (!gemini) { openSettings(); throw new Error("Спершу встав ключ Gemini у Налаштуваннях (⚙)"); }
  const ai = new GoogleGenAI({ apiKey: gemini });
  const mime = file.type || mimeFromName(file.name);
  const uploaded = await ai.files.upload({ file, config: { mimeType: mime } });
  let f = uploaded;
  for (let i = 0; i < 120 && f.state !== "ACTIVE"; i++) {
    if (f.state === "FAILED") throw new Error("Gemini не зміг обробити аудіо — спробуй mp3/wav або встав транскрипт вручну.");
    await sleep(1500);
    f = await ai.files.get({ name: uploaded.name });
  }
  if (f.state !== "ACTIVE") throw new Error("Аудіо обробляється задовго — спробуй ще раз.");
  const prompt =
    "Це аудіозапис клінічного випадку (очікувана мова — українська). " +
    "Зроби максимально точну ДОСЛІВНУ транскрипцію тією мовою, якою говорять. НЕ перекладай. " +
    "Поверни лише текст транскрипції, без коментарів.";
  const r = await ai.models.generateContent({ model: GEMINI_MODEL, contents: createUserContent([createPartFromUri(f.uri, f.mimeType), prompt]) });
  try { await ai.files.delete({ name: uploaded.name }); } catch {}
  return (r.text || "").trim();
}

async function analyzeTranscript(transcript) {
  const { anthropic } = getKeys();
  if (!anthropic) { openSettings(); throw new Error("Спершу встав ключ Anthropic у Налаштуваннях (⚙)"); }
  const client = new Anthropic({ apiKey: anthropic, dangerouslyAllowBrowser: true });
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [OUTPUT_TOOL],
    tool_choice: { type: "tool", name: OUTPUT_TOOL.name },
    messages: [{ role: "user", content: "Ось транскрипт усно представленого випадку. Побудуй концептуалізацію та план по 3 етапах через інструмент submit_conceptualization.\n\n<transcript>\n" + transcript + "\n</transcript>" }],
  });
  const tu = msg.content.find((b) => b.type === "tool_use");
  if (!tu) throw new Error("Модель не повернула структуровану відповідь.");
  return tu.input;
}

// ---------- ініціалізація ----------
function init() {
  // префіл ключів з посилання виду  #gk=...&ak=...
  if (location.hash && location.hash.length > 1) {
    const p = new URLSearchParams(location.hash.slice(1));
    let changed = false;
    if (p.get("gk")) { localStorage.setItem("gk", p.get("gk")); changed = true; }
    if (p.get("ak")) { localStorage.setItem("ak", p.get("ak")); changed = true; }
    if (changed) history.replaceState(null, "", location.pathname + location.search);
  }
  buildPalette();
  buildReference();
  renderAll();
  updateKeyStatus();
  const { gemini, anthropic } = getKeys();
  if (!gemini || !anthropic) setProgress("Натисни ⚙ і встав 2 ключі (або скористайся «Демо-приклад» без ключів).", "");
  initCloud();
}

// ---------- маппінг аналізу у стан ----------
function applyAnalysis(a) {
  state.patientSummary = a.patient_summary || "";
  state.problems = a.problems || [];
  state.goals = a.goals || [];
  state.modes = [];
  let hasHealthy = false;
  for (const m of a.modes || []) {
    const def = defById(m.id);
    state.modes.push({
      id: uniqueId(m.id || "mode"),
      baseId: def.id || m.id,
      ua: m.ua_name || def.ua || m.id,
      category: def.category || "coping",
      scene: def.scene || "external",
      descriptors: m.descriptors || [],
      linked: m.linked_schemas || [],
    });
    if (def.id === "healthy_adult") hasHealthy = true;
  }
  if (!hasHealthy) addModeById("healthy_adult", false);
  const plan = a.plan || {};
  for (const k of ["stage1", "stage2", "stage3"]) {
    state.plan[k] = { description: plan[k]?.description || "", modes: plan[k]?.modes || [], techniques: plan[k]?.techniques || [] };
  }
  state.planDoc = "";
  selectedId = null;
  renderAll();
  switchTab("map");
}

function addModeById(id, rerender = true) {
  const def = defById(id);
  if (!def.id) return;
  state.modes.push({ id: uniqueId(def.id), baseId: def.id, ua: def.ua, category: def.category, scene: def.scene, descriptors: [], linked: def.schemas || [] });
  if (rerender) renderAll();
}

// ---------- рендер ----------
function renderAll() {
  renderMap(svg, state, { onSelect: selectNode });
  $("#problems").value = arrToLines(state.problems);
  $("#goals").value = arrToLines(state.goals);
  renderSelected();
  renderPlan();
  refreshPaletteState();
}
function selectNode(id) { selectedId = id; renderSelected(); }
function renderSelected() {
  const m = state.modes.find((x) => x.id === selectedId);
  if (!m) { $("#selForm").classList.add("hidden"); $("#selEmpty").classList.remove("hidden"); $("#selTitle").textContent = "Вибрана частка"; return; }
  $("#selEmpty").classList.add("hidden");
  $("#selForm").classList.remove("hidden");
  $("#selTitle").textContent = m.ua;
  $("#selName").value = m.ua;
  $("#selDesc").value = arrToLines(m.descriptors);
  $("#selScene").value = m.scene;
  $("#selSize").value = m.sizeMul || 1;
}

// ---------- палітра ----------
function buildPalette() {
  const groups = { parent: "Батьківські", child: "Дитячі", coping: "Коупінг-частки", healthy: "Здорова доросла", happy: "Щаслива дитина" };
  const box = $("#palette");
  box.innerHTML = "";
  for (const [cat, label] of Object.entries(groups)) {
    const items = catalog.modes.filter((m) => m.category === cat);
    if (!items.length) continue;
    const g = document.createElement("div");
    g.className = "grp";
    g.innerHTML = `<h5>${label}</h5>`;
    for (const m of items) {
      const chip = document.createElement("span");
      chip.className = "chip"; chip.dataset.id = m.id; chip.style.borderColor = catalog.categoryColors[m.category];
      chip.textContent = m.ua; chip.title = m.def || "";
      chip.addEventListener("click", () => addModeById(m.id));
      g.appendChild(chip);
    }
    box.appendChild(g);
  }
}
function refreshPaletteState() {
  const present = new Set(state.modes.map((m) => defById(m.id).id || m.id));
  document.querySelectorAll("#palette .chip").forEach((c) => { c.dataset.on = present.has(c.dataset.id) ? "1" : ""; });
}

// ---------- план ----------
const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function buildPlanDocHTML() {
  let h = "";
  if (state.patientSummary) h += `<p><i>${esc(state.patientSummary)}</i></p>`;
  catalog.stages.forEach((stage) => {
    const d = state.plan[stage.key] || {};
    h += `<h3>${esc(stage.title)}</h3>`;
    if (d.description) h += `<p>${esc(d.description)}</p>`;
    if (d.modes && d.modes.length) h += `<p class="lbl">Частки:</p><ul>${d.modes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (d.techniques && d.techniques.length) h += `<p class="lbl">Техніки:</p><ul>${d.techniques.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  });
  return h;
}
function renderPlan() {
  const host = $("#planEditor");
  host.innerHTML = "";
  const doc = document.createElement("div");
  doc.className = "plan-doc"; doc.id = "planDoc"; doc.contentEditable = "true"; doc.spellcheck = false;
  doc.innerHTML = state.planDoc || buildPlanDocHTML();
  doc.addEventListener("input", () => { state.planDoc = doc.innerHTML; });
  host.appendChild(doc);
}
function planHTML() {
  const doc = document.querySelector("#planDoc");
  const inner = doc ? doc.innerHTML : (state.planDoc || buildPlanDocHTML());
  return `<h1>План терапії</h1>` + inner;
}

// ---------- довідник ----------
function buildReference() {
  const body = $("#refBody");
  body.innerHTML = "";
  const grpModes = document.createElement("div");
  grpModes.className = "ref-grp"; grpModes.innerHTML = "<h3>Частки (modes)</h3>";
  catalog.modes.forEach((m) => {
    const it = document.createElement("div"); it.className = "ref-item";
    it.dataset.text = (m.ua + " " + (m.def || "") + " " + (m.task || "")).toLowerCase();
    it.innerHTML = `<b>${m.ua}</b><span class="tag" style="background:${catalog.categoryColors[m.category]}">${m.category}</span><br><small>${m.def || ""}</small>${m.task ? `<br><small><b>Завдання:</b> ${m.task}</small>` : ""}`;
    grpModes.appendChild(it);
  });
  body.appendChild(grpModes);
  const grpS = document.createElement("div");
  grpS.className = "ref-grp"; grpS.innerHTML = "<h3>18 ранніх дезадаптивних схем</h3>";
  catalog.schemas.forEach((s) => {
    const it = document.createElement("div"); it.className = "ref-item";
    it.dataset.text = (s.name + " " + s.short + " " + s.domain).toLowerCase();
    it.innerHTML = `<b>${s.name}</b><br><small>${s.short} · <i>${s.domain}</i></small>`;
    grpS.appendChild(it);
  });
  body.appendChild(grpS);
  const grpN = document.createElement("div");
  grpN.className = "ref-grp"; grpN.innerHTML = "<h3>Базові потреби</h3>";
  catalog.basicNeeds.forEach((n) => {
    const it = document.createElement("div"); it.className = "ref-item"; it.dataset.text = n.toLowerCase();
    it.innerHTML = `<small>• ${n}</small>`;
    grpN.appendChild(it);
  });
  body.appendChild(grpN);
}
$("#refSearch")?.addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#refBody .ref-item").forEach((it) => { it.style.display = !q || it.dataset.text.includes(q) ? "" : "none"; });
});

// ---------- вкладки ----------
function switchTab(name) {
  document.querySelector(".workspace").dataset.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------- налаштування (ключі) ----------
$("#settingsBtn").addEventListener("click", openSettings);
$("#status").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", () => $("#settings").classList.add("hidden"));
$("#saveKeys").addEventListener("click", () => {
  const gk = $("#kGemini").value.trim(), ak = $("#kAnthropic").value.trim();
  localStorage.setItem("gk", gk);
  localStorage.setItem("ak", ak);
  updateKeyStatus();
  $("#settings").classList.add("hidden");
  setProgress("Ключі збережено у цьому браузері.", "");
  if (currentUser && cloud) cloud.cloudSaveKeys(currentUser.uid, { gk, ak }).catch((e) => console.warn("cloud keys", e));
});

// ---------- аудіо ----------
function setAudio(f, label) { currentAudio = f; $("#fileName").textContent = label || (f?.name || "запис готовий"); $("#transcribe").disabled = !f; }
$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) setAudio(f); });
const drop = $("#drop");
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setAudio(f); });

function startRecUI() {
  $("#recBar").classList.remove("hidden");
  $("#recControls").classList.add("hidden");
  recStart = Date.now();
  $("#recTime").textContent = "00:00";
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("#recTime").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 500);
}
function stopRecUI() { clearInterval(recTimer); recTimer = null; $("#recBar").classList.add("hidden"); $("#recControls").classList.remove("hidden"); }
async function startRecording() {
  if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    mediaRec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const dur = $("#recTime").textContent;
      stopRecUI();
      const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
      setAudio(blob, `🎙 запис ${dur}`);
    };
    mediaRec.start();
    startRecUI();
  } catch (e) { toast("Немає доступу до мікрофона: " + e.message, "error"); }
}
$("#rec").addEventListener("click", startRecording);
$("#recStop").addEventListener("click", () => { if (mediaRec && mediaRec.state === "recording") mediaRec.stop(); });

// Запис звуку, що грає на цьому ПК (Zoom / YouTube) — через захоплення вкладки/екрана
async function startSystemAudio() {
  if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast("Браузер не підтримує захоплення звуку екрана.", "error"); return; }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const aTracks = display.getAudioTracks();
    if (!aTracks.length) {
      display.getTracks().forEach((t) => t.stop());
      toast("Аудіо не захоплено. У вікні вибору обери вкладку або «Весь екран» і постав галочку «Поділитися аудіо».", "error", 9000);
      return;
    }
    const aStream = new MediaStream(aTracks);
    recChunks = [];
    mediaRec = new MediaRecorder(aStream);
    mediaRec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    mediaRec.onstop = () => {
      display.getTracks().forEach((t) => t.stop());
      const dur = $("#recTime").textContent;
      stopRecUI();
      const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
      setAudio(blob, `🔊 звук з ПК ${dur}`);
    };
    aTracks[0].addEventListener("ended", () => { if (mediaRec && mediaRec.state === "recording") mediaRec.stop(); });
    mediaRec.start();
    startRecUI();
    toast("Запис звуку з ПК пішов. Натисни «⏹ Стоп», коли закінчиш.", "info");
  } catch (e) {
    if (e.name === "NotAllowedError") toast("Захоплення скасовано.", "info");
    else toast("Не вдалося захопити звук з ПК: " + e.message, "error", 7000);
  }
}
$("#recSystem").addEventListener("click", startSystemAudio);

$("#transcribe").addEventListener("click", async () => {
  if (!currentAudio) return;
  showOverlay("Транскрибую аудіо…", "Gemini розшифровує запис — це може зайняти 1–3 хв");
  try {
    $("#transcript").value = await transcribeAudio(currentAudio);
    toast("Транскрипт готовий ✓ Тепер «Аналізувати».", "success");
  } catch (e) { toast("Помилка транскрипції: " + e.message, "error", 7000); }
  finally { hideOverlay(); }
});

$("#analyze").addEventListener("click", async () => {
  const transcript = $("#transcript").value.trim();
  if (!transcript) { toast("Спершу додай транскрипт (або встав текст).", "error"); return; }
  showOverlay("Аналізую випадок…", "Claude будує карту часток і план терапії — до хвилини");
  try {
    applyAnalysis(await analyzeTranscript(transcript));
    addSnapshot();
    toast("Готово ✓ Карту й план побудовано (збережено в історію).", "success");
  } catch (e) { toast("Помилка аналізу: " + e.message, "error", 7000); }
  finally { hideOverlay(); }
});

// ---------- демо ----------
$("#demo").addEventListener("click", () => {
  applyAnalysis(JSON.parse(JSON.stringify(SAMPLE_ANALYSIS)));
  setProgress("Демо-приклад завантажено. Спробуй редагування й експорт.", "");
});

// ---------- транскрипт із файлу (.txt) / посилання ----------
$("#pickText").addEventListener("click", () => $("#textFile").click());
$("#textFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { $("#transcript").value = (await f.text()).trim(); setProgress("Текст завантажено з файлу. Можна «Аналізувати».", ""); }
  catch (err) { setProgress("Не вдалося прочитати файл: " + err.message, "err"); }
});
$("#urlLoad").addEventListener("click", async () => {
  const url = $("#urlInput").value.trim();
  if (!url) { setProgress("Встав посилання у поле зліва.", "err"); return; }
  setProgress("Завантажую з посилання…", "busy");
  try {
    const r = await fetch(url);
    let text = await r.text();
    if (/<[a-z]/i.test(text)) text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(p|div|h\d|li|br|tr)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    $("#transcript").value = text.slice(0, 80000);
    setProgress("Завантажено. Перевір текст і «Аналізувати».", "");
  } catch (err) { setProgress("Не вдалося завантажити (можливо CORS). Скопіюй текст вручну.", "err"); }
});

// ---------- редактор вибраної частки ----------
$("#selName").addEventListener("input", (e) => { const m = state.modes.find((x) => x.id === selectedId); if (m) { m.ua = e.target.value; renderMap(svg, state, { onSelect: selectNode }); $("#selTitle").textContent = m.ua; } });
$("#selDesc").addEventListener("input", (e) => { const m = state.modes.find((x) => x.id === selectedId); if (m) { m.descriptors = linesToArr(e.target.value); renderMap(svg, state, { onSelect: selectNode }); } });
$("#selScene").addEventListener("change", (e) => { const m = state.modes.find((x) => x.id === selectedId); if (m) { m.scene = e.target.value; m.x = null; m.y = null; renderMap(svg, state, { onSelect: selectNode }); } });
$("#selSize").addEventListener("input", (e) => { const m = state.modes.find((x) => x.id === selectedId); if (m) { m.sizeMul = +e.target.value; renderMap(svg, state, { onSelect: selectNode }); } });
$("#selDelete").addEventListener("click", () => { state.modes = state.modes.filter((x) => x.id !== selectedId); selectedId = null; renderAll(); });

// ---------- проблеми / цілі ----------
$("#problems").addEventListener("input", (e) => { state.problems = linesToArr(e.target.value); renderMap(svg, state, { onSelect: selectNode }); });
$("#goals").addEventListener("input", (e) => { state.goals = linesToArr(e.target.value); renderMap(svg, state, { onSelect: selectNode }); });

// ---------- палітра toggle ----------
$("#addBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#palette").classList.toggle("hidden"); });
document.addEventListener("click", (e) => { if (!e.target.closest(".palette-wrap")) $("#palette").classList.add("hidden"); });

// ---------- експорт ----------
$("#png").addEventListener("click", () => downloadMapPNG(svg));
$("#printBtn").addEventListener("click", () => printSheets(svg, planHTML()));
$("#zoomIn").addEventListener("click", () => zoomBy(svg, state, 1.2));
$("#zoomOut").addEventListener("click", () => zoomBy(svg, state, 1 / 1.2));
$("#zoomFit").addEventListener("click", () => zoomFit(svg, state));

// ---------- збереження/завантаження ----------
$("#save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "concept-case.json"; a.click();
});
$("#load").addEventListener("click", () => $("#loadFile").click());
$("#loadFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { Object.assign(state, JSON.parse(await f.text())); selectedId = null; renderAll(); setProgress("Завантажено з файлу.", ""); }
  catch (err) { setProgress("Не вдалося прочитати файл: " + err.message, "err"); }
});

// ---------- історія сесії (карти + плани, у localStorage) ----------
const HKEY = "stHistory_v1";
function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch { return []; } }
function saveHistory(arr) { localStorage.setItem(HKEY, JSON.stringify(arr.slice(-30))); }
function snapState() {
  return {
    patientSummary: state.patientSummary,
    problems: [...state.problems], goals: [...state.goals],
    modes: JSON.parse(JSON.stringify(state.modes)),
    plan: JSON.parse(JSON.stringify(state.plan)),
    planDoc: state.planDoc, transcript: $("#transcript").value,
  };
}
function addSnapshot(label) {
  const arr = loadHistory();
  const ts = Date.now();
  const lbl = (label || state.patientSummary || ("Випадок " + (arr.length + 1))).trim().slice(0, 70);
  const item = { id: "s" + ts + "_" + Math.floor(performance.now()), ts, label: lbl, snap: snapState() };
  arr.push(item);
  saveHistory(arr); renderHistory();
  if (currentUser && cloud) cloud.cloudPutSnapshot(currentUser.uid, item).catch((e) => console.warn("cloud put", e));
}
function restoreSnapshot(id) {
  const item = loadHistory().find((x) => x.id === id); if (!item) return;
  const s = item.snap;
  state.patientSummary = s.patientSummary || "";
  state.problems = s.problems || []; state.goals = s.goals || [];
  state.modes = s.modes || []; state.plan = s.plan || state.plan; state.planDoc = s.planDoc || "";
  $("#transcript").value = s.transcript || "";
  selectedId = null; renderAll(); switchTab("map");
  toast("Відновлено з історії.", "info");
}
function delSnapshot(id) {
  saveHistory(loadHistory().filter((x) => x.id !== id)); renderHistory();
  if (currentUser && cloud) cloud.cloudDeleteSnapshot(currentUser.uid, id).catch((e) => console.warn("cloud del", e));
}
function renderHistory() {
  const host = $("#historyList"); if (!host) return; host.innerHTML = "";
  for (const it of loadHistory().slice().reverse()) {
    const d = new Date(it.ts);
    const hh = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const row = document.createElement("div"); row.className = "hist-item";
    const lab = document.createElement("span"); lab.className = "hist-label"; lab.title = it.label; lab.textContent = it.label + " · " + hh;
    lab.addEventListener("click", () => restoreSnapshot(it.id));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "×"; del.title = "Видалити";
    del.addEventListener("click", () => delSnapshot(it.id));
    row.append(lab, del); host.appendChild(row);
  }
}
$("#snapSave").addEventListener("click", () => {
  if (!state.modes.length) { toast("Немає що зберігати — спершу аналіз або демо.", "error"); return; }
  addSnapshot(); toast("Збережено в історію ✓", "success");
});

// ---------- хмарна синхронізація (Firebase, опційно) ----------
function renderAuthUI(user) {
  const loginBtn = $("#loginBtn"), userBox = $("#userBox"), email = $("#userEmail"), hint = $("#syncHint");
  if (!loginBtn) return;
  if (user) {
    loginBtn.classList.add("hidden");
    userBox.classList.remove("hidden");
    const who = user.email || user.displayName || "акаунт";
    email.textContent = who; email.title = who;
    if (hint) hint.innerHTML = "☁ Синхронізується з акаунтом <b>" + who + "</b> — історія й ключі доступні на всіх пристроях.";
  } else {
    loginBtn.classList.remove("hidden");
    userBox.classList.add("hidden");
    email.textContent = ""; email.title = "";
    if (hint) hint.innerHTML = "🔒 Зберігається в цьому браузері. <b>Увійди через Google</b> (вгорі) — і історія з ключами синхронізуються між пристроями.";
  }
}

async function handleAuth(user) {
  currentUser = user || null;
  renderAuthUI(currentUser);
  if (!currentUser || !cloud) return;
  try {
    const { history: cloudHist, keys } = await cloud.cloudLoadAll(currentUser.uid);
    // ключі: якщо локально нема — беремо з хмари; якщо є локальні — піднімаємо в хмару
    const k = getKeys();
    if (keys && (!k.gemini || !k.anthropic)) {
      if (keys.gk && !k.gemini) localStorage.setItem("gk", keys.gk);
      if (keys.ak && !k.anthropic) localStorage.setItem("ak", keys.ak);
      updateKeyStatus();
    } else if (k.gemini || k.anthropic) {
      cloud.cloudSaveKeys(currentUser.uid, { gk: k.gemini, ak: k.anthropic }).catch(() => {});
    }
    // історія: об'єднуємо локальну й хмарну за id
    const local = loadHistory();
    const byId = new Map();
    for (const it of [...cloudHist, ...local]) if (it && it.id) byId.set(it.id, it);
    const merged = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    saveHistory(merged); renderHistory();
    // локальні записи, яких нема в хмарі — заливаємо
    const cloudIds = new Set(cloudHist.map((x) => x.id));
    for (const it of local) if (!cloudIds.has(it.id)) cloud.cloudPutSnapshot(currentUser.uid, it).catch(() => {});
    toast("Синхронізовано з хмарою ✓ Історія: " + merged.length, "success");
  } catch (e) {
    toast("Хмара недоступна: " + (e.message || e), "error", 6000);
  }
}

async function initCloud() {
  try {
    cloud = await import("./firebase-config.js");
  } catch (e) {
    console.warn("Firebase не завантажено (працюємо локально):", e);
    return;
  }
  cloud.onAuth(handleAuth);
}

$("#loginBtn")?.addEventListener("click", async () => {
  if (!cloud) { toast("Хмара ще вантажиться або немає інтернету. Онови сторінку.", "error", 6000); return; }
  try { await cloud.signInGoogle(); }
  catch (e) {
    const code = String(e.code || e.message || "");
    if (code.includes("popup-closed") || code.includes("cancelled") || code.includes("popup-blocked")) toast("Вхід скасовано (або браузер блокує спливне вікно).", "info");
    else toast("Не вдалося увійти: " + code, "error", 7000);
  }
});
$("#logoutBtn")?.addEventListener("click", async () => {
  if (!cloud) return;
  try { await cloud.signOutUser(); toast("Ви вийшли. Локальна історія лишилась на цьому пристрої.", "info"); } catch {}
});

init();
renderHistory();
