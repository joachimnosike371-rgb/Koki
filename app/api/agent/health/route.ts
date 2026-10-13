import { NextResponse } from "next/server";
import { getPublicClient } from "@/lib/robinhood/client";
import { ROBINHOOD_CHAIN_ID } from "@/lib/robinhood/chain";
import { HAMR_V2 } from "@/lib/hamr/v2";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Read-only readiness diagnostics. This endpoint never returns environment
 * variable values, queries no user data, and submits no transactions.
 */
export async function GET() {
  const environment = {
    supabaseUrlConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
  };

  let rpc: {
    ok: boolean;
    chainId: number | null;
    expectedChainId: number;
    launchpadHasCode: boolean;
    lockerHasCode: boolean;
    error?: string;
  } = {
    ok: false,
    chainId: null,
    expectedChainId: ROBINHOOD_CHAIN_ID,
    launchpadHasCode: false,
    lockerHasCode: false,
  };

  try {
    const client = getPublicClient();
    const [chainId, launchpadCode, lockerCode] = await Promise.all([
      client.getChainId(),
      client.getBytecode({ address: HAMR_V2.launchpad }),
      client.getBytecode({ address: HAMR_V2.locker }),
    ]);
    rpc = {
      ok: chainId === ROBINHOOD_CHAIN_ID && Boolean(launchpadCode && launchpadCode !== "0x") && Boolean(lockerCode && lockerCode !== "0x"),
      chainId,
      expectedChainId: ROBINHOOD_CHAIN_ID,
      launchpadHasCode: Boolean(launchpadCode && launchpadCode !== "0x"),
      lockerHasCode: Boolean(lockerCode && lockerCode !== "0x"),
    };
  } catch (error) {
    rpc.error = error instanceof Error ? error.message : "RPC check failed";
  }

  let database = {
    configured: false,
    agentLedgerTables: false,
    feeCursorTable: false,
    ok: false,
  };

  const supabase = getSupabaseAdmin();
  if (supabase) {
    database.configured = true;
    const [ledger, cursor] = await Promise.all([
      supabase.from("agent_sessions").select("id").limit(1),
      supabase.from("agent_indexer_cursors").select("name").limit(1),
    ]);
    database.agentLedgerTables = !ledger.error;
    database.feeCursorTable = !cursor.error;
    database.ok = database.agentLedgerTables && database.feeCursorTable;
  }

  const ready =
    environment.supabaseUrlConfigured &&
    environment.serviceRoleConfigured &&
    environment.cronSecretConfigured &&
    rpc.ok &&
    database.ok;

  return NextResponse.json(
    {
      ok: ready,
      ready,
      checks: { environment, rpc, database },
      note: ready
        ? "Infrastructure checks passed. This does not mean autonomous launch execution is enabled."
        : "Not ready. Configure missing environment variables, apply both agent ledger migrations, and verify Robinhood Chain contract/RPC access.",
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
