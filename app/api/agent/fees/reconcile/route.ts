import { NextResponse, type NextRequest } from "next/server";
import { formatEther, parseAbiItem, type Address } from "viem";
import { getPublicClient } from "@/lib/robinhood/client";
import { HAMR_CONTRACTS } from "@/lib/hamr/constants";
import { HAMR_V2 } from "@/lib/hamr/v2";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isAuthorizedAgentRequest } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const CHAIN = "robinhood";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const CURSOR_NAME = "robinhood-treasury-fees";
const CONFIRMATIONS = 5;
const MAX_BLOCKS_PER_SCAN = 2_000;

const protocolClaimedEvent = parseAbiItem(
  "event ProtocolFeesClaimed(uint256 amount)",
);
const protocolClaimedV2Event = parseAbiItem(
  "event ProtocolFeesClaimed(address indexed treasury, uint256 amount)",
);
const lockerProtocolClaimedEvent = parseAbiItem(
  "event ProtocolClaimed(address indexed token, address indexed currency, uint256 amount)",
);

type FeeRow = {
  session_id: string | null;
  chain: string;
  asset: "ETH";
  amount: string;
  fee_kind: "protocol_fee" | "trade_fee";
  tx_hash: string;
  log_index: number;
  token_address: string | null;
  source: "robinhood_rpc_event";
  verified: true;
  occurred_at: string;
  block_number: number;
};

export async function POST(req: NextRequest) {
  if (!(await isAuthorizedAgentRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase is not configured. Apply the agent ledger migrations first." },
      { status: 503 },
    );
  }

  const client = getPublicClient();
  try {
    const latest = await client.getBlockNumber();
    const safeHead = latest > BigInt(CONFIRMATIONS) ? latest - BigInt(CONFIRMATIONS) : 0n;

    const { data: cursor, error: cursorReadError } = await supabase
      .from("agent_indexer_cursors")
      .select("last_scanned_block")
      .eq("name", CURSOR_NAME)
      .maybeSingle();
    if (cursorReadError) throw new Error(`Cursor read failed: ${cursorReadError.message}`);

    let fromBlock: bigint;
    if (cursor) {
      fromBlock = BigInt(cursor.last_scanned_block) + 1n;
    } else {
      // First run intentionally backfills only a small recent window. Set
      // AGENT_FEE_SCAN_FROM_BLOCK to a deployment block for a full backfill.
      const configured = process.env.AGENT_FEE_SCAN_FROM_BLOCK;
      fromBlock = configured
        ? BigInt(configured)
        : safeHead > BigInt(MAX_BLOCKS_PER_SCAN)
          ? safeHead - BigInt(MAX_BLOCKS_PER_SCAN) + 1n
          : 0n;
    }

    if (fromBlock > safeHead) {
      return NextResponse.json({
        ok: true,
        indexed: 0,
        from_block: fromBlock.toString(),
        to_block: safeHead.toString(),
        message: "Fee index is up to date; only confirmed blocks are scanned.",
      });
    }

    // Bound each RPC request. The cursor advances only after all rows have
    // been persisted, so a transient database failure is safe to retry.
    const toBlock = fromBlock + BigInt(MAX_BLOCKS_PER_SCAN - 1) < safeHead
      ? fromBlock + BigInt(MAX_BLOCKS_PER_SCAN - 1)
      : safeHead;

    const [launchpadLogs, launchpadV2Logs, lockerLogs, lockerV2Logs, sessionResult] = await Promise.all([
      client.getLogs({
        address: HAMR_CONTRACTS.launchpad,
        event: protocolClaimedEvent,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: HAMR_V2.launchpad,
        event: protocolClaimedV2Event,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: HAMR_CONTRACTS.locker,
        event: lockerProtocolClaimedEvent,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: HAMR_V2.locker,
        event: lockerProtocolClaimedEvent,
        fromBlock,
        toBlock,
      }),
      supabase.from("agent_sessions")
        .select("id, started_at, status")
        .eq("status", "monitoring")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (sessionResult.error) throw new Error(`Session read failed: ${sessionResult.error.message}`);
    const session = sessionResult.data;

    const allLogs = [
      ...launchpadLogs.map((log) => ({
        log,
        amount: log.args.amount,
        feeKind: "protocol_fee" as const,
        tokenAddress: null,
        asset: "ETH" as const,
      })),
      ...launchpadV2Logs.map((log) => ({
        log,
        amount: log.args.amount,
        feeKind: "protocol_fee" as const,
        tokenAddress: null,
        asset: "ETH" as const,
      })),
      ...lockerLogs
        .filter((log) => String(log.args.currency).toLowerCase() === WETH.toLowerCase())
        .map((log) => ({
          log,
          amount: log.args.amount,
          feeKind: "trade_fee" as const,
          tokenAddress: String(log.args.token).toLowerCase(),
          asset: "ETH" as const,
        })),
      ...lockerV2Logs
        .filter((log) => String(log.args.currency).toLowerCase() === WETH.toLowerCase())
        .map((log) => ({
          log,
          amount: log.args.amount,
          feeKind: "trade_fee" as const,
          tokenAddress: String(log.args.token).toLowerCase(),
          asset: "ETH" as const,
        })),
    ];

    const timestamps = new Map<string, string>();
    await Promise.all([...new Set(allLogs.map(({ log }) => log.blockNumber.toString()))].map(async (block) => {
      const data = await client.getBlock({ blockNumber: BigInt(block) });
      timestamps.set(block, new Date(Number(data.timestamp) * 1000).toISOString());
    }));

    const sessionStartedAt = session?.started_at ? Date.parse(session.started_at) : Number.POSITIVE_INFINITY;
    const rows: FeeRow[] = allLogs.flatMap(({ log, amount, feeKind, tokenAddress, asset }) => {
      if (typeof amount !== "bigint" || !log.transactionHash || typeof log.logIndex !== "number") return [];
      const occurredAt = timestamps.get(log.blockNumber.toString());
      if (!occurredAt) return [];
      return [{
        session_id: session && Date.parse(occurredAt) >= sessionStartedAt ? session.id : null,
        chain: CHAIN,
        asset,
        amount: formatEther(amount),
        fee_kind: feeKind,
        tx_hash: log.transactionHash,
        log_index: Number(log.logIndex),
        token_address: tokenAddress,
        source: "robinhood_rpc_event",
        verified: true,
        occurred_at: occurredAt,
        block_number: Number(log.blockNumber),
      }];
    });

    if (rows.length) {
      const { error } = await supabase.from("agent_fee_ledger").upsert(rows, {
        onConflict: "chain,tx_hash,log_index,fee_kind",
        ignoreDuplicates: true,
      });
      if (error) throw new Error(`Fee ledger write failed: ${error.message}`);
    }

    const { error: cursorWriteError } = await supabase.from("agent_indexer_cursors").upsert({
      name: CURSOR_NAME,
      last_scanned_block: Number(toBlock),
      updated_at: new Date().toISOString(),
    }, { onConflict: "name" });
    if (cursorWriteError) throw new Error(`Cursor update failed: ${cursorWriteError.message}`);

    // Only successful treasury-claim events count as realized revenue.
    // Uniswap volume and unclaimed fee balances are deliberately excluded.
    let sessionTotals: { revenue: number; costs: number } | null = null;
    if (session) {
      const { data: ledger, error } = await supabase
        .from("agent_fee_ledger")
        .select("amount, fee_kind")
        .eq("session_id", session.id)
        .eq("verified", true);
      if (error) throw new Error(`Fee total read failed: ${error.message}`);
      const totals = (ledger ?? []).reduce((acc, row) => {
        const amount = Number(row.amount) || 0;
        if (["trade_fee", "protocol_fee", "creator_fee"].includes(row.fee_kind)) acc.revenue += amount;
        if (["gas_cost", "infrastructure_cost", "launch_fee", "other"].includes(row.fee_kind)) acc.costs += amount;
        return acc;
      }, { revenue: 0, costs: 0 });
      sessionTotals = totals;
      const status = totals.revenue - totals.costs >= 1 ? "target_reached" : "monitoring";
      const { error: updateError } = await supabase.from("agent_sessions").update({
        verified_fee_revenue: totals.revenue,
        verified_costs: totals.costs,
        net_revenue: totals.revenue - totals.costs,
        last_cycle_at: new Date().toISOString(),
        ...(status === "target_reached" ? { status } : {}),
      }).eq("id", session.id);
      if (updateError) throw new Error(`Session revenue update failed: ${updateError.message}`);
    }

    return NextResponse.json({
      ok: true,
      indexed: rows.length,
      from_block: fromBlock.toString(),
      to_block: toBlock.toString(),
      session_id: session?.id ?? null,
      verified_revenue_eth: sessionTotals?.revenue ?? null,
      verified_costs_eth: sessionTotals?.costs ?? null,
      verified_net_revenue_eth: sessionTotals ? sessionTotals.revenue - sessionTotals.costs : null,
      message: "Revenue includes only confirmed treasury fee-claim events; volume and unclaimed fees are not counted.",
    });
  } catch (error) {
    console.error("[agent/fees/reconcile]", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Fee reconciliation failed",
    }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
