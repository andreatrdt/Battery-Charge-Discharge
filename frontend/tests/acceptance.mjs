// Static frontend acceptance checks (redesign brief, Phase 21).
// Run with: node tests/acceptance.mjs
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(appDir);
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// 1. Learning mode is fully removed.
ok(!existsSync(join(appDir, "components", "learn.tsx")), "learn.tsx must be deleted");
ok(!existsSync(join(appDir, "components", "MarketTimeline.tsx")), "MarketTimeline.tsx must be deleted");
ok(!existsSync(join(appDir, "methodology")), "methodology route must be deleted");

for (const [f, s] of Object.entries(src)) {
  ok(!/\bsetLearning\b|\blearning\b\s*[:,)]/.test(s) || f.endsWith("acceptance.mjs"), `no learning state in ${f}`);
  ok(!/from ["'].*\/learn["']/.test(s), `no import from ./learn in ${f}`);
  ok(!/<(Learn|InfoTip|MarketTimeline)\b/.test(s), `no Learn/InfoTip/MarketTimeline JSX in ${f}`);
  ok(!/\/methodology/.test(s), `no /methodology link in ${f}`);
  ok(!s.includes("📘"), `no learning emoji in ${f}`);
}

// 2. Primary navigation has exactly four items + a Tools menu.
const nav = src[join(appDir, "components", "NavBar.tsx")];
ok(nav, "NavBar exists");
for (const [href, label] of [["/", "Market"], ["/replay", "Trading"], ["/validation", "Validation"], ["/data", "Audit"]]) {
  ok(nav.includes(`["${href}", "${label}"]`), `primary nav has ${label} → ${href}`);
}
const primaryBlock = nav.match(/const PRIMARY[\s\S]*?\n\];/)[0];
const primaryCount = (primaryBlock.match(/\["\//g) || []).length;
ok(primaryCount === 4, `exactly 4 primary nav items (found ${primaryCount})`);
ok(nav.includes("Tools ▾"), "Tools menu present");
for (const t of ["Battery Configuration", "Terminal", "Schedule", "Scenario Lab", "Backtest", "Reserve & BM Lab"]) {
  ok(nav.includes(t), `Tools menu has ${t}`);
}

// 3. Market KPIs, labels and units.
const market = src[join(appDir, "page.tsx")];
for (const label of ["GB System", "Net Imbalance Volume", "System Frequency", "System Price", "Commercial Position", "Commercial Imbalance"]) {
  ok(market.includes(`"${label}"`), `Market KPI label "${label}"`);
}
for (const unit of ['unit="MWh"', 'unit="Hz"', 'unit="£/MWh"']) {
  ok(market.includes(unit), `Market shows unit ${unit}`);
}
ok(market.includes("Commercial position unavailable"), "Market shows explicit unavailable state");

// 4. No footer disclaimer / marketing copy in the layout.
const layout = src[join(appDir, "layout.tsx")];
ok(!/Disclaimer|disclaimer/.test(layout), "layout has no disclaimer footer");

console.log(`OK — ${checks} frontend acceptance checks passed across ${files.length} files.`);
