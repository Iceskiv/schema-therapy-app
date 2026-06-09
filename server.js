import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import {
  buildSystemPrompt,
  OUTPUT_TOOL,
  SAMPLE_ANALYSIS,
  clientCatalog,
} from "./knowledge/schema-knowledge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: path.join(os.tmpdir(), "schema-uploads"),
  limits: { fileSize: 400 * 1024 * 1024 },
});

// --- ліниві клієнти (щоб сервер стартував навіть без ключів — для демо-режиму) ---
let anthropic = null;
let genai = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY не заданий у файлі .env");
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}
function getGenAI() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не заданий у файлі .env");
  if (!genai) genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genai;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mimeFromName(name) {
  const ext = (name || "").toLowerCase().split(".").pop();
  return (
    {
      mp3: "audio/mp3", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
      opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
      mp4: "audio/mp4", webm: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff",
    }[ext] || "audio/mpeg"
  );
}

// Конвертуємо будь-яке аудіо/відео у компактний mono-mp3 (надійно для Gemini).
function convertToMp3(inputPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const out = inputPath + ".conv.mp3";
    const args = ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out];
    const p = spawn(ffmpegPath, args);
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 && fs.existsSync(out) ? out : null));
  });
}

// --- статус / каталог / демо ---
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasGemini: !!process.env.GEMINI_API_KEY,
    hasClaude: !!process.env.ANTHROPIC_API_KEY,
    hasFfmpeg: !!ffmpegPath,
    claudeModel: CLAUDE_MODEL,
    geminiModel: GEMINI_MODEL,
  });
});
app.get("/api/catalog", (req, res) => res.json(clientCatalog()));
app.get("/api/sample", (req, res) => res.json(SAMPLE_ANALYSIS));

// --- 1) ТРАНСКРИПЦІЯ (Gemini) ---
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const tmp = req.file?.path;
  let converted = null;
  let uploaded = null;
  try {
    if (!tmp) return res.status(400).json({ error: "Файл аудіо не отримано." });
    const ai = getGenAI();
    converted = await convertToMp3(tmp);
    const sendPath = converted || tmp;
    const mime = converted ? "audio/mp3" : mimeFromName(req.file.originalname);

    uploaded = await ai.files.upload({ file: sendPath, config: { mimeType: mime } });
    // Очікуємо, поки файл стане ACTIVE
    let f = uploaded;
    for (let i = 0; i < 80 && f.state !== "ACTIVE"; i++) {
      if (f.state === "FAILED") throw new Error("Gemini не зміг обробити аудіофайл (формат?).");
      await sleep(1500);
      f = await ai.files.get({ name: uploaded.name });
    }
    if (f.state !== "ACTIVE") throw new Error("Аудіо обробляється задовго. Спробуй ще раз або коротший файл.");

    const prompt =
      "Це аудіозапис клінічного випадку (лекторка зачитує кейс пацієнта; очікувана мова — українська). " +
      "Зроби максимально точну ДОСЛІВНУ транскрипцію тією мовою, якою реально говорять. НЕ перекладай. " +
      "Поверни ЛИШЕ текст транскрипції, без коментарів і часових міток.";
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([createPartFromUri(f.uri, f.mimeType), prompt]),
    });
    const transcript = (result.text || "").trim();
    res.json({ transcript });
  } catch (e) {
    console.error("transcribe error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  } finally {
    try { if (tmp) fs.unlinkSync(tmp); } catch {}
    try { if (converted) fs.unlinkSync(converted); } catch {}
    try { if (uploaded?.name) await getGenAI().files.delete({ name: uploaded.name }); } catch {}
  }
});

// --- 2) АНАЛІЗ (Claude, із завантаженою базою знань + кешуванням) ---
app.post("/api/analyze", async (req, res) => {
  try {
    const transcript = (req.body?.transcript || "").trim();
    if (!transcript) return res.status(400).json({ error: "Порожній транскрипт." });
    if (transcript.length < 40) return res.status(400).json({ error: "Транскрипт надто короткий для аналізу." });

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: [OUTPUT_TOOL],
      tool_choice: { type: "tool", name: OUTPUT_TOOL.name },
      messages: [
        {
          role: "user",
          content:
            "Ось транскрипт усно представленого випадку. Побудуй концептуалізацію у моделі схема-терапії та план по 3 етапах через інструмент submit_conceptualization.\n\n<transcript>\n" +
            transcript +
            "\n</transcript>",
        },
      ],
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (!toolUse) return res.status(502).json({ error: "Модель не повернула структуровану відповідь." });
    res.json({ analysis: toolUse.input, usage: msg.usage });
  } catch (e) {
    console.error("analyze error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- Завантаження транскрипту/завдання з посилання (обхід CORS) ---
app.post("/api/fetch-url", async (req, res) => {
  try {
    const url = (req.body?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Вкажи коректне http(s) посилання." });
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return res.status(502).json({ error: "Не вдалося завантажити: HTTP " + r.status });
    const ct = r.headers.get("content-type") || "";
    let text = await r.text();
    if (ct.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|h\d|li|br|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
    res.json({ text: text.slice(0, 80000) });
  } catch (e) {
    console.error("fetch-url error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log("\n  Схема-терапія: концептуалізація випадку");
  console.log("  ▶  Відкрий у браузері:  http://localhost:" + PORT + "\n");
  if (!process.env.GEMINI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.log("  ⚠  Ключі не задані у .env — працює лише ДЕМО-режим (без аудіо/аналізу).\n");
  }
});
