import { NextResponse, type NextRequest } from "next/server";
import { callLLM } from "@/lib/llm/router";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Msg } from "@/lib/llm/types";

// ─────────────────────────────────────────────────────────────────────────
// /api/cron/refresh-memes, pre-warmed x_search cache
//
// Runs every 30 minutes via Vercel Cron. Hits xAI's expensive `x_search`
// tool once, pulls the freshest viral X memes that would make good
// memecoin anchors, and writes them to public.cached_memes. /api/auto-
// launch then reads from the cache (instant) instead of re-running
// x_search on every user click (20-40s).
//
// Auth: Vercel signs cron requests with a CRON_SECRET header. We refuse
// any request that doesn't carry the expected secret.
//
// Quality preservation: this runs the SAME flagship model (grok-4-latest)
// and the SAME x_search tool the synchronous path used to use, so output
// fidelity is identical, we're just pre-paying the 20-40s wait.
// ─────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 180;

interface CachedMeme {
  x_url: string;
  x_author: string;
  image_url: string | null;
  summary: string;
  meme_angle: string | null;
  engagement_score: number | null;
}

interface RefreshResponse {
  ok: boolean;
  inserted?: number;
  batchId?: string;
  citations?: string[];
  rawCount?: number;
  error?: string;
}

function buildRefreshMessages(): Msg[] {
  const system = `You are HAMR's meme scout. Your job: scan X for the BIGGEST mega-viral posts of the day and return up to 20 of them as a JSON array, ordered by absolute view count from largest to smallest.

═══ ABSOLUTE PRIORITY ORDER ═══
  1. VIRALITY, raw view count, descending. ALWAYS #1.
     50M views > 10M > 1M > 500K. Take the biggest you can find.
  2. Organic cultural content (not a token shill).
  3. Specificity (a named/recognizable thing, not a placeholder).
  4. Freshness (last 24h required; within that, fresher only as soft
     tiebreaker, never override #1).
═══════════════════════════════


Use the x_search tool AGGRESSIVELY. Run multiple queries with different angles to build a wide candidate pool. Prefer queries that surface high-view posts:
  - trending viral X posts last hour
  - top liked tweets today
  - viral images X right now
  - what's everyone laughing at on X today
  - viral video X today
  - meme of the day X
  - crypto twitter trending today

HARD ENGAGEMENT FLOOR. This is a TOP-OF-TIMELINE feed. Reject ANY post that doesn't clearly meet ALL of these:
  • 500,000+ views (HALF A MILLION absolute minimum)
  • 50,000+ likes OR 10,000+ retweets/reposts
A post with 45 views, 5K views, or 80K views IS NOT TRENDING. SKIP IT. Don't pad the response with weak picks.

If you cannot SEE explicit view/like/retweet numbers in the x_search result, you must skip that candidate, no guessing, no estimating.

PRIORITIZE BY ABSOLUTE VIEW COUNT, HIGHEST FIRST. Order your final list view-count descending. Strongly prefer 10M+ views over 1M+; prefer 1M+ over 500K+. The first entries in your JSON array should be the biggest of the day.

FRESHNESS: 24h window is hard, but within it, prefer the LAST 6-12 HOURS. If a post is from "yesterday evening" and you have an equally viral one from the last 6 hours, pick the fresher one.

HARD CONTENT FILTER. Each post must be:
✓ Organic cultural content, joke, image, observation, format, character, screenshot
✓ Has an attached image (we use it as the eventual token logo)
✗ NOT a token shill, no "$TICKER buy now", "CA:", pump.fun links, dexscreener links, "fair launch live", "send it"
✗ NOT from a memecoin alpha account or pump caller
✗ NOT a token chart screenshot or a reply chain promoting an existing coin

Test: would this post still be funny/memorable if crypto didn't exist? If yes → eligible. If no → skip.

SPECIFICITY: the summary must point at something CONCRETE, a named character, a specific event, a recognizable visual, an exact punchline. REJECT generic placeholders like "a dog sitting on a fence" or "a cat with a beautiful coat", those aren't viral, they're stock photos.

VARIETY: don't return 20 cats. Mix dog/frog/AI/NPC/format/screenshot/event/character so different users get different vibes.

Return STRICT JSON ONLY in this exact shape, no markdown fences, no prose around it:

{
  "memes": [
    {
      "x_url": "https://x.com/<handle>/status/<id>",
      "x_author": "@handle",
      "image_url": "https://pbs.twimg.com/media/<id>?format=jpg&name=large  OR  null",
      "summary": "1-2 sentence description pointing at a SPECIFIC recognizable thing",
      "meme_angle": "1 sentence on why this has memecoin potential",
      "engagement_score": 0.0-1.0
    },
    ...
  ]
}

Target: 12-20 memes. All x_url and image_url values MUST come from real x_search results, never fabricated. If a post has no image, set image_url to null and prefer a different post. If your search just doesn't yield 12 posts that clear the engagement floor, return fewer entries rather than padding with weak picks.`;

  const user = `Refresh the meme cache. Pull up to 20 mega-viral X posts from the LAST 24 HOURS that each clear the HARD floor (500K+ views AND 50K+ likes OR 10K+ reposts). Order DESCENDING by view count, biggest first. Prefer last 6-12 hours within the window. Variety matters, mix dog/frog/AI/NPC/format/screenshot. Generic descriptions ("a cat in a hat") are a fail, point at a specific named/recognizable thing. Return fewer entries rather than padding with weak picks. JSON only.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseRefreshOutput(raw: string): CachedMeme[] {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }
  const data = JSON.parse(s) as { memes?: unknown };
  if (!Array.isArray(data.memes)) {
    throw new Error("refresh output missing `memes` array");
  }

  const urlPattern = /^https?:\/\/(?:x\.com|twitter\.com)\/[^/\s]+\/status\/\d+/;
  const imgPattern = /^https?:\/\/pbs\.twimg\.com\/(?:media|tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\/[^\s]+/;
  const handlePattern = /^@[A-Za-z0-9_]{1,15}$/;
  const shillSignal = /\b(?:CA|contract)\s*[:=]?\s*[1-9A-HJ-NP-Za-km-z]{32,}|pump\.fun\/coin|dexscreener|0x[0-9a-f]{40}|fair\s*launch\s*live|sending\s+it\s+now|buy\s+now\s+\$[A-Z]{2,8}/i;

  const out: CachedMeme[] = [];
  for (const m of data.memes as Array<Record<string, unknown>>) {
    if (typeof m.x_url !== "string") continue;
    const xUrl = (m.x_url as string).trim().replace("twitter.com", "x.com");
    if (!urlPattern.test(xUrl)) continue;

    const author = typeof m.x_author === "string" ? (m.x_author as string).trim() : "";
    if (!handlePattern.test(author)) continue;

    let imageUrl: string | null = null;
    if (typeof m.image_url === "string" && imgPattern.test((m.image_url as string).trim())) {
      imageUrl = (m.image_url as string).trim();
    }

    const summary = typeof m.summary === "string" ? (m.summary as string).trim() : "";
    if (summary.length < 5) continue;

    const memeAngle = typeof m.meme_angle === "string" ? (m.meme_angle as string).trim() : null;
    const score = typeof m.engagement_score === "number" ? m.engagement_score : null;

    // Defensive shill check, never cache a post whose summary mentions token mechanics.
    if (shillSignal.test(`${summary} ${memeAngle ?? ""} ${xUrl}`)) continue;

    out.push({ x_url: xUrl, x_author: author, image_url: imageUrl, summary, meme_angle: memeAngle, engagement_score: score });
  }

  return out;
}

export async function GET(req: NextRequest) {
  // Auth: Vercel cron requests carry an Authorization: Bearer <CRON_SECRET> header.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json<RefreshResponse>({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: "Supabase not configured (set SUPABASE_SERVICE_ROLE_KEY)" },
      { status: 503 },
    );
  }

  // Run x_search via xAI Responses API. We pre-pay the 20-40s wait here so
  // user-facing /api/auto-launch can be instant.
  const today = new Date();
  // 24-hour window, user found 48h was still pulling in "last night"
  // posts. Tighten to 24h; the prompt biases toward last 6-12h.
  const oneDayAgo = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000);
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  let llmRes;
  try {
    llmRes = await callLLM({
      messages: buildRefreshMessages(),
      responseFormat: "json",
      maxTokens: 2400,
      temperature: 0.9,
      model: process.env.XAI_MODEL_AUTO_CONCEPT || "grok-4.3",
      feature: "cron-refresh-memes",
      liveSearch: {
        fromDate: isoDate(oneDayAgo),
        toDate: isoDate(today),
        maxResults: 50, // bigger pool, most candidates will fail the engagement floor
        enableImageUnderstanding: true,
      },
    });
  } catch (err) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: `LLM call failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  let memes: CachedMeme[];
  try {
    memes = parseRefreshOutput(llmRes.content);
  } catch (err) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: `Parse failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  if (memes.length === 0) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: "No usable memes in LLM output", citations: llmRes.citations },
      { status: 200 },
    );
  }

  // Atomic swap: insert under a new batch_id, then purge old batches. Auto-launch
  // only ever reads rows where expires_at > now(), so the swap is invisible to
  // any concurrent reader.
  const batchId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();

  const rows = memes.map((m) => ({
    x_url: m.x_url,
    x_author: m.x_author,
    image_url: m.image_url,
    summary: m.summary,
    meme_angle: m.meme_angle,
    engagement_score: m.engagement_score,
    batch_id: batchId,
    expires_at: expiresAt,
  }));

  // Use upsert so a meme that came back two refreshes in a row doesn't error
  // on the unique(x_url) constraint.
  const { error: insertErr } = await sb
    .from("cached_memes")
    .upsert(rows, { onConflict: "x_url", ignoreDuplicates: false });
  if (insertErr) {
    return NextResponse.json<RefreshResponse>(
      { ok: false, error: `Insert failed: ${insertErr.message}` },
      { status: 500 },
    );
  }

  // Purge anything older than the new batch, keeps the table bounded.
  await sb.from("cached_memes").delete().neq("batch_id", batchId);

  return NextResponse.json<RefreshResponse>({
    ok: true,
    inserted: rows.length,
    batchId,
    citations: llmRes.citations,
    rawCount: memes.length,
  });
}
