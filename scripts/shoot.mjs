/**
 * shoot.mjs — verifica visiva headless del redesign (v2.3.2).
 *
 * Avvia un server statico per dist/ e cattura screenshot dell'app in
 * anteprima web (mock in-memory): rosa, hover card, tooltip glossario,
 * menu stato, finestra WM, empty-state styling.
 *
 * Uso:  npm run build && node scripts/shoot.mjs [outDir]
 * Richiede: npx playwright install chromium
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.resolve(ROOT, process.argv[2] ?? "shots");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(DIST, urlPath);
  if (!existsSync(file) || urlPath === "/") file = path.join(DIST, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(4173, "127.0.0.1", r));
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE:", m.text());
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
await page.waitForSelector(".pcard-shell", { timeout: 15000 });
await page.waitForTimeout(600); // font CDN + settle

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// 1 — vista rosa completa
await shot("01-rosa");

// 2 — hover sulla seconda card (sollevamento + azioni)
await page.locator(".pcard-shell").nth(1).hover();
await page.waitForTimeout(400);
await shot("02-hover");

// 3 — tooltip glossario (hover sul ? della stat f₥ della prima card)
await page.locator(".pcard-shell").first().locator(".glossary-tooltip-glyph").nth(2).hover();
await page.waitForTimeout(500);
await shot("03-tooltip");
await page.mouse.move(720, 850);
await page.waitForTimeout(400);

// 4 — menu toggle stato (click sul timbro)
await page.locator(".pcard-shell").nth(2).locator("span[title*='cambiare stato']").click();
await page.waitForTimeout(350);
await shot("04-status-menu");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

// 5 — finestra WM in-app (click sulla prima card)
await page.locator(".pcard-shell").first().click();
await page.waitForTimeout(600);
await shot("05-window-wm");

// 6 — viewport stretto (1280) per controllo reflow
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(400);
await shot("06-1280-wm");

await browser.close();
server.close();
console.log("shots ->", OUT);
