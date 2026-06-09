// Експорт: PNG карти + друк/збереження PDF обох листів.
import { MAP_W, MAP_H } from "./render.js";

export function svgToPngDataURL(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const clone = svg.cloneNode(true);
    const vpc = clone.querySelector(".viewport");
    if (vpc) vpc.removeAttribute("transform"); // експорт завжди у повному вигляді (без зуму/пану)
    clone.setAttribute("width", MAP_W);
    clone.setAttribute("height", MAP_H);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(clone);
    const svg64 = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = MAP_W * scale;
      canvas.height = MAP_H * scale;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = svg64;
  });
}

export async function downloadMapPNG(svg, filename = "karta-chastok.png") {
  const url = await svgToPngDataURL(svg, 2);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

export async function printSheets(svg, planHTML, title = "Концептуалізація випадку") {
  const png = await svgToPngDataURL(svg, 2);
  const w = window.open("", "_blank");
  if (!w) { alert("Дозволь спливаючі вікна, щоб надрукувати."); return; }
  w.document.write(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>${title}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: Georgia, 'Times New Roman', serif; color:#1a1a1a; margin:0; }
    .sheet { page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    .map img { width: 100%; height: auto; border:1px solid #ddd; }
    .plan h2 { font-size: 15px; margin: 16px 0 4px; color:#1f4e79; border-bottom:1px solid #ccc; padding-bottom:3px; }
    .plan p { margin: 4px 0; font-size: 12.5px; line-height:1.45; }
    .plan .lbl { font-weight:700; }
    .plan ul { margin: 3px 0 8px 18px; padding:0; }
    .plan li { font-size: 12px; margin: 2px 0; }
    .muted { color:#666; font-size: 11px; }
  </style></head><body>
    <div class="sheet map"><h1>Карта часток · ${title}</h1><img src="${png}"></div>
    <div class="sheet plan">${planHTML}</div>
  </body></html>`);
  w.document.close();
  // даємо зображенню прогрузитися
  setTimeout(() => { w.focus(); w.print(); }, 500);
}
