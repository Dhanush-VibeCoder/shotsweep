#!/usr/bin/env node
import { Command } from "commander";
import { chromium, type Browser, type Page, type Locator, type BrowserContext } from "playwright";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error(`shotsweep needs Node.js 20 or newer (you have ${process.versions.node}). Get it at https://nodejs.org`);
  process.exit(1);
}

const pkgVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

/** Downloads Chromium with the Playwright that ships inside shotsweep (same version, so it always matches). */
function installChromium(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const cli = path.join(path.dirname(req.resolve("playwright/package.json")), "cli.js");
    return spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" }).status === 0;
  } catch {
    return spawnSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit", shell: true }).status === 0;
  }
}

/** Starts Chromium; on the very first run it downloads the browser automatically. */
async function launchBrowser(headless = true): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    if (!/Executable doesn't exist|playwright install/i.test((e as Error).message)) throw e;
    console.log("First run: downloading the Chromium browser used for screenshots (one time, about 150 MB) ...");
    if (!installChromium()) {
      console.error("Could not download Chromium. Run this yourself, then try again:\n  npx playwright install chromium");
      process.exit(1);
    }
    return chromium.launch({ headless });
  }
}

async function checkReachable(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    console.error(`Cannot reach ${url}. Is your dev server running? Start it, then run shotsweep again.`);
    process.exit(1);
  }
}

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|css|js|json|xml|txt|mp4|woff2?)$/i;

type Target = { route: string; click?: string; loggedOut?: boolean };
const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 3000);

function words(t: string): Set<string> {
  return new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** True if two screens have (nearly) the same text, so small dropdowns/numbers don't make them "different". */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const A = words(a);
  const B = words(b);
  if (A.size < 30 || B.size < 30) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.9;
}

function findSeen(seen: Map<string, string>, sig: string): string | undefined {
  for (const [k, v] of seen) if (similar(k, sig)) return v;
  return undefined;
}

type Shot = { route: string; url: string; viewport: string; file: string; title: string };

/** Turn any href into a same-origin "/path?query" route, or null if it should be skipped. */
function toRoute(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    if (SKIP_EXT.test(pathname)) return null;
    const hash = u.hash.length > 1 ? u.hash : ""; // keep #dashboard-style routes
    return pathname + u.search + hash;
  } catch {
    return null;
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function slugify(route: string): string {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60);
}

async function settle(page: Page, delay: number) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { });
  if (delay > 0) await page.waitForTimeout(delay);
}

const SKIP_LABELS = /delet|remov|log ?out|sign ?out|pay|buy|purchase|submit|checkout|clear|reset|cancel/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".nuxt", ".svelte-kit", "out", "coverage"]);

/** Source 1: sitemap.xml */
async function routesFromSitemap(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(new URL("/sitemap.xml", baseUrl));
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((m) => toRoute(m[1], baseUrl))
      .filter((r): r is string => !!r);
  } catch {
    return [];
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Source 2: read your project's source code (file-based routes + route strings in code) */
function routesFromProject(dir: string): string[] {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    console.log(`  project folder not found: ${root}`);
    return [];
  }
  const routes = new Set<string>();
  const clean = (r: string) => (r.startsWith("/") ? r : "/" + r).replace(/\/+$/, "") || "/";
  const dynamic = /[:*$\[\]{}?#.]/;

  for (const f of walk(root)) {
    const rel = "/" + path.relative(root, f).split(path.sep).join("/");

    // Next.js app router: app/**/page.tsx
    let m = rel.match(/\/app\/((?:.*\/)?)page\.(?:tsx|jsx|ts|js|mdx)$/);
    if (m) {
      const segs = m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s));
      if (!segs.some((s) => dynamic.test(s) || s.startsWith("@"))) routes.add(clean(segs.join("/")));
      continue;
    }
    // SvelteKit: routes/**/+page.svelte
    m = rel.match(/\/routes\/((?:.*\/)?)\+page\.svelte$/);
    if (m) {
      const segs = m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s));
      if (!segs.some((s) => dynamic.test(s))) routes.add(clean(segs.join("/")));
      continue;
    }
    // Pages router / Nuxt / Astro / Vue pages: pages/**/*.ext
    m = rel.match(/\/pages\/(.+)\.(?:tsx|jsx|ts|js|vue|svelte|astro|mdx|html)$/);
    if (m && !m[1].startsWith("_") && !m[1].startsWith("api/") && !m[1].includes("/_")) {
      const name = m[1].replace(/(^|\/)index$/, "");
      if (!dynamic.test(name)) routes.add(clean(name));
      continue;
    }
    // Route strings inside source: path="/about", path: 'contact', to="/pricing", href="/faq"
    if (/\.(tsx|jsx|ts|js|vue|svelte|astro|html)$/.test(f) && fs.statSync(f).size < 300_000) {
      const text = fs.readFileSync(f, "utf8");
      for (const mm of text.matchAll(/\b(path|to|href|route)\s*[=:]\s*\{?\s*["'`]([^"'`\s]*)["'`]/g)) {
        const [, key, val] = mm;
        if (!val || val.startsWith("//") || dynamic.test(val.replace(/^\//, "").replace(/\//g, ""))) continue;
        if (key !== "path" && !val.startsWith("/")) continue;
        if (/^\/?api(\/|$)/.test(val)) continue;
        routes.add(clean(val));
      }
    }
  }
  return [...routes];
}

// ---------- popups / onboarding overlays ----------
// Buttons we are willing to click to get rid of a popup, in priority order.
const DISMISS_ORDER: RegExp[] = [
  /^(skip|skip tour|skip all|skip for now|skip intro|maybe later|not now|no,? thanks)\b/i,
  /^(got it|done|finish|finished|complete|all set|let'?s (go|start|begin|get started)|ok|okay|understood|i understand|begin|explore|enter)\b/i,
  /^(close|dismiss|cancel|×|✕|✖|x)$/i,
  /^(get started|start|launch|open|continue|next|proceed|try it|go to)\b/i,
];
// Session reuse: once onboarding popups are closed, the browser's saved storage (cookies, localStorage)
// is reused for every later page/viewport, so the popups usually don't come back.
let reuseSession = true;
let sessionState: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
let authState: string | undefined; // path of the saved login state (cookies + localStorage), if any

async function snapshot(ctx: BrowserContext) {
  try {
    return await ctx.storageState({ indexedDB: true } as never);
  } catch {
    return ctx.storageState().catch(() => undefined);
  }
}
async function saveSession(ctx: BrowserContext) {
  if (reuseSession) sessionState = await snapshot(ctx);
}
async function saveStateToFile(ctx: BrowserContext, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await ctx.storageState({ path: file, indexedDB: true } as never);
  } catch {
    await ctx.storageState({ path: file });
  }
}

const warned = new Set<string>();
const warnOnce = (msg: string) => {
  if (!warned.has(msg)) {
    warned.add(msg);
    console.log(msg);
  }
};
let extraDismiss: string[] = []; // extra button labels from --popup-buttons (exact, lowercase)
const cleanLabel = (l: string) =>
  l.replace(/[’‘`]/g, "'").replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}×✕✖]+/u, "").trim();
const OVERLAY_RISK = /delet|remov|\bpay\b|purchase|checkout|log ?out|sign ?out|confirm/i;

/** Finds a modal / onboarding / tour overlay on top of the page and tags it with data-shotsweep-overlay. */
async function findOverlay(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    document.querySelectorAll("[data-shotsweep-overlay]").forEach((e) => e.removeAttribute("data-shotsweep-overlay"));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestScore = -1;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05 || r.width < 1 || r.height < 1) continue;
      if (!el.querySelector("button, [role=button], a")) continue;
      const isDialog = el.matches("[role=dialog], [aria-modal=true], dialog[open]");
      const z = parseInt(cs.zIndex || "0", 10) || 0;
      const bigFixed = cs.position === "fixed" && z >= 10 && (r.width * r.height) / (vw * vh) >= 0.35;
      if (!isDialog && !bigFixed) continue;
      const score = (isDialog ? 100000 : 0) + z;
      if (score >= bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (!best) return false;
    best.setAttribute("data-shotsweep-overlay", "1");
    return true;
  });
}

/**
 * Clicks through popups (e.g. a 2-step onboarding) until the page is clear. Fully dynamic:
 * it keeps going as long as a popup is on screen, and re-checks after each click because
 * the next step can fade in a moment later. `shoot` is called before each step is closed.
 */
async function dismissOverlays(page: Page, shoot?: (step: number) => Promise<void>): Promise<number> {
  let steps = 0;
  let rechecks = 0;
  let stuck = 0;
  let lastText = "";

  for (let guard = 0; guard < 15; guard++) {
    if (!(await findOverlay(page).catch(() => false))) {
      // After closing a step, the next one may still be animating in: look again before finishing
      if (steps > 0 && rechecks < 2) {
        rechecks++;
        await page.waitForTimeout(800);
        continue;
      }
      break;
    }
    rechecks = 0;

    const root = page.locator("[data-shotsweep-overlay]").first();
    const overlayText = await root.innerText({ timeout: 800 }).catch(() => "");
    if (OVERLAY_RISK.test(overlayText)) {
      warnOnce("    popup looks like a confirm/delete/payment dialog, leaving it alone");
      break;
    }
    if (overlayText === lastText) {
      if (++stuck >= 2) {
        warnOnce("    popup did not change after clicking, stopping");
        break;
      }
    } else {
      stuck = 0;
    }
    lastText = overlayText;

    if (shoot) await shoot(steps + 1).catch(() => { });

    const buttons = root.locator("button, [role=button], a");
    const n = Math.min(await buttons.count(), 40);
    const labels: string[] = [];
    for (let j = 0; j < n; j++) {
      const b = buttons.nth(j);
      const text =
        (await b.innerText({ timeout: 500 }).catch(() => "")) ||
        (await b.getAttribute("aria-label", { timeout: 500 }).catch(() => "")) ||
        (await b.getAttribute("title", { timeout: 500 }).catch(() => "")) ||
        "";
      labels.push(cleanLabel(text));
    }

    // 1) your own --popup-buttons labels, 2) known words (Skip, Got it, Done, Next, ...)
    let target = -1;
    for (const x of extraDismiss) {
      target = labels.findIndex((l) => l.toLowerCase() === x);
      if (target >= 0) break;
    }
    if (target < 0) {
      for (const re of DISMISS_ORDER) {
        target = labels.findIndex((l) => l && re.test(l));
        if (target >= 0) break;
      }
    }
    // 3) unknown popup: try Escape, then the last button if there are only a few (usually the primary one)
    if (target < 0) {
      await page.keyboard.press("Escape").catch(() => { });
      await page.waitForTimeout(500);
      if (!(await findOverlay(page).catch(() => false))) {
        steps++;
        continue;
      }
      const real = labels
        .map((l, i) => ({ l, i }))
        .filter((x) => x.l && !/^(back|previous|prev|cancel|no|no thanks)$/i.test(x.l));
      if (real.length === 0) {
        warnOnce("    popup is still open and has no buttons I can click");
        break;
      }
      // The main action (Launch, Finish, Continue...) is usually the last button
      target = real[real.length - 1].i;
      warnOnce(`    unknown popup buttons: clicking "${real[real.length - 1].l}" as the most likely main button (use --popup-buttons to choose another)`);
    }
    try {
      await buttons.nth(target).click({ timeout: 1500 });
    } catch {
      break;
    }
    steps++;
    await page.waitForTimeout(700);
  }
  return steps;
}

// ---------- login ----------
type LoginStep = { goto?: string; fill?: string; value?: string; click?: string; press?: string; waitFor?: string; wait?: number };
type LoginConfig = {
  url?: string; // login page, default /login
  email?: string; // may be "${SHOTSWEEP_EMAIL}" (read from an environment variable)
  password?: string; // may be "${SHOTSWEEP_PASSWORD}"
  steps?: LoginStep[]; // optional: your own steps instead of auto-detecting the form
  successUrlNotContains?: string; // e.g. "/login": login failed if the URL still contains this
};

/** Replaces ${NAME} with the environment variable NAME so passwords don't have to live in the config file. */
function expandEnv(v: string): string {
  return v.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    const val = process.env[k];
    if (val === undefined) {
      console.error(`Environment variable ${k} is not set (it is used in the login config).`);
      process.exit(1);
    }
    return val;
  });
}

async function runStep(page: Page, st: LoginStep) {
  if (st.goto) await page.goto(new URL(expandEnv(st.goto), page.url()).href, { waitUntil: "domcontentloaded" });
  else if (st.fill) await page.locator(st.fill).first().fill(expandEnv(st.value ?? ""), { timeout: 8000 });
  else if (st.click) await page.locator(st.click).first().click({ timeout: 8000 });
  else if (st.press) await page.keyboard.press(st.press);
  else if (st.waitFor) await page.locator(st.waitFor).first().waitFor({ timeout: 15000 });
  else if (st.wait) await page.waitForTimeout(st.wait);
}

/** Finds the email + password fields on its own and submits (also handles "email first, then password" forms). */
async function autoLogin(page: Page, email: string, password: string) {
  const userSel =
    ':is(input[type=email], input[name*="email" i], input[name*="user" i], input[autocomplete="username"], input[type=text]):visible';
  const user = page.locator(userSel).first();
  const pwd = page.locator("input[type=password]:visible").first();

  if (await pwd.isVisible().catch(() => false)) {
    if (await user.isVisible().catch(() => false)) await user.fill(email);
  } else {
    await user.fill(email, { timeout: 8000 });
    await user.press("Enter");
    await pwd.waitFor({ state: "visible", timeout: 6000 });
  }
  await pwd.fill(password);
  await pwd.press("Enter");
  await page.waitForTimeout(1500);
  if (await pwd.isVisible().catch(() => false)) {
    // Enter did not submit: click the login button that comes right after the password field
    const near = pwd.locator("xpath=following::button[position()<=4]");
    let clicked = false;
    for (let i = 0, n = await near.count(); i < n && !clicked; i++) {
      const b = near.nth(i);
      const t = ((await b.innerText({ timeout: 500 }).catch(() => "")) as string).trim();
      if (/log ?in|sign ?in|continue|submit|enter|next/i.test(t) && (await b.isVisible().catch(() => false))) {
        clicked = await b.click({ timeout: 4000 }).then(() => true).catch(() => false);
      }
    }
    if (!clicked) {
      await page
        .locator('button[type=submit], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")')
        .first()
        .click({ timeout: 4000 })
        .catch(() => { });
    }
  }
}

/** Logs in automatically with the config's login settings and saves the session to `file`. */
async function scriptedLogin(baseUrl: string, login: LoginConfig, file: string, delay: number) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  const loginUrl = new URL(login.url ?? "/login", baseUrl).href;
  console.log(`Logging in at ${loginUrl} ...`);
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await settle(page, delay);
    if (login.steps?.length) {
      for (const st of login.steps) await runStep(page, st);
    } else {
      await autoLogin(page, expandEnv(login.email ?? ""), expandEnv(login.password ?? ""));
    }
    await settle(page, delay);
    await page.waitForTimeout(800);

    const stillOnForm = await page.locator("input[type=password]:visible").first().isVisible().catch(() => false);
    const badUrl = login.successUrlNotContains ? page.url().includes(login.successUrlNotContains) : false;
    if (stillOnForm || badUrl) {
      const shot = path.join(path.dirname(file), "login-failed.png");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: shot });
      console.error(`Login seems to have failed (still on the login page). See ${shot}`);
      console.error("Check the email/password, or use --login to log in by hand once.");
      await browser.close();
      process.exit(1);
    }
    await saveStateToFile(context, file);
    console.log(`  logged in, session saved to ${file}`);
  } catch (e) {
    console.error(`Login failed: ${(e as Error).message.split("\n")[0]}`);
    console.error("Use --login to log in by hand once, or give your own steps in the config (login.steps).");
    await browser.close();
    process.exit(1);
  }
  await browser.close();
}

/** Opens a real browser window; you log in by hand (Google, 2FA, anything); the session is saved for later runs. */
async function manualLogin(url: string, file: string) {
  const browser = await launchBrowser(false);
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(url).catch(() => { });
  console.log("\nA browser window opened. Log in there, using any method.");
  console.log("When you can see your logged-in app, come back to this window and press Enter.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();
  try {
    await saveStateToFile(context, file);
    console.log(`Saved your login to ${file}\nFuture runs will use it automatically.`);
  } catch {
    console.error("Could not save the login (was the browser window closed?). Run --login again and press Enter before closing it.");
  }
  await browser.close();
}

// Buttons that DO something (cost credits, change data). Never clicked outside a navigation menu.
const RISKY_ACTION = /^(generate|create|export|download|upload|save|publish|send|run|apply|enhance|submit|share|upgrade|subscribe|invite|add|new|edit|rename|duplicate|copy|undo|redo|reset|try|start|play|buy|pay|delete|remove)\b/i;
const NAV_SEL =
  "nav a, nav button, nav li, [role=navigation] a, [role=navigation] button, [role=navigation] li, " +
  "aside a, aside button, aside li, header a, header button, [role=tab], [role=menuitem], " +
  "[class*=sidebar i] a, [class*=sidebar i] button, [class*=sidebar i] li, [class*=nav i] button, [class*=nav i] li, [class*=menu i] li";
const GENERIC_SEL = "a, button, [role=link], [role=tab], [role=menuitem], [onclick]";
const MAX_CLICKS_PER_PAGE = 25;

type DiscoverOpts = { maxPages: number; exclude: RegExp[]; delay: number; seeds: string[]; click: boolean; skipLabels: string[] };

/** Source 3 + 4: visit pages, collect links, then CLICK buttons/menus and watch the URL change */
async function discover(baseUrl: string, o: DiscoverOpts): Promise<Target[]> {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, storageState: authState });
  const page = await context.newPage();
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const seedSet = new Set(o.seeds);
  const tried = new Set<string>();
  const targets: Target[] = [];
  const seenSigs = new Map<string, string>();

  const add = (r: string | null) => {
    if (r && !queued.has(r) && !o.exclude.some((x) => x.test(r))) {
      queued.add(r);
      queue.push(r);
    }
  };
  add("/");
  o.seeds.forEach(add);

  while (queue.length && visited.size < o.maxPages) {
    const route = queue.shift()!;
    try {
      const res = await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded", timeout: 15000 });
      if (res && res.status() >= 400) {
        console.log(`  skip ${route} (HTTP ${res.status()})`);
        continue;
      }
      await settle(page, o.delay);
      const closed = await dismissOverlays(page);
      if (closed) {
        console.log(`    (closed ${closed} popup step${closed > 1 ? "s" : ""} on ${route})`);
        await saveSession(context);
      }

      // Followed a redirect (e.g. /dashboard -> /login)?
      const current = toRoute(page.url(), baseUrl);
      if (!current) continue;
      if (current !== route) {
        console.log(`  ${route} redirected to ${current}`);
        if (visited.has(current)) continue;
        queued.add(current);
      }

      // Skip fake routes (SPA dev servers return 200 for everything)
      const text = ((await page.evaluate(() => document.body?.innerText ?? "")) as string).trim();
      if (current !== "/" && text.length < 500 && /\b404\b|page not found|not found/i.test(text)) {
        console.log(`  skip ${current} (looks like a 404 page)`);
        continue;
      }
      if (current !== "/" && seedSet.has(route) && text.length === 0) {
        console.log(`  skip ${current} (empty page)`);
        continue;
      }

      // Skip routes that render exactly the same content as an already-found page
      const sig = norm(text);
      const dupOf = findSeen(seenSigs, sig);
      if (current !== "/" && sig && dupOf) {
        console.log(`  skip ${current} (same content as ${dupOf})`);
        continue;
      }
      if (sig) seenSigs.set(sig, current);

      visited.add(current);
      targets.push({ route: current });
      console.log(`  found ${current}`);
      let viewCount = 0;

      // Real <a href> links (wait a moment for JS-rendered menus)
      await page.waitForSelector("a[href]", { timeout: 2000 }).catch(() => { });
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
      hrefs.forEach((h) => add(toRoute(h, baseUrl)));

      // Click buttons / menu items that navigate without real links
      if (o.click) {
        // Prefer navigation areas (menu, sidebar, tabs); only fall back to every button if the page has none
        const sel = (await page.locator(NAV_SEL).count()) > 0 ? NAV_SEL : GENERIC_SEL;
        const count = Math.min(await page.locator(sel).count(), 60);
        const startUrl = page.url();
        let clicks = 0;
        for (let i = 0; i < count; i++) {
          if (clicks >= MAX_CLICKS_PER_PAGE) break;
          const el = page.locator(sel).nth(i);
          try {
            if (!(await el.isVisible())) continue;
            const info = await el.evaluate((e) => ({
              tag: e.tagName,
              inNav: !!e.closest("nav, [role=navigation], [role=tablist], [class*=sidebar i]"),
              href: (e as HTMLAnchorElement).getAttribute?.("href") ?? "",
              label: ((e as HTMLElement).innerText || e.getAttribute("aria-label") || e.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40),
            }));
            const key = info.label.toLowerCase();
            if (!key || tried.has(key) || SKIP_LABELS.test(key) || o.skipLabels.includes(key)) continue;
            if (info.tag === "A" && /^(https?:|\/)/.test(info.href)) continue; // already collected
            if (!info.inNav && RISKY_ACTION.test(cleanLabel(key))) continue; // looks like an action button, not navigation
            tried.add(key);
            clicks++;
            await el.click({ timeout: 1500 });
            await page.waitForTimeout(600);
            const r = toRoute(page.url(), baseUrl);
            if (r && r !== current && !queued.has(r)) console.log(`  found ${r} (clicked "${info.label}")`);
            if (r && r !== current) {
              add(r);
            } else if (viewCount < 12) {
              // URL did not change: did the visible content change? Then it is a "view" (tab, panel, screen)
              const after = norm(((await page.evaluate(() => document.body?.innerText ?? "")) as string));
              const dup = findSeen(seenSigs, after);
              if (after && !similar(after, sig) && !dup) {
                seenSigs.set(after, `${current} > "${info.label}"`);
                targets.push({ route: current, click: info.label });
                viewCount++;
                console.log(`  found view "${info.label}" on ${current} (content changed, URL did not)`);
              }
            }
          } catch {
            /* element not clickable, ignore */
          }
          // reset the page so the next element index is stable
          if (startUrl.includes("#")) await page.goto("about:blank").catch(() => { }); // force a real reload
          await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
          await settle(page, 300);
          await dismissOverlays(page);
        }
      }
    } catch (e) {
      console.log(`  failed ${route}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  await browser.close();
  return targets;
}

/** Click an element; on small screens open the hamburger menu first, and as a last resort click via JS. */
async function smartClick(page: Page, el: Locator): Promise<boolean> {
  if (await el.isVisible().catch(() => false)) {
    try {
      await el.click({ timeout: 1500 });
      return true;
    } catch {
      /* covered or off-screen: try the menu button next */
    }
  }
  const toggle = page
    .locator('button[aria-label*="menu" i], button[aria-label*="nav" i], [class*="hamburger" i], [class*="burger" i], [class*="menu-toggle" i], header button')
    .first();
  if (await toggle.isVisible().catch(() => false)) {
    try {
      await toggle.click({ timeout: 1500 });
      await page.waitForTimeout(400);
      if (await el.isVisible()) {
        await el.click({ timeout: 1500 });
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  if (await el.isVisible().catch(() => false)) {
    try {
      await el.evaluate((e) => (e as HTMLElement).click());
      return true;
    } catch {
      /* give up */
    }
  }
  return false;
}

async function capture(baseUrl: string, targets: Target[], viewports: string[], outDir: string, delay: number, capturePopups: boolean): Promise<Shot[]> {
  const browser = await launchBrowser();
  const shots: Shot[] = [];

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: VIEWPORTS[vp],
      storageState: (reuseSession && !capturePopups ? sessionState : undefined) ?? authState,
    });
    const authedPage = await context.newPage();
    // Logged-out screens use a clean browser with no saved login
    let pubCtx: BrowserContext | undefined;
    let pubPage: Page | undefined;
    const getPublic = async () => {
      if (!pubPage) {
        pubCtx = await browser.newContext({ viewport: VIEWPORTS[vp] });
        pubPage = await pubCtx.newPage();
      }
      return pubPage;
    };
    for (const [i, t] of targets.entries()) {
      const url = new URL(t.route, baseUrl).href;
      const label = (t.click ? `${t.route} > click "${t.click}"` : t.route) + (t.loggedOut ? " (logged out)" : "");
      const file = `${String(i + 1).padStart(2, "0")}-${slugify(t.route)}${t.click ? "-" + slugify(t.click) : ""}${t.loggedOut ? "-loggedout" : ""}-${vp}.png`;
      try {
        const page = t.loggedOut ? await getPublic() : authedPage;
        const ctx = t.loggedOut ? pubCtx! : context;
        if (url.includes("#")) await page.goto("about:blank").catch(() => { });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await settle(page, delay);
        const closed = await dismissOverlays(
          page,
          capturePopups
            ? async (n) => {
              const pf = file.replace(/\.png$/, `-popup${n}.png`);
              await page.screenshot({ path: path.join(outDir, pf) });
              shots.push({ route: `${label} (popup step ${n})`, url, viewport: vp, file: pf, title: await page.title() });
              console.log(`  ✓ ${pf}`);
            }
            : undefined,
        );
        if (closed) {
          console.log(`    (closed ${closed} popup step${closed > 1 ? "s" : ""})`);
          if (!t.loggedOut) await saveSession(ctx);
        }
        if (t.click) {
          const el = page
            .locator("a, button, [role=link], [role=tab], [role=menuitem], [onclick], li")
            .filter({ hasText: t.click })
            .first();
          if (!(await smartClick(page, el))) {
            console.log(`  - skipped "${t.click}" [${vp}] (not reachable at this screen size)`);
            continue;
          }
          await settle(page, delay);
        }
        await page.screenshot({ path: path.join(outDir, file), fullPage: true });
        shots.push({ route: label, url, viewport: vp, file, title: await page.title() });
        console.log(`  ✓ ${file}`);
      } catch (e) {
        console.log(`  ✗ ${label} [${vp}]: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    await pubCtx?.close();
    await context.close();
  }
  await browser.close();
  return shots;
}

type ImgOpts = { maxWidth: number; sliceHeight: number; format: "jpeg" | "webp" | "png"; quality: number; keepOriginals: boolean };

/**
 * Makes screenshots cheaper and more readable for AI tools:
 *  - shrinks wide images (default max 1280px),
 *  - converts PNG to JPEG/WebP,
 *  - splits very tall pages into equal parts (AI tools squash tall images until text is unreadable).
 */
async function optimizeImages(outDir: string, shots: Shot[], o: ImgOpts): Promise<Shot[]> {
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.log("\nSkipping image optimization: the 'sharp' package is not installed. Run: npm install");
    return shots;
  }
  const ext = o.format === "jpeg" ? "jpg" : o.format;
  const origDir = outDir + "-originals";
  if (o.keepOriginals) fs.mkdirSync(origDir, { recursive: true });

  const result: Shot[] = [];
  let before = 0;
  let after = 0;
  let tokens = 0;

  for (const shot of shots) {
    const src = path.join(outDir, shot.file);
    try {
      before += fs.statSync(src).size;
      if (o.keepOriginals) fs.copyFileSync(src, path.join(origDir, shot.file));
      const meta = await sharp(src).metadata();
      const w = Math.min(meta.width as number, o.maxWidth);
      const buf: Buffer = await sharp(src).resize({ width: w }).toBuffer();
      const h = (await sharp(buf).metadata()).height as number;
      const parts = o.sliceHeight > 0 ? Math.max(1, Math.ceil(h / o.sliceHeight)) : 1;
      const partH = Math.ceil(h / parts);
      const base = shot.file.replace(/\.png$/i, "");

      for (let p = 0; p < parts; p++) {
        const top = p * partH;
        const height = Math.min(partH, h - top);
        let img = sharp(buf).extract({ left: 0, top, width: w, height });
        img = o.format === "png" ? img.png({ compressionLevel: 9 }) : o.format === "webp" ? img.webp({ quality: o.quality }) : img.jpeg({ quality: o.quality, mozjpeg: true });
        const file = parts === 1 ? `${base}.${ext}` : `${base}-part${p + 1}.${ext}`;
        await img.toFile(path.join(outDir, file));
        after += fs.statSync(path.join(outDir, file)).size;
        tokens += Math.round((w * height) / 750); // rough image-token estimate
        result.push({ ...shot, file, route: parts === 1 ? shot.route : `${shot.route} (part ${p + 1}/${parts})` });
      }
      if (!(o.format === "png" && parts === 1)) fs.unlinkSync(src);
    } catch (e) {
      console.log(`  could not optimize ${shot.file}: ${(e as Error).message.split("\n")[0]} (kept original)`);
      result.push(shot);
    }
  }
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  console.log(`\nOptimized ${shots.length} screenshots into ${result.length} images: ${mb(before)} MB → ${mb(after)} MB (${pct}% smaller)`);
  console.log(`  ≈ ${tokens.toLocaleString()} image tokens in total when uploaded to an AI`);
  if (result.length > shots.length) console.log(`  tall pages were split into parts so text stays readable`);
  return result;
}

function writeManifest(outDir: string, baseUrl: string, shots: Shot[]) {
  const rows = shots
    .map((s) => `| ${s.file} | \`${s.route}\` | ${s.viewport} | ${s.title || "-"} |`)
    .join("\n");
  const md = `# UI Export

Base URL: ${baseUrl}
Captured: ${new Date().toISOString()}
Screens: ${shots.length}

| File | Route | Viewport | Page title |
|---|---|---|---|
${rows}

## Suggested review prompt

I built this web app with an AI coding tool. The attached screenshots show every captured screen (see the table above for routes and viewports). Please review them for:
1. Layout and spacing problems
2. Visual consistency (colors, fonts, buttons)
3. Mobile responsiveness issues
4. Accessibility concerns (contrast, text size, labels)
5. Anything that looks broken or unfinished
Give a prioritized list of fixes.${shots.some((s) => /\(part \d+\/\d+\)/.test(s.route)) ? "\n\nNote: tall pages are split into numbered parts, from the top of the page down." : ""}
`;
  fs.writeFileSync(path.join(outDir, "manifest.md"), md);
}

async function zipDir(dir: string, zipPath: string): Promise<void> {
  const zip = new JSZip();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) zip.file(name, fs.readFileSync(p));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  fs.writeFileSync(zipPath, buf);
}

type Config = {
  url?: string;
  project?: string;
  out?: string;
  viewports?: string[] | string;
  maxPages?: number;
  routes?: string[] | string;
  exclude?: string[] | string;
  skipLabels?: string[] | string;
  popupButtons?: string[] | string;
  capturePopups?: boolean;
  click?: boolean;
  delay?: number;
  zip?: boolean;
  reuseSession?: boolean;
  login?: LoginConfig;
  authFile?: string;
  loggedOutRoutes?: string[] | string;
  optimize?: boolean;
  maxWidth?: number;
  sliceHeight?: number;
  imageFormat?: string;
  quality?: number;
  keepOriginals?: boolean;
};

const CONFIG_TEMPLATE: Config = {
  url: "http://localhost:3000",
  project: "C:\\Projects\\my-site",
  viewports: ["desktop", "mobile"],
  popupButtons: [],
  skipLabels: [],
  exclude: [],
  capturePopups: false,
  reuseSession: true,
};

function loadConfig(file?: string): Config {
  const p = path.resolve(file ?? "shotsweep.config.json");
  if (!fs.existsSync(p)) {
    if (file) {
      console.error(`Config file not found: ${p}`);
      process.exit(1);
    }
    return {};
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Config;
    console.log(`Using config: ${p}`);
    return cfg;
  } catch (e) {
    console.error(`Could not read ${p}: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** Accepts "a,b" (CLI) or ["a","b"] (config) */
const toList = (v: unknown): string[] | undefined =>
  v === undefined || v === null
    ? undefined
    : Array.isArray(v)
      ? v.map(String)
      : String(v).split(",").map((x) => x.trim()).filter(Boolean);

const program = new Command();
program
  .name("shotsweep")
  .description("Capture every screen of your web app and export it for AI review")
  .version(pkgVersion, "-V, --version")
  .argument("[url]", "app URL (default: from config, or http://localhost:3000)")
  .option("-c, --config <file>", "config file (default: ./shotsweep.config.json if it exists)")
  .option("--init", "create a shotsweep.config.json template in the current folder and exit")
  .option("-o, --out <dir>", "output folder", "shotsweep-export")
  .option("-v, --viewports <list>", "comma list: desktop,tablet,mobile", "desktop,mobile")
  .option("-m, --max-pages <n>", "max pages to crawl", "30")
  .option("-r, --routes <list>", "skip discovery; use these routes, e.g. /,/login,/pricing")
  .option("-p, --project <dir>", "path to your site's source folder (finds routes from code)")
  .option("-s, --skip-labels <list>", "button/menu labels to never click (exact match), e.g. \"V,Need help? Chat with us\"")
  .option("--popup-buttons <list>", "extra popup button labels to click (exact), e.g. \"Let's go,Start creating\"")
  .option("--capture-popups", "also save a screenshot of each popup/onboarding before closing it")
  .option("--login", "open a browser so you can log in by hand once; the login is saved for later runs")
  .option("--auth <file>", "where the saved login is stored", ".shotsweep/auth.json")
  .option("--logged-out <list>", "also capture these routes WITHOUT the saved login, e.g. \"/#login,/pricing\"")
  .option("--no-optimize", "keep full-size PNG screenshots (skip compression and splitting)")
  .option("--max-width <px>", "shrink images wider than this", "1280")
  .option("--slice-height <px>", "split pages taller than this into parts (0 = never split)", "1400")
  .option("--format <fmt>", "image format: jpeg, webp or png", "jpeg")
  .option("--quality <n>", "JPEG/WebP quality 1-100", "80")
  .option("--keep-originals", "keep the original PNGs in a separate <out>-originals folder")
  .option("--no-session", "don't reuse browser storage between pages (popups may reappear)")
  .option("--no-click", "don't click buttons/menus to discover routes")
  .option("-x, --exclude <list>", "comma list of route patterns to skip, e.g. /admin/*,/api/*")
  .option("-d, --delay <ms>", "extra wait after load (for animations)", "500")
  .option("--no-zip", "do not create a ZIP")
  .action(async (urlArg: string | undefined, opts) => {
    if (opts.init) {
      const target = path.resolve("shotsweep.config.json");
      if (fs.existsSync(target)) {
        console.log(`Already exists: ${target}`);
      } else {
        fs.writeFileSync(target, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n");
        console.log(`Created ${target}\nEdit it, then run: npx tsx src/cli.ts`);
      }
      return;
    }

    // Settings priority: command-line flag > config file > built-in default
    const cfg = loadConfig(opts.config);
    const fromCli = (n: string) => program.getOptionValueSource(n) === "cli";
    const pick = (n: string, cfgVal: unknown) => (fromCli(n) || cfgVal === undefined ? opts[n] : cfgVal);

    const url: string = urlArg ?? cfg.url ?? "http://localhost:3000";
    await checkReachable(url);
    const authFile = path.resolve(String(pick("auth", cfg.authFile)));
    if (opts.login) {
      await manualLogin(url, authFile);
      return;
    }
    const viewports = toList(pick("viewports", cfg.viewports)) ?? ["desktop", "mobile"];
    const bad = viewports.filter((v) => !VIEWPORTS[v]);
    if (bad.length) {
      console.error(`Unknown viewport(s): ${bad.join(", ")}. Use: ${Object.keys(VIEWPORTS).join(", ")}`);
      process.exit(1);
    }
    extraDismiss = (toList(pick("popupButtons", cfg.popupButtons)) ?? []).map((x) => cleanLabel(x).toLowerCase());
    const skipLabels = (toList(pick("skipLabels", cfg.skipLabels)) ?? []).map((x) => x.toLowerCase());
    const exclude = (toList(pick("exclude", cfg.exclude)) ?? []).map(globToRegex);
    const routesList = toList(pick("routes", cfg.routes));
    const project = pick("project", cfg.project) as string | undefined;
    const maxPages = Number(pick("maxPages", cfg.maxPages));
    const delay = Number(pick("delay", cfg.delay));
    const outDir = path.resolve(String(pick("out", cfg.out)));
    const click = Boolean(pick("click", cfg.click));
    const zip = Boolean(pick("zip", cfg.zip));
    const capturePopups = Boolean(pick("capturePopups", cfg.capturePopups));
    reuseSession = Boolean(pick("session", cfg.reuseSession));
    if (capturePopups && reuseSession) {
      console.log("Note: popup screenshots are on, so each screen starts from a fresh browser session to show its popups.");
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    if (cfg.login) {
      await scriptedLogin(url, cfg.login, authFile, delay);
      authState = authFile;
    } else if (fs.existsSync(authFile)) {
      console.log(`Using saved login: ${authFile}`);
      authState = authFile;
    }

    let targets: Target[];
    if (routesList?.length) {
      targets = routesList.map((r) => ({ route: r }));
    } else {
      console.log(`Discovering routes on ${url} ...`);
      const fromSitemap = await routesFromSitemap(url);
      const fromProject = project ? routesFromProject(project) : [];
      console.log(`  sitemap: ${fromSitemap.length} route(s), project code: ${fromProject.length} route(s)`);
      const seeds = [...new Set([...fromProject, ...fromSitemap])];
      targets = await discover(url, { maxPages, exclude, delay, seeds, click, skipLabels });
    }
    if (!targets.length) {
      console.error("No pages found. Is your dev server running?");
      process.exit(1);
    }
    // Screens that only exist when logged out (login page, public pricing...). Only needed when a saved login is in use.
    if (authState) {
      const lo = [...(toList(pick("loggedOut", cfg.loggedOutRoutes)) ?? [])];
      if (cfg.login?.url && !lo.includes(cfg.login.url)) lo.push(cfg.login.url);
      for (const r of lo) targets.push({ route: r, loggedOut: true });
    }

    console.log(`\nCapturing ${targets.length} screens × ${viewports.length} viewports ...`);
    let shots = await capture(url, targets, viewports, outDir, delay, capturePopups);
    if (Boolean(pick("optimize", cfg.optimize))) {
      const fmt = String(pick("format", cfg.imageFormat)).toLowerCase();
      shots = await optimizeImages(outDir, shots, {
        maxWidth: Number(pick("maxWidth", cfg.maxWidth)),
        sliceHeight: Number(pick("sliceHeight", cfg.sliceHeight)),
        format: fmt === "webp" || fmt === "png" ? fmt : "jpeg",
        quality: Math.min(100, Math.max(1, Number(pick("quality", cfg.quality)))),
        keepOriginals: Boolean(pick("keepOriginals", cfg.keepOriginals)),
      });
    }
    writeManifest(outDir, url, shots);

    if (zip) {
      const zipPath = outDir + ".zip";
      await zipDir(outDir, zipPath);
      console.log(`\nDone. ${shots.length} screenshots → ${zipPath}`);
    } else {
      console.log(`\nDone. ${shots.length} screenshots → ${outDir}`);
    }
  });

program.parseAsync();