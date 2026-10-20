import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "data/fragment-dictionary-scan";
const RESULTS = path.join(ROOT, "results");
const OUTPUT = path.join(ROOT, "plural-results");
const ALL_FILE = path.join(OUTPUT, "all-results.csv");
const UNKNOWN_FILE = path.join(OUTPUT, "unknown-words.csv");
const API_URL = "https://tg-username-api.vercel.app/api/v1/check/bulk";
const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.BATCH_SIZE || 1000)));
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
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || "");
  return lines.filter(Boolean).map(line => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}
function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}
function encodeCsv(headers, rows) {
  return [headers, ...rows.map(row => headers.map(h => row[h] ?? ""))]
    .map(row => row.map(csvCell).join(",")).join("\n") + "\n";
}
async function readCsv(file) {
  try { return parseCsv(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function checkBatch(batch, label) {
  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usernames: batch.map(x => x.plural_username) })
    });
    if (response.ok) break;
    const retryAfter = Number(response.headers.get("retry-after") || 60);
    if (attempt === 4) throw new Error(`${label} failed: HTTP ${response.status}`);
    await sleep(response.status === 429 ? Math.max(1000, retryAfter * 1000) : 4000);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.results) || payload.results.length !== batch.length) {
    throw new Error(`${label}: unexpected API response; refusing to save partial data.`);
  }
  return payload.results;
}

await fs.mkdir(OUTPUT, { recursive: true });
const sourceFiles = (await fs.readdir(RESULTS))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.csv$/.test(name)).sort();
if (!sourceFiles.length) throw new Error("No dictionary scan CSVs found.");

const sourceByName = new Map();
for (const name of sourceFiles) {
  const rows = await readCsv(path.join(RESULTS, name));
  for (const row of rows) {
    const username = String(row.username || "").toLowerCase();
    if (/^[a-z]{5,11}$/.test(username) && !username.endsWith("s")) {
      sourceByName.set(username, {
        source_username: username,
        source_status: row.status || "",
        source_fragment_status: row.fragment_status || ""
      });
    }
  }
}
const sourceRows = [...sourceByName.values()].sort((a, b) => a.source_username.localeCompare(b.source_username));
const headers = [
  "source_username", "source_status", "source_fragment_status", "plural_username",
  "initial_status", "retry_status", "status", "fragment_status", "price", "currency",
  "fragment_url", "checked_at", "error"
];
const previous = await readCsv(ALL_FILE);
const seen = new Set(previous.map(row => row.source_username).filter(Boolean));
const pending = sourceRows.filter(row => !seen.has(row.source_username)).slice(0, BATCH_SIZE);
if (!pending.length) {
  const unknown = previous.filter(row => row.status === "unknown");
  await fs.writeFile(UNKNOWN_FILE, encodeCsv(headers, unknown));
  console.log(JSON.stringify({
    message: "No unprocessed source words are currently available.",
    sourceWordsFound: sourceRows.length,
    alreadyProcessed: seen.size,
    unknownTotal: unknown.length,
    allResultsFile: ALL_FILE,
    unknownWordsFile: UNKNOWN_FILE
  }, null, 2));
  process.exit(0);
}

const candidates = pending.map(row => ({ ...row, plural_username: row.source_username + "s" }));
const firstResults = [];
for (let i = 0; i < candidates.length; i += 15) {
  const batch = candidates.slice(i, i + 15);
  const results = await checkBatch(batch, `Initial batch ${Math.floor(i / 15) + 1}`);
  results.forEach((item, j) => firstResults.push({
    original: batch[j],
    firstItem: item,
    firstStatus: item.result?.status || item.status || "unknown",
    retryItem: null,
    retryStatus: ""
  }));
  await sleep(2600);
}

const unknowns = firstResults.filter(x => x.firstStatus === "unknown");
for (let i = 0; i < unknowns.length; i += 15) {
  const batch = unknowns.slice(i, i + 15);
  const results = await checkBatch(batch.map(x => x.original), `Unknown retry batch ${Math.floor(i / 15) + 1}`);
  results.forEach((item, j) => {
    batch[j].retryItem = item;
    batch[j].retryStatus = item.result?.status || item.status || "unknown";
  });
  await sleep(2600);
}

const newRows = firstResults.map(x => {
  const item = x.retryItem && x.retryStatus !== "unknown" ? x.retryItem : x.firstItem;
  const finalStatus = x.retryItem && x.retryStatus !== "unknown" ? x.retryStatus : x.firstStatus;
  return {
    source_username: x.original.source_username,
    source_status: x.original.source_status,
    source_fragment_status: x.original.source_fragment_status,
    plural_username: item.username || x.original.plural_username,
    initial_status: x.firstStatus,
    retry_status: x.retryStatus,
    status: finalStatus,
    fragment_status: item.fragment?.status || "",
    price: item.fragment?.price?.amount ?? "",
    currency: item.fragment?.price?.currency ?? "",
    fragment_url: item.fragment?.url || `https://fragment.com/username/${x.original.plural_username}`,
    checked_at: item.checked_at || new Date().toISOString(),
    error: item.fragment?.error?.code || item.telegram?.error?.code || ""
  };
});
const allBySource = new Map(previous.map(row => [row.source_username, row]));
for (const row of newRows) allBySource.set(row.source_username, row);
const allRows = [...allBySource.values()].sort((a, b) => a.source_username.localeCompare(b.source_username));
const unknownRows = allRows.filter(row => row.status === "unknown");
await fs.writeFile(ALL_FILE, encodeCsv(headers, allRows));
await fs.writeFile(UNKNOWN_FILE, encodeCsv(headers, unknownRows));

const counts = Object.fromEntries(["available", "taken", "fragment_collectible", "unknown", "invalid"].map(status => [
  status, newRows.filter(row => row.status === status).length
]));
console.log(JSON.stringify({
  sourceWordsFound: sourceRows.length,
  processedBeforeRun: seen.size,
  batchSizeRequested: BATCH_SIZE,
  checkedThisRun: newRows.length,
  retriedUnknownThisRun: unknowns.length,
  thisRunCounts: counts,
  cumulativeChecked: allRows.length,
  cumulativeUnknown: unknownRows.length,
  allResultsFile: ALL_FILE,
  unknownWordsFile: UNKNOWN_FILE
}, null, 2));
