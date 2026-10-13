import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isAuthorizedAgentRequest } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

type MarketItem = {
  token_address: string;
  ticker: string;
  token_name: string;
  mcapEth: number | null;
  progressBps: number | null;
  graduated: boolean;
  vol24hEth: number;
};

function rankMarket(item: MarketItem): number {
  // Volume is the primary signal. Progress is a modest tie-breaker;
  // no buyer identity or wallet concentration is used.
  const volume = Math.max(0, Number(item.vol24hEth) || 0);
  const progress = Math.max(0, Math.min(10_000, Number(item.progressBps) || 0));
  return Math.log1p(volume) * 100 + progress / 10_000;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorizedAgentRequest(req))) {
    return NextResponse.json({ ok: false, error: "Agent endpoint requires CRON_SECRET authorization." }, { status: 401 });
  }

  const startedAt = new Date();
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Agent ledger unavailable: configure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then apply the agent ledger migration." }, { status: 503 });
  }

  const baseUrl = new URL(req.url).origin;
  const boardResponse = await fetch(`${baseUrl}/api/board`, { cache: "no-store" });
  if (!boardResponse.ok) {
    return NextResponse.json({ ok: false, error: `Market board returned HTTP ${boardResponse.status}` }, { status: 502 });
  }

  const board = await boardResponse.json() as { ok?: boolean; items?: MarketItem[] };
  const items = (Array.isArray(board.items) ? board.items : [])
    .filter((item) => item?.token_address && Number.isFinite(Number(item.vol24hEth)))
    .map((item) => ({ ...item, score: rankMarket(item) }))
    .sort((a, b) => b.score - a.score);

  const now = new Date();
  const { data: activeSessions, error: sessionReadError } = await supabase
    .from("agent_sessions")
    .select("id, deadline_at, target_net_revenue, net_revenue, status")
    .eq("status", "monitoring")
    .order("started_at", { ascending: false })
    .limit(1);

  if (sessionReadError) {
    return NextResponse.json({ ok: false, error: `Cannot read agent session: ${sessionReadError.message}` }, { status: 500 });
  }

  let session = activeSessions?.[0];
  if (!session) {
    const { data, error } = await supabase.from("agent_sessions").insert({
      target_asset: "ETH",
      target_net_revenue: 1,
      duration_hours: 18,
      starting_capital: 0,
      status: "monitoring",
      started_at: now.toISOString(),
      deadline_at: new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString(),
    }).select("id, deadline_at, target_net_revenue, net_revenue, status").single();
    if (error) return NextResponse.json({ ok: false, error: `Cannot create agent session: ${error.message}` }, { status: 500 });
    session = data;
  }

  const selected = items[0];
  const { data: cycle, error: cycleError } = await supabase.from("agent_cycles").insert({
    session_id: session.id,
    status: "completed",
    market_count: items.length,
    selected_token_address: selected?.token_address ?? null,
    selected_ticker: selected?.ticker ?? null,
    selected_volume_24h: selected?.vol24hEth ?? null,
    payload: {
      strategy: "volume-first",
      target: "1 ETH net revenue within 18 hours",
      revenue_verified: false,
      launches_executed: 0,
      note: "This cycle ranks observable Robinhood Chain markets. It does not execute launches or claim unverified fees as revenue.",
      top_markets: items.slice(0, 10).map((item) => ({
        token_address: item.token_address,
        ticker: item.ticker,
        token_name: item.token_name,
        volume_24h_eth: item.vol24hEth,
        market_cap_eth: item.mcapEth,
        progress_bps: item.progressBps,
        graduated: item.graduated,
        score: item.score,
      })),
    },
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
  }).select("id").single();

  if (cycleError) return NextResponse.json({ ok: false, error: `Cannot record agent cycle: ${cycleError.message}` }, { status: 500 });

  if (items.length) {
    const rows = items.map((item) => ({
      cycle_id: cycle.id,
      chain: "robinhood",
      token_address: item.token_address,
      ticker: item.ticker,
      token_name: item.token_name,
      volume_24h: Math.max(0, Number(item.vol24hEth) || 0),
      market_cap: item.mcapEth,
      progress_bps: item.progressBps,
      graduated: Boolean(item.graduated),
      score: item.score,
    }));
    const { error } = await supabase.from("agent_market_observations").upsert(rows, {
      onConflict: "cycle_id,chain,token_address",
    });
    if (error) {
      return NextResponse.json({ ok: false, cycle_id: cycle.id, error: `Cycle recorded but market observations failed: ${error.message}` }, { status: 500 });
    }
  }

  const deadline = new Date(session.deadline_at);
  if (now >= deadline && session.status === "monitoring") {
    await supabase.from("agent_sessions").update({ status: "expired" }).eq("id", session.id);
  }

  return NextResponse.json({
    ok: true,
    session_id: session.id,
    cycle_id: cycle.id,
    deadline_at: session.deadline_at,
    target_net_revenue_eth: Number(session.target_net_revenue),
    verified_net_revenue_eth: Number(session.net_revenue ?? 0),
    market_count: items.length,
    top_market: selected ? {
      ticker: selected.ticker,
      token_address: selected.token_address,
      volume_24h_eth: selected.vol24hEth,
      score: selected.score,
    } : null,
    launches_executed: 0,
    revenue_verified: false,
    message: "Market scan recorded. Launch execution and fee verification are not yet connected.",
  });
}

// Vercel Cron invokes GET; authenticated manual schedulers may use POST.
export async function GET(req: NextRequest) {
  return POST(req);
}
