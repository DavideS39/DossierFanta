/**
 * shoot-fogli.mjs — verifica visiva del restyling "finestre su fogli strappati" (v2.3.4).
 *
 * Serve dist/ e cattura: rosa, finestra singola, due finestre (active/inactive),
 * ghost snap al bordo, taskbar con foglio minimizzato.
 *
 * Uso: node scripts/shoot-fogli.mjs [outDir]
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, process.argv[2] ?? "shots-fogli");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
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
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector(".pcard-shell", { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "01-rosa.png") });

// Apri la prima scheda (finestra WM su foglio strappato)
const cards = page.locator(".pcard-shell");
await cards.nth(0).click();
await page.waitForSelector(".wf-shell", { timeout: 8000 });
await page.waitForTimeout(900); // animazione drop
await page.screenshot({ path: path.join(OUT, "02-finestra-foglio.png") });

// Seconda finestra: active vs inactive + rotazioni diverse
await cards.nth(1).click();
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, "03-due-fogli.png") });

// Snap ghost: trascina la finestra attiva verso il bordo sinistro
const head = page.locator(".wf-shell.is-active .wf-head").first();
const hb = await head.boundingBox();
if (hb) {
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 12);
  await page.mouse.down();
  await page.mouse.move(60, hb.y + 120, { steps: 12 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "04-snap-ghost.png") });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "05-snap-applicato.png") });
}

// Minimizza una finestra → taskbar a striscia strappata
await page.locator(".wf-shell.is-active .wf-btn").first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, "06-taskbar.png") });

await browser.close();
server.close();
console.log("shots in", OUT);
