import { NextResponse } from "next/server";
import { formatEther, type Address } from "viem";
import { getPublicClient } from "@/lib/robinhood/client";
import { readTokenMeta } from "@/lib/hamr/read";
import { HIDDEN_TOKENS } from "@/lib/hamr/constants";
import {
  listV2Tokens,
  poolSwapEvent,
  readV2Snapshot,
  tokenIsToken0,
} from "@/lib/hamr/v2";
import { getSupabaseAdmin, supabaseEnabled } from "@/lib/supabase/server";

// /api/board — bounded, cached market snapshot.
//
// The old implementation scanned every TokenLaunched event from genesis,
// then scanned every pool's Swap history from genesis. Both operations grow
// forever and can exceed public-RPC log limits, causing the whole endpoint
// to return 502. The board now loads only the newest 24 factory tokens and
// requests swap logs for the last 24 hours. A single timestamp binary search
// finds the start block; no per-swap timestamp requests are needed.

export const runtime = "nodejs";
export const maxDuration = 30;

interface BoardItem {
  token_address: string;
  ticker: string;
  token_name: string;
  logo_url: string | null;
  wallet_address: string;
  source_x_url: string | null;
  created_at: string;
  mcapEth: number | null;
  progressBps: number | null;
  graduated: boolean;
  vol24hEth: number;
}

let cache: { at: number; body: { ok: true; items: BoardItem[] } } | null = null;
const TTL_MS = 30_000;
let building: Promise<{ ok: true; items: BoardItem[] }> | null = null;
const BOARD_TOKEN_LIMIT = 12;
const LOG_BLOCK_CHUNK = 5_000n;

async function findBlockAtOrAfterTimestamp(
  cutoffSeconds: number,
  latestBlock: bigint,
): Promise<bigint> {
  let low = 0n;
  let high = latestBlock;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await getPublicClient().getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < cutoffSeconds) low = mid + 1n;
    else high = mid;
  }
  return low;
}

async function build(): Promise<{ ok: true; items: BoardItem[] }> {
  const client = getPublicClient();
  const tokens = (await listV2Tokens(BOARD_TOKEN_LIMIT)).filter(
    (token) => !HIDDEN_TOKENS.has(token.toLowerCase()),
  );
  const latestBlock = await client.getBlockNumber();
  const cutoffSeconds = Math.floor(Date.now() / 1000) - 86_400;

  // Timestamp lookup is logarithmic in chain height (~20 reads, not one read
  // per swap). If it fails, still render the board; volume is conservatively
  // left at zero rather than making a failing volume query take down the page.
  let volumeStartBlock: bigint | null = null;
  try {
    volumeStartBlock = await findBlockAtOrAfterTimestamp(cutoffSeconds, latestBlock);
  } catch (error) {
    console.warn("[api/board] Could not determine 24h block boundary:", error);
  }

  // DB enrichment is best-effort. On-chain launches remain visible even if
  // Supabase is unavailable or a token was not created through this UI.
  const launchRows = new Map<string, {
    source_x_url: string | null;
    created_at: string | null;
    wallet_address: string | null;
  }>();
  if (supabaseEnabled()) {
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { data, error } = await sb
          .from("pons_launches")
          .select("token_address, source_x_url, created_at, wallet_address")
          .order("created_at", { ascending: false })
          .limit(100);
        if (!error) {
          for (const row of data ?? []) {
            if (row.token_address) {
              launchRows.set(String(row.token_address).toLowerCase(), {
                source_x_url: row.source_x_url ?? null,
                created_at: row.created_at ?? null,
                wallet_address: row.wallet_address ?? null,
              });
            }
          }
        } else {
          console.warn("[api/board] Supabase enrichment unavailable:", error.message);
        }
      }
    } catch (error) {
      console.warn("[api/board] Supabase enrichment failed:", error);
    }
  }

  const items: BoardItem[] = [];
  for (const token of tokens) {
    const [meta, snapshot] = await Promise.all([
      readTokenMeta(token).catch(() => null),
      readV2Snapshot(token).catch(() => null),
    ]);
    const row = launchRows.get(token.toLowerCase());

    let volume = 0;
    if (snapshot && volumeStartBlock !== null) {
      try {
        const tokenIs0 = tokenIsToken0(token);
        // Public RPC providers often cap eth_getLogs ranges. Split the exact
        // 24-hour interval into bounded chunks; if any chunk fails, discard
        // the partial total rather than presenting an undercount as 24h volume.
        for (let fromBlock = volumeStartBlock; fromBlock <= latestBlock; ) {
          const candidateEnd = fromBlock + LOG_BLOCK_CHUNK - 1n;
          const toBlock = candidateEnd < latestBlock ? candidateEnd : latestBlock;
          const swaps = await client.getLogs({
            address: snapshot.pool,
            event: poolSwapEvent,
            fromBlock,
            toBlock,
          });
          for (const swap of swaps) {
            const args = swap.args as { amount0?: bigint; amount1?: bigint };
            const wethDelta = tokenIs0 ? args.amount1 : args.amount0;
            if (typeof wethDelta === "bigint") {
              volume += Math.abs(Number(formatEther(wethDelta)));
            }
          }
          fromBlock = toBlock + 1n;
        }
      } catch (error) {
        // A busy pool or provider log cap should not fail the entire board.
        // Never expose a partial chunk sum as a complete 24-hour total.
        volume = 0;
        console.warn(`[api/board] 24h volume unavailable for ${token}:`, error);
      }
    }

    items.push({
      token_address: token,
      ticker: meta?.symbol ?? "?",
      token_name: meta?.name ?? token.slice(0, 8),
      logo_url: meta?.logo || null,
      wallet_address: snapshot?.creator ?? row?.wallet_address ?? "",
      source_x_url: row?.source_x_url ?? null,
      created_at: row?.created_at ?? "",
      mcapEth: snapshot ? snapshot.priceEth * snapshot.circulating : null,
      progressBps: snapshot?.progressBps ?? null,
      graduated: snapshot?.graduated ?? false,
      vol24hEth: volume,
    });
  }

  // listV2Tokens returns newest-first, so no second historical event scan or
  // sort is needed. That preserves useful ordering for on-chain-only tokens.
  return { ok: true, items };
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return NextResponse.json(cache.body, {
      headers: {
        "cache-control": "public, s-maxage=20, stale-while-revalidate=60",
      },
    });
  }

  // Coalesce concurrent builds into one RPC-heavy operation per instance.
  if (!building) {
    building = build()
      .then((body) => {
        cache = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        building = null;
      });
  }

  try {
    const body = await building;
    return NextResponse.json(body, {
      headers: {
        "cache-control": "public, s-maxage=20, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    if (cache) {
      return NextResponse.json(cache.body, {
        headers: { "cache-control": "public, stale-while-revalidate=60" },
      });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "board build failed" },
      { status: 502 },
    );
  }
}
