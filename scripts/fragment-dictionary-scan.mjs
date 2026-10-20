import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "data/fragment-dictionary-scan";
const WORDLIST_URL = "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt";
const COMMON_WORDS_URL = "https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt";
const API_URL = "https://tg-username-api.vercel.app/api/v1/check/bulk";
const requestedLimit = Number(process.env.SCAN_LIMIT || 100);
const LIMIT = Number.isFinite(requestedLimit) ? Math.min(4500, Math.max(15, Math.floor(requestedLimit))) : 4500;
const STATE_PATH = path.join(ROOT, "state.json");
const STRATEGY = "uncommon-pronounceable-v1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await fs.mkdir(path.join(ROOT, "results"), { recursive: true });
let state = { offset: 0, totalWords: 0, updatedAt: null, strategy: STRATEGY };
try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_PATH, "utf8")) }; } catch {}
if (state.strategy !== STRATEGY) state = { offset: 0, totalWords: 0, updatedAt: null, strategy: STRATEGY };

const [listResponse, commonResponse] = await Promise.all([fetch(WORDLIST_URL), fetch(COMMON_WORDS_URL)]);
if (!listResponse.ok) throw new Error(`Dictionary download failed: HTTP ${listResponse.status}`);
if (!commonResponse.ok) throw new Error(`Common-word filter download failed: HTTP ${commonResponse.status}`);
const raw = await listResponse.text();
const commonRaw = await commonResponse.text();
const common = new Set(commonRaw.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(Boolean));

// Prefer plausible, memorable single-word handles, not obvious everyday words.
// Exclude the top 20k English-frequency list; favor 5–11 letters and readable vowel/consonant patterns.
const unique = [...new Set(raw.split(/\r?\n/).map(w => w.trim().toLowerCase())
  .filter(w => /^[a-z]{5,11}$/.test(w) && !common.has(w)))];
const score = word => {
  const vowels = (word.match(/[aeiouy]/g) || []).length;
  const ratio = vowels / word.length;
  const longestConsonantRun = Math.max(0, ...(word.match(/[^aeiouy]+/g) || []).map(s => s.length));
  const lengthPenalty = Math.abs(word.length - 7) * 2;
  const vowelPenalty = ratio < 0.22 || ratio > 0.58 ? 5 : 0;
  const consonantPenalty = Math.max(0, longestConsonantRun - 3) * 2;
  return lengthPenalty + vowelPenalty + consonantPenalty;
};
const words = unique.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
state.totalWords = words.length;
const start = Math.min(Number(state.offset) || 0, words.length);
const end = Math.min(start + LIMIT, words.length);
if (start >= words.length) {
  console.log(`Scan complete: ${words.length} uncommon, handle-friendly candidates.`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const resultPath = path.join(ROOT, "results", `${date}.csv`);
try { await fs.access(resultPath); } catch {
  await fs.writeFile(resultPath, "username,status,fragment_status,price,currency,fragment_url,checked_at,error\n");
}
let checked = 0;
for (let i = start; i < end; i += 15) {
  const batch = words.slice(i, Math.min(i + 15, end));
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usernames: batch })
    });
    if (response.ok) break;
    const retryAfter = Number(response.headers.get("retry-after") || 60);
    if (attempt === 3) throw new Error(`Bulk check failed at offset ${i}: HTTP ${response.status}`);
    await sleep(response.status === 429 ? Math.max(1000, retryAfter * 1000) : 3000);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.results) || payload.results.length !== batch.length) {
    throw new Error(`Unexpected API response at offset ${i}; refusing to advance checkpoint`);
  }
  const rows = payload.results.map(item => {
    const username = String(item.username || "").toLowerCase();
    const status = item.result?.status || "unknown";
    const price = item.fragment?.price?.amount ?? "";
    const currency = item.fragment?.price?.currency ?? "";
    const fields = [username, status, item.fragment?.status ?? "", price, currency,
      item.fragment?.url || `https://fragment.com/username/${username}`,
      item.checked_at || new Date().toISOString(), item.fragment?.error?.code || item.telegram?.error?.code || ""];
    return fields.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",");
  });
  await fs.appendFile(resultPath, rows.join("\n") + "\n");
  checked += payload.results.length;
  state.offset = i + batch.length;
  state.updatedAt = new Date().toISOString();
  state.strategy = STRATEGY;
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  await sleep(2500); // Stay below the API's 25 requests/minute limit.
}
console.log(JSON.stringify({ checked, start, end: state.offset, totalWords: words.length, strategy: STRATEGY, resultsFile: resultPath, complete: state.offset >= words.length }));
