import { renderMap, zoomBy, zoomFit } from "./render.js";
import { downloadMapPNG, printSheets } from "./export.js";

const $ = (s) => document.querySelector(s);
const svg = $("#map");

let catalog = null;
let currentAudio = null; // File | Blob
let mediaRec = null;
let recChunks = [];
let selectedId = null;

const state = {
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
function uniqueId(base) {
  let id = base, i = 2;
  while (state.modes.some((m) => m.id === id)) id = base + "__" + i++;
  return id;
}
function defById(id) { return (catalog.modes || []).find((m) => m.id === id) || {}; }

// ---------- ініціалізація ----------
async function init() {
  try {
    const [cat, health] = await Promise.all([
      fetch("/api/catalog").then((r) => r.json()),
      fetch("/api/health").then((r) => r.json()).catch(() => ({})),
    ]);
    catalog = cat;
    state.catalog = cat; // render.js читає state.catalog
    const st = $("#status");
    if (health.hasGemini && health.hasClaude) {
      st.textContent = `Ключі підключені · ${health.claudeModel}`;
      st.className = "status ok";
    } else {
      st.textContent = "Демо-режим · додай ключі в .env";
      st.className = "status warn";
    }
    buildPalette();
    buildReference();
    renderAll();
  } catch (e) {
    setProgress("Помилка завантаження каталогу: " + e.message, "err");
  }
}

// ---------- маппінг аналізу у стан ----------
function applyAnalysis(a) {
  state.patientSummary = a.patient_summary || "";
  state.problems = a.problems || [];
  state.goals = a.goals || [];
  state.modes = [];
  let hasHealthy = false, hasHappy = false;
  for (const m of a.modes || []) {
    const def = defById(m.id);
    const node = {
      id: uniqueId(m.id || "mode"),
      baseId: def.id || m.id,
      ua: m.ua_name || def.ua || m.id,
      category: def.category || "coping",
      scene: def.scene || "external",
      descriptors: m.descriptors || [],
      linked: m.linked_schemas || [],
    };
    if (def.id === "healthy_adult") hasHealthy = true;
    if (def.id === "happy_child") hasHappy = true;
    state.modes.push(node);
  }
  if (!hasHealthy) addModeById("healthy_adult", false);
  // happy_child — лише якщо модель додала (це орієнтир)
  const plan = a.plan || {};
  for (const k of ["stage1", "stage2", "stage3"]) {
    state.plan[k] = {
      description: plan[k]?.description || "",
      modes: plan[k]?.modes || [],
      techniques: plan[k]?.techniques || [],
    };
  }
  state.planDoc = ""; // перебудувати документ плану з нового аналізу
  selectedId = null;
  renderAll();
  switchTab("map");
}

function addModeById(id, rerender = true) {
  const def = defById(id);
  if (!def.id) return;
  const node = { id: uniqueId(def.id), baseId: def.id, ua: def.ua, category: def.category, scene: def.scene, descriptors: [], linked: def.schemas || [] };
  state.modes.push(node);
  if (rerender) { renderAll(); }
}

// ---------- рендер усього ----------
function renderAll() {
  renderMap(svg, state, { onSelect: selectNode });
  $("#problems").value = arrToLines(state.problems);
  $("#goals").value = arrToLines(state.goals);
  renderSelected();
  renderPlan();
  refreshPaletteState();
}

function selectNode(id) {
  selectedId = id;
  renderSelected();
}
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
      chip.className = "chip";
      chip.dataset.id = m.id;
      chip.style.borderColor = catalog.categoryColors[m.category];
      chip.textContent = m.ua;
      chip.title = m.def || "";
      chip.addEventListener("click", () => { addModeById(m.id); });
      g.appendChild(chip);
    }
    box.appendChild(g);
  }
}
function refreshPaletteState() {
  const present = new Set(state.modes.map((m) => defById(m.id).id || m.id));
  // позначаємо унікальні (один екземпляр) — лишаємо клікабельними завжди, але підсвічуємо наявні
  document.querySelectorAll("#palette .chip").forEach((c) => {
    c.dataset.on = present.has(c.dataset.id) ? "1" : "";
  });
}

// ---------- план (один редагований документ, розбитий на абзаци) ----------
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
  doc.className = "plan-doc";
  doc.id = "planDoc";
  doc.contentEditable = "true";
  doc.spellcheck = false;
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
  // частки
  const grpModes = document.createElement("div");
  grpModes.className = "ref-grp";
  grpModes.innerHTML = "<h3>Частки (modes)</h3>";
  catalog.modes.forEach((m) => {
    const it = document.createElement("div");
    it.className = "ref-item";
    it.dataset.text = (m.ua + " " + (m.def || "") + " " + (m.task || "")).toLowerCase();
    it.innerHTML = `<b>${m.ua}</b><span class="tag" style="background:${catalog.categoryColors[m.category]}">${m.category}</span><br><small>${m.def || ""}</small>${m.task ? `<br><small><b>Завдання:</b> ${m.task}</small>` : ""}`;
    grpModes.appendChild(it);
  });
  body.appendChild(grpModes);
  // схеми
  const grpS = document.createElement("div");
  grpS.className = "ref-grp";
  grpS.innerHTML = "<h3>18 ранніх дезадаптивних схем</h3>";
  catalog.schemas.forEach((s) => {
    const it = document.createElement("div");
    it.className = "ref-item";
    it.dataset.text = (s.name + " " + s.short + " " + s.domain).toLowerCase();
    it.innerHTML = `<b>${s.name}</b><br><small>${s.short} · <i>${s.domain}</i></small>`;
    grpS.appendChild(it);
  });
  body.appendChild(grpS);
  // потреби
  const grpN = document.createElement("div");
  grpN.className = "ref-grp";
  grpN.innerHTML = "<h3>Базові потреби</h3>";
  catalog.basicNeeds.forEach((n) => {
    const it = document.createElement("div");
    it.className = "ref-item";
    it.dataset.text = n.toLowerCase();
    it.innerHTML = `<small>• ${n}</small>`;
    grpN.appendChild(it);
  });
  body.appendChild(grpN);
}
$("#refSearch")?.addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#refBody .ref-item").forEach((it) => {
    it.style.display = !q || it.dataset.text.includes(q) ? "" : "none";
  });
});

// ---------- вкладки ----------
function switchTab(name) {
  document.querySelector(".workspace").dataset.tab = name; // для показу/приховування дій тільки для карти
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

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
  setProgress("Транскрибуємо аудіо (Gemini)… це може зайняти 1–3 хв", "busy");
  $("#transcribe").disabled = true;
  try {
    const fd = new FormData();
    fd.append("audio", currentAudio, currentAudio.name || "audio.webm");
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Помилка транскрипції");
    $("#transcript").value = data.transcript || "";
    setProgress("Готово. Перевір транскрипт і натисни «Аналізувати».", "");
  } catch (e) {
    setProgress("Помилка: " + e.message, "err");
  } finally { $("#transcribe").disabled = false; }
});

$("#analyze").addEventListener("click", async () => {
  const transcript = $("#transcript").value.trim();
  if (!transcript) { setProgress("Спершу додай транскрипт (або встав текст).", "err"); return; }
  setProgress("Аналізуємо випадок (Claude)…", "busy");
  $("#analyze").disabled = true;
  try {
    const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Помилка аналізу");
    applyAnalysis(data.analysis);
    setProgress("Готово ✓ Перевір і відредагуй карту й план перед експортом.", "");
  } catch (e) {
    setProgress("Помилка: " + e.message, "err");
  } finally { $("#analyze").disabled = false; }
});

// ---------- демо ----------
$("#demo").addEventListener("click", async () => {
  setProgress("Завантажую демо-приклад…", "busy");
  try {
    const a = await fetch("/api/sample").then((r) => r.json());
    applyAnalysis(a);
    setProgress("Демо-приклад завантажено. Спробуй редагування й експорт.", "");
  } catch (e) { setProgress("Помилка демо: " + e.message, "err"); }
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
    const r = await fetch("/api/fetch-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Помилка завантаження");
    $("#transcript").value = (data.text || "").trim();
    setProgress("Завантажено з посилання. Перевір текст і «Аналізувати».", "");
  } catch (err) { setProgress("Помилка: " + err.message, "err"); }
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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "concept-case.json";
  a.click();
});
$("#load").addEventListener("click", () => $("#loadFile").click());
$("#loadFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    Object.assign(state, data);
    selectedId = null;
    renderAll();
    setProgress("Завантажено з файлу.", "");
  } catch (err) { setProgress("Не вдалося прочитати файл: " + err.message, "err"); }
});

init();
