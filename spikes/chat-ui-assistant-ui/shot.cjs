// Serves dist/ with Hearth's WEB_CSP (decision 0017), opens it in headless
// Chromium, fails on any CSP violation, and saves a screenshot.
// CSP violations are collected two ways: console messages, and a
// `securitypolicyviolation` listener installed before any page script runs.
// The listener matters: a blocked eval/new Function that the page catches
// raises a report but no console error, so console-only checks miss it.
// Usage: node shot.cjs <out.png> [width] [height]
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const root = path.join(__dirname, "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  const p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Content-Security-Policy": CSP,
  });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const page = await browser.newPage({
    viewport: { width: Number(process.argv[3] || 900), height: Number(process.argv[4] || 900) },
  });
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__cspReports = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspReports.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  await page.goto(url);
  try {
    await page.getByText("2 of 3 tests pass").waitFor({ timeout: 10000 });
  } catch (e) {
    console.log(JSON.stringify({ problems, body: await page.locator("body").innerText() }, null, 2));
    await page.screenshot({ path: "debug.png" });
    throw e;
  }
  // Open the grouped tool row and the failing card so the screenshot shows both.
  await page.getByRole("button", { name: /Ran 2 tools/ }).click();
  await page.locator("[data-testid=tool-card] summary").last().click();
  await page.screenshot({ path: process.argv[2] || "shot.png", fullPage: true });
  const cards = await page.locator("[data-testid=tool-card]").count();
  // Reports are dispatched asynchronously; give pending ones a tick to land.
  await page.waitForTimeout(250);
  const cspReports = await page.evaluate(() => window.__cspReports);
  for (const r of cspReports) problems.push(`csp-report: ${r}`);
  console.log(JSON.stringify({ cards, cspReports: cspReports.length, problems }, null, 2));
  await browser.close();
  server.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
