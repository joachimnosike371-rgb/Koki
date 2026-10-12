import { NextResponse, type NextRequest } from "next/server";

// Same-origin JSON-RPC proxy for Robinhood Chain — now with a
// short-TTL read cache.
//
// WHY the proxy: the public RPC intermittently rejects some regions'
// IPs, so every visitor routes through hamr.fun instead.
//
// WHY the cache: every visitor's board/chart fires the SAME reads
// (token lists, logs, block timestamps). At public-launch traffic that
// multiplied into hundreds of identical upstream calls per second, the
// upstream rate-limited Vercel's egress IPs, and the whole site felt
// slow. Caching identical read calls for a few seconds collapses all
// that duplication to ~one upstream call per unique query — visitors
// mostly get instant answers from memory.
//
// Cache rules:
// - Only whitelisted READ methods are cached (never sends, never
//   nonces, never gas estimates).
// - Historical lookups (specific block number / tx hash) are immutable
//   → cached long. "latest"-ish reads get a short TTL.
// - Per-instance in-memory LRU; entries are tiny JSON strings.

export const runtime = "nodejs";
export const maxDuration = 30;

// NOTE: must stay the DIRECT endpoint — the chain config's default RPC
// now points at this proxy, so reading it here would loop.
const UPSTREAM =
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const METHOD_OK = /^(eth_|net_|web3_)[a-zA-Z0-9_]+$/;

type RpcCall = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
type RpcResult = { jsonrpc: string; id: unknown; result?: unknown; error?: unknown };

function methodAllowed(call: RpcCall): boolean {
  return typeof call.method === "string" && METHOD_OK.test(call.method);
}

// ── Read cache ──────────────────────────────────────────────────────
const SHORT_TTL = 4_000; // "latest" state
const LONG_TTL = 10 * 60_000; // immutable history
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { exp: number; result: unknown }>();

function isHexNumber(v: unknown): boolean {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) && v !== "0x";
}

/** TTL for a call, or 0 when it must not be cached. */
function ttlFor(call: RpcCall): number {
  const p = Array.isArray(call.params) ? call.params : [];
  switch (call.method) {
    case "eth_chainId":
    case "net_version":
    case "web3_clientVersion":
      return LONG_TTL;
    case "eth_blockNumber":
      return 2_000;
    case "eth_getBlockByNumber":
      // A specific block never changes; "latest"/"pending" do.
      return isHexNumber(p[0]) ? LONG_TTL : SHORT_TTL;
    case "eth_getBlockByHash":
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
      // Receipts flip from null → value once mined; short-cache the
      // nulls implicitly by only caching non-null results (below).
      return LONG_TTL;
    case "eth_call":
    case "eth_getBalance":
    case "eth_getStorageAt":
    case "eth_getCode":
    case "eth_getLogs":
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
    case "eth_feeHistory":
      return SHORT_TTL;
    default:
      // eth_sendRawTransaction, eth_estimateGas, eth_getTransactionCount
      // (nonces!), filters, subscriptions — never cached.
      return 0;
  }
}

function cacheKey(call: RpcCall): string {
  return `${call.method}:${JSON.stringify(call.params ?? [])}`;
}

function cacheGet(key: string): { result: unknown } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key: string, result: unknown, ttl: number) {
  if (cache.size >= MAX_ENTRIES) {
    // Evict oldest-inserted entries (Map preserves insertion order).
    let n = 500;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--n <= 0) break;
    }
  }
  cache.set(key, { exp: Date.now() + ttl, result });
}

async function callUpstream(payload: RpcCall[] | RpcCall): Promise<Response> {
  return fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
}

export async function POST(req: NextRequest) {
  let body: RpcCall | RpcCall[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const isBatch = Array.isArray(body);
  const calls: RpcCall[] = Array.isArray(body) ? body : [body as RpcCall];
  if (calls.length === 0 || calls.length > 300 || !calls.every(methodAllowed)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } },
      { status: 400 },
    );
  }

  try {
    // Partition: cache hits answer locally, the rest go upstream in one
    // forwarded batch.
    const answers = new Array<RpcResult | null>(calls.length).fill(null);
    const misses: { idx: number; call: RpcCall }[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const ttl = ttlFor(call);
      if (ttl > 0) {
        const hit = cacheGet(cacheKey(call));
        if (hit) {
          answers[i] = { jsonrpc: "2.0", id: call.id ?? null, result: hit.result };
          continue;
        }
      }
      misses.push({ idx: i, call });
    }

    if (misses.length > 0) {
      const payload = misses.map((m) => m.call);
      const upstream = await callUpstream(isBatch ? payload : payload[0]);
      const text = await upstream.text();
      if (!upstream.ok) {
        // Upstream unhappy — pass through untouched (no partial answers).
        return new NextResponse(text, {
          status: upstream.status,
          headers: { "content-type": "application/json" },
        });
      }
      const parsed = JSON.parse(text) as RpcResult | RpcResult[];
      const results = Array.isArray(parsed) ? parsed : [parsed];
      // Match results to calls by id (order is not guaranteed by spec).
      const byId = new Map<string, RpcResult>();
      for (const r of results) byId.set(String(r.id), r);
      for (const m of misses) {
        const r = byId.get(String(m.call.id)) ?? results[misses.indexOf(m)];
        answers[m.idx] = r ?? {
          jsonrpc: "2.0",
          id: m.call.id ?? null,
          error: { code: -32000, message: "missing upstream result" },
        };
        const ttl = ttlFor(m.call);
        if (ttl > 0 && r && r.error === undefined && r.result !== null) {
          cacheSet(cacheKey(m.call), r.result, ttl);
        }
      }
    }

    const out = isBatch ? answers : answers[0];
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: `Upstream RPC unreachable: ${err instanceof Error ? err.message : "unknown"}`,
        },
      },
      { status: 502 },
    );
  }
}
