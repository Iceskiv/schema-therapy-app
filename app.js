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
function setProgress(msg, kind = "") { const p = $("#progress"); p.textContent = msg || ""; p.className = "progress " + kind; }
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
  localStorage.setItem("gk", $("#kGemini").value.trim());
  localStorage.setItem("ak", $("#kAnthropic").value.trim());
  updateKeyStatus();
  $("#settings").classList.add("hidden");
  setProgress("Ключі збережено у цьому браузері.", "");
});

// ---------- аудіо ----------
function setAudio(f, label) { currentAudio = f; $("#fileName").textContent = label || (f?.name || "запис готовий"); $("#transcribe").disabled = !f; }
$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) setAudio(f); });
const drop = $("#drop");
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setAudio(f); });

$("#rec").addEventListener("click", async () => {
  if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    mediaRec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
      setAudio(blob, `🎙 запис (${Math.round(blob.size / 1024)} КБ)`);
      $("#rec").textContent = "🎙 Запис з мікрофона";
    };
    mediaRec.start();
    $("#rec").textContent = "⏹ Зупинити запис";
  } catch (e) { setProgress("Немає доступу до мікрофона: " + e.message, "err"); }
});

$("#transcribe").addEventListener("click", async () => {
  if (!currentAudio) return;
  setProgress("Транскрибуємо аудіо (Gemini)… може зайняти 1–3 хв", "busy");
  $("#transcribe").disabled = true;
  try {
    $("#transcript").value = await transcribeAudio(currentAudio);
    setProgress("Готово. Перевір транскрипт і натисни «Аналізувати».", "");
  } catch (e) { setProgress("Помилка: " + e.message, "err"); }
  finally { $("#transcribe").disabled = false; }
});

$("#analyze").addEventListener("click", async () => {
  const transcript = $("#transcript").value.trim();
  if (!transcript) { setProgress("Спершу додай транскрипт (або встав текст).", "err"); return; }
  setProgress("Аналізуємо випадок (Claude)…", "busy");
  $("#analyze").disabled = true;
  try {
    applyAnalysis(await analyzeTranscript(transcript));
    setProgress("Готово ✓ Перевір і відредагуй карту й план перед експортом.", "");
  } catch (e) { setProgress("Помилка: " + e.message, "err"); }
  finally { $("#analyze").disabled = false; }
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

init();
