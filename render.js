// Карта часток. Усі кола — ОДНОГО кольору (синій контур, біла заливка, синя назва,
// чорний дрібніший опис). Ширша горизонтальна раскладка. Зум/пан + перетягування часток.

const SVGNS = "http://www.w3.org/2000/svg";
export const MAP_W = 1460;
export const MAP_H = 760;
const MONO = "#2E5E8C"; // єдиний колір для всіх часток

const AXIS_X = 372;
const TOP_Y = 104;
const BOTTOM_Y = 688;
const INTERNAL_X = 182;
const EXTERNAL_X = 600;
const IN_TOP = 232, IN_BOTTOM = 672;
const EX_TOP = 214, EX_BOTTOM = 684;
const PROB_X = 812, PROB_W = 300;
const GOAL_X = 1140, GOAL_W = 300;
const HDR_Y = 150;
const ZMIN = 0.5, ZMAX = 4;

function el(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}
function wrap(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > maxChars) { lines.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
function tspans(lines, x, startY, lineH, attrs = {}) {
  return lines.map((ln, i) => el("tspan", { x, y: startY + i * lineH, ...attrs }, [document.createTextNode(ln)]));
}

function radiusFor(m) {
  const b = m.baseId || m.id;
  let base;
  if (m.scene === "top" || b === "healthy_adult") base = 58;
  else if (m.scene === "bottom" || b === "happy_child") base = 50;
  else if (b === "vulnerable_child") base = 128;
  else if (m.category === "parent") base = 108;
  else if (m.category === "child") base = 92;
  else base = 100;
  return base * (m.sizeMul || 1); // ручний множник розміру частки
}
function nodeContent(m) {
  const rx = radiusFor(m);
  const small = rx <= 62;
  const nameFont = rx >= 118 ? 17 : rx >= 96 ? 15.5 : small ? 12.5 : 14.5;
  const subFont = rx >= 96 ? 11 : 10.5;
  const nameMax = Math.max(7, Math.round((rx * 1.5) / (nameFont * 0.52)));
  const nameLines = wrap(m.ua, nameMax);
  let subLines = [];
  const desc = (m.descriptors || []).filter(Boolean);
  if (desc.length && !small) {
    const subMax = Math.max(10, Math.round((rx * 1.5) / (subFont * 0.5)));
    subLines = wrap(desc.join(", "), subMax).slice(0, 4);
  }
  const nameLH = nameFont + 3, subLH = subFont + 2;
  const contentH = nameLines.length * nameLH + (subLines.length ? 6 + subLines.length * subLH : 0);
  const ry = Math.max(rx * 0.86, contentH / 2 + 12);
  return { rx, ry, nameFont, subFont, nameLines, subLines, nameLH, subLH, contentH };
}

function drawNode(m, onSelect) {
  const c = nodeContent(m);
  const s = m._scale || 1;
  const rx = c.rx * s, ry = c.ry * s, nameFont = c.nameFont * s, subFont = c.subFont * s;
  const nameLH = c.nameLH * s, subLH = c.subLH * s, contentH = c.contentH * s;
  const g = el("g", { class: "st-node", "data-id": m.id, transform: `translate(${m.x},${m.y})`, style: "cursor:grab" });
  g.appendChild(el("ellipse", { cx: 0, cy: 0, rx, ry, fill: "#ffffff", stroke: MONO, "stroke-width": 3 }));
  let y = -contentH / 2 + nameFont;
  const name = el("text", { "text-anchor": "middle", "font-size": nameFont.toFixed(1), "font-weight": 700, fill: MONO });
  name.append(...tspans(c.nameLines, 0, y, nameLH, { "text-anchor": "middle" }));
  g.appendChild(name);
  if (c.subLines.length) {
    y += c.nameLines.length * nameLH + 6 * s;
    const sub = el("text", { "text-anchor": "middle", "font-size": subFont.toFixed(1), fill: "#333333" });
    sub.append(...tspans(c.subLines, 0, y, subLH, { "text-anchor": "middle" }));
    g.appendChild(sub);
  }
  if (onSelect) g.addEventListener("click", () => { if (!g.dataset.dragged) onSelect(m.id); });
  return g;
}

function drawPanel(title, items, x, y, w) {
  const g = el("g");
  g.appendChild(el("text", { x, y, "font-size": 16, "font-weight": 700, fill: "#1a1a1a", "text-decoration": "underline" }, [document.createTextNode(title)]));
  let cy = y + 28;
  const maxChars = Math.max(16, Math.floor(w / 7.0));
  (items || []).forEach((it, i) => {
    const lines = wrap(`${i + 1}. ${it}`, maxChars);
    const t = el("text", { "font-size": 12.5, fill: "#1a1a1a" });
    t.append(...tspans(lines, x, cy, 16, {}));
    g.appendChild(t);
    cy += lines.length * 16 + 7;
  });
  return g;
}
function wavyAxis(x, y0, y1) {
  const pts = [];
  const steps = 44, amp = 15;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(`${(x + amp * Math.sin(t * Math.PI * 5)).toFixed(1)},${(y0 + (y1 - y0) * t).toFixed(1)}`);
  }
  return el("polyline", { points: pts.join(" "), fill: "none", stroke: "#7fa9cf", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" });
}

function scaleFor(arr, top, bottom) {
  if (arr.length < 1) return 1;
  const rys = arr.map((m) => nodeContent(m).ry);
  const need = rys.reduce((s, r) => s + 2 * r, 0) + 10 * (arr.length - 1);
  const band = bottom - top;
  return need > band ? Math.max(0.6, band / need) : 1;
}
function placeColumn(arr, colX, top, bottom, scale) {
  if (!arr.length) return;
  const sRys = arr.map((m) => nodeContent(m).ry * scale);
  const band = bottom - top;
  const sumD = sRys.reduce((s, r) => s + 2 * r, 0);
  let gap = arr.length > 1 ? Math.min(28, (band - sumD) / (arr.length - 1)) : 0;
  if (gap < 4) gap = 4;
  const used = sumD + gap * (arr.length - 1);
  let y = top + Math.max(0, (band - used) / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i]._scale = scale;
    const r = sRys[i];
    if (arr[i].x == null || arr[i].y == null) { arr[i].x = colX; arr[i].y = y + r; }
    y += 2 * r + gap;
  }
}
function layout(state) {
  const internal = [], external = [];
  for (const m of state.modes) {
    if (m.scene === "top") { m._scale = 1; if (m.x == null) m.x = AXIS_X; if (m.y == null) m.y = TOP_Y; continue; }
    if (m.scene === "bottom") { m._scale = 1; if (m.x == null) m.x = AXIS_X - 6; if (m.y == null) m.y = BOTTOM_Y; continue; }
    (m.scene === "external" ? external : internal).push(m);
  }
  const rank = (m) => { const b = m.baseId || m.id; if (m.category === "parent") return 0; if (b === "vulnerable_child") return 2; return 1; };
  internal.sort((a, b) => rank(a) - rank(b));
  const scale = Math.min(scaleFor(internal, IN_TOP, IN_BOTTOM), scaleFor(external, EX_TOP, EX_BOTTOM));
  placeColumn(internal, INTERNAL_X, IN_TOP, IN_BOTTOM, scale);
  placeColumn(external, EXTERNAL_X, EX_TOP, EX_BOTTOM, scale);
}

// ---- зум / пан ----
const clampZ = (z) => Math.max(ZMIN, Math.min(ZMAX, z));
export function applyView(svg, state) {
  const vp = svg.querySelector(".viewport");
  if (!vp) return;
  const v = state._view || (state._view = { z: 1, x: 0, y: 0 });
  vp.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.z})`);
}
export function zoomAround(state, px, py, factor) {
  const v = state._view || (state._view = { z: 1, x: 0, y: 0 });
  const z2 = clampZ(v.z * factor);
  v.x = px - (z2 / v.z) * (px - v.x);
  v.y = py - (z2 / v.z) * (py - v.y);
  v.z = z2;
}
export function zoomBy(svg, state, factor) { zoomAround(state, MAP_W / 2, MAP_H / 2, factor); applyView(svg, state); }
export function zoomFit(svg, state) { state._view = { z: 1, x: 0, y: 0 }; applyView(svg, state); }

export function renderMap(svg, state, opts = {}) {
  if (!state._view) state._view = { z: 1, x: 0, y: 0 };
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute("viewBox", `0 0 ${MAP_W} ${MAP_H}`);
  svg.appendChild(el("rect", { x: 0, y: 0, width: MAP_W, height: MAP_H, fill: "#ffffff", class: "st-bg" }));

  const vp = el("g", { class: "viewport" });
  svg.appendChild(vp);

  vp.appendChild(el("text", { x: MAP_W / 2, y: 44, "text-anchor": "middle", "font-size": 23, "font-weight": 700, fill: "#1a1a1a", "letter-spacing": "0.6" }, [document.createTextNode("КОНЦЕПТУАЛІЗАЦІЯ ВИПАДКУ")]));
  vp.appendChild(wavyAxis(AXIS_X, TOP_Y + 34, BOTTOM_Y - 28));

  layout(state);
  for (const m of state.modes) vp.appendChild(drawNode(m, opts.onSelect));
  vp.appendChild(drawPanel("Проблеми:", state.problems, PROB_X, HDR_Y, PROB_W));
  vp.appendChild(drawPanel("Цілі:", state.goals, GOAL_X, HDR_Y, GOAL_W));

  applyView(svg, state);
  if (opts.draggable !== false) enableInteract(svg, state);
  return svg;
}

function enableInteract(svg, state) {
  const vp = svg.querySelector(".viewport");
  let node = null, nstart = null;     // перетягування частки
  let pan = null;                     // панорамування
  const pt = svg.createSVGPoint();
  const inVp = (e) => { pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(vp.getScreenCTM().inverse()); };
  const inBox = (e) => { pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };

  svg.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".st-node");
    if (g) {
      node = g; delete g.dataset.dragged;
      const m = state.modes.find((x) => x.id === g.getAttribute("data-id"));
      const p = inVp(e); nstart = { px: p.x, py: p.y, m };
      g.setPointerCapture(e.pointerId); g.style.cursor = "grabbing";
    } else {
      const p = inBox(e); pan = { px: p.x, py: p.y, vx: state._view.x, vy: state._view.y };
      svg.style.cursor = "grabbing"; svg.setPointerCapture(e.pointerId);
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (node && nstart) {
      const p = inVp(e);
      const nx = nstart.m.x + (p.x - nstart.px), ny = nstart.m.y + (p.y - nstart.py);
      if (Math.abs(p.x - nstart.px) + Math.abs(p.y - nstart.py) > 2) node.dataset.dragged = "1";
      nstart.m.x = nx; nstart.m.y = ny; nstart.px = p.x; nstart.py = p.y;
      node.setAttribute("transform", `translate(${nx},${ny})`);
    } else if (pan) {
      const p = inBox(e);
      state._view.x = pan.vx + (p.x - pan.px);
      state._view.y = pan.vy + (p.y - pan.py);
      applyView(svg, state);
    }
  });
  const end = () => { if (node) node.style.cursor = "grab"; svg.style.cursor = "grab"; node = null; nstart = null; pan = null; };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = inBox(e);
    zoomAround(state, p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    applyView(svg, state);
  }, { passive: false });
  svg.style.cursor = "grab";
}
