// Локальний статичний сервер (лише для запуску на своєму ПК).
// На GitHub Pages цей файл не використовується — Pages віддає статику напряму.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(__dirname, { dotfiles: "deny" }));

const PORT = process.env.PORT || 5180;
app.listen(PORT, () => console.log("\n  Схема-терапія (статика) -> http://localhost:" + PORT + "\n"));
