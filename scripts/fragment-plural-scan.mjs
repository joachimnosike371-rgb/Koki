import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "data/fragment-dictionary-scan";
const RESULTS = path.join(ROOT, "results");
const OUTPUT = path.join(ROOT, "plural-results");
const API_URL = "https://tg-username-api.vercel.app/api/v1/check/bulk";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseCsvLine(line) {
  const out = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { out.push(value); value = ""; }
    else value += c;
  }
  out.push(value);
  return out;
}
function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}
async function checkBatch(batch, label) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usernames: batch.map(x => x.plural) })
    });
    if (response.ok) break;
    const retryAfter = Number(response.headers.get("retry-after") || 60);
    if (attempt === 3) throw new Error(`${label} failed: HTTP ${response.status}`);
    await sleep(response.status === 429 ? Math.max(1000, retryAfter * 1000) : 3000);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.results) || payload.results.length !== batch.length) {
    throw new Error(`${label}: unexpected API response; refusing to save partial data.`);
  }
  return payload.results;
}

await fs.mkdir(OUTPUT, { recursive: true });
const files = (await fs.readdir(RESULTS))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.csv$/.test(name)).sort().reverse();
if (!files.length) throw new Error("No existing dictionary scan CSV found.");
const sourceFile = path.join(RESULTS, files[0]);
const lines = (await fs.readFile(sourceFile, "utf8")).trim().split(/\r?\n/);
const headers = parseCsvLine(lines.shift());
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
const rows = lines.map(line => {
  const cells = parseCsvLine(line);
  return {
    username: (cells[idx.username] || "").toLowerCase(),
    status: cells[idx.status] || "",
    fragment_status: cells[idx.fragment_status] || ""
  };
}).filter(r => /^[a-z]{5,11}$/.test(r.username) && !r.username.endsWith("s"));
const unique = [...new Map(rows.map(r => [r.username, r])).values()];
if (unique.length < 100) throw new Error(`Only ${unique.length} candidates found; need 100.`);
const candidates = [];
for (let i = 0; i < 100; i++) {
  const row = unique[Math.floor(i * (unique.length - 1) / 99)];
  candidates.push({ ...row, plural: row.username + "s" });
}

const firstResults = [];
for (let i = 0; i < candidates.length; i += 15) {
  const batch = candidates.slice(i, i + 15);
  const results = await checkBatch(batch, `Initial check batch ${i / 15 + 1}`);
  results.forEach((item, j) => firstResults.push({
    original: batch[j], firstItem: item, firstStatus: item.result?.status || "unknown",
    retryItem: null, retryStatus: ""
  }));
  await sleep(2600);
}

// Recheck every inconclusive name once; retain both verdicts for auditability.
const unknowns = firstResults.filter(x => x.firstStatus === "unknown");
await sleep(4000);
for (let i = 0; i < unknowns.length; i += 15) {
  const batch = unknowns.slice(i, i + 15);
  const results = await checkBatch(batch.map(x => x.original), `Unknown retry batch ${i / 15 + 1}`);
  results.forEach((item, j) => {
    batch[j].retryItem = item;
    batch[j].retryStatus = item.result?.status || "unknown";
  });
  await sleep(2600);
}

const date = new Date().toISOString().slice(0, 10);
const outputFile = path.join(OUTPUT, `${date}.csv`);
const outputHeaders = [
  "source_username", "source_status", "source_fragment_status", "plural_username",
  "initial_status", "retry_status", "status", "fragment_status", "price", "currency",
  "fragment_url", "checked_at", "error"
];
const outputRows = firstResults.map(x => {
  const item = x.retryItem && x.retryStatus !== "unknown" ? x.retryItem : x.firstItem;
  const finalStatus = x.retryItem && x.retryStatus !== "unknown" ? x.retryStatus : x.firstStatus;
  return [
    x.original.username, x.original.status, x.original.fragment_status,
    item.username || x.original.plural, x.firstStatus, x.retryStatus, finalStatus,
    item.fragment?.status || "", item.fragment?.price?.amount ?? "",
    item.fragment?.price?.currency ?? "",
    item.fragment?.url || `https://fragment.com/username/${x.original.plural}`,
    item.checked_at || new Date().toISOString(),
    item.fragment?.error?.code || item.telegram?.error?.code || ""
  ];
});
await fs.writeFile(outputFile, [outputHeaders, ...outputRows].map(row => row.map(csvCell).join(",")).join("\n") + "\n");
const counts = Object.fromEntries(["available", "taken", "fragment_collectible", "unknown", "invalid"].map(s => [s, outputRows.filter(r => r[6] === s).length]));
console.log(JSON.stringify({
  sourceFile, checked: outputRows.length, retried: unknowns.length, counts, outputFile
}, null, 2));
