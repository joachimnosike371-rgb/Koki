# HAMR.fun

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Original since 2026-05-04](https://img.shields.io/badge/Original%20since-2026--05--04-E66B1F?style=flat-square)](https://github.com/koki-ai-agent/Koki/commit/ae5ff49)
[![First public commit](https://img.shields.io/badge/First%20public%20commit-ae5ff49-1a1208?style=flat-square)](https://github.com/koki-ai-agent/Koki/commit/ae5ff49)
[![Live](https://img.shields.io/badge/Live-hamr.fun-22c55e?style=flat-square)](https://hamr.fun)

**The Grok-native Meme Coin Launch Agent.**
HAMR.fun detects real-time memes on X and turns them into autonomous Pons launches on Robinhood Chain.

> Real-time X memes → autonomous token launches on Pons.

Token ticker: `$HAMR`

HAMR.fun is an independent open-source project. It is not affiliated with xAI, X, Grok, Pons Labs, Robinhood, or Uniswap. Nothing in this app is financial advice.

---

## 🟧 Originality & Authenticity

HAMR is the **original** autonomous Grok-native memecoin launch agent. Everything in this repository is timestamped, verifiable, and irrevocable on public infrastructure.

| Proof | Source | Date |
|---|---|---|
| **First public commit** | [`ae5ff49`](https://github.com/koki-ai-agent/Koki/commit/ae5ff49) — "Initial commit: X CLAW — The Grok-native Meme Coin Launch Agent" | **2026-05-04** |
| **GitHub repository** | [koki-ai-agent/Koki](https://github.com/koki-ai-agent/Koki) (public, MIT) | 2026-05-04 |
| **Live deployment** | [hamr.fun](https://hamr.fun) | 2026-05 |
| **Official X account** | [@hamrdotfun](https://x.com/hamrdotfun) | — |
| **Onchain launches** | Public Robinhood Chain mainnet transactions from HAMR-built tokens on Pons | continuous |

**If you see a project that looks like HAMR but uses a different name — check the first-commit dates.** Any autonomous Grok × onchain launchpad agent (Pons, Pump.fun, four.meme, or any other) whose first public commit is *after* 2026-05-04 is downstream of this codebase, regardless of how it is marketed.

The full commit history is preserved in this public repository and additionally mirrored by GitHub Arctic Code Vault, the Internet Archive, and downstream forks. Originality here is not a claim — it is a [verifiable hash chain](https://github.com/koki-ai-agent/Koki/commits/main).

---

## The agent loop

```
Detect  →  Analyze  →  Generate  →  Launch  →  Monitor
```

| Phase | What the agent does | Where in the app |
|---|---|---|
| **01 Detect** | Real-time Meme Radar scans X for trending memes, viral keywords, fast-growing narratives. | `/dashboard` |
| **02 Analyze** | 10-criteria launch readiness scoring (viral, clarity, X engagement, ticker strength, on-chain, timing, saturation, brand/legal). | `/analyze?meme=<id>` |
| **03 Generate** | Full AI launch kit: token identity, Pons metadata, 10 launch tweets + 5 viral hooks + 5 thread ideas + 20 raid replies + 5 DM templates + founder/product/discord/community announcements + raid mission + FAQ + 7-day plan + checklist. | `/launch` (wizard step 0–2) |
| **04 Launch** | Direct Pons execution on Robinhood Chain. Real mainnet, real wallet signature. HAMR.fun never holds keys. | `/launch` (wizard step 3–5) |
| **05 Monitor** | Post-launch dashboard: pool price, graduation progress, deployer, and Blockscout links, all polled from the Pons factory + locker. | `/launches/[address]` |

## Live integrations

| Surface | Real target | Status |
|---|---|---|
| `/api/meme-radar` | xAI/Grok trends + X API + on-chain indexers | Mock feed (4 memes) |
| `/api/meme-analyze` | Grok analysis from radar meme | **Wired** (mock fallback) |
| `/api/generate-launch-kit` | xAI Grok (primary) → Anthropic / OpenAI fallback | **Wired** |
| Launch execution | Client-side viem call to Pons factory (non-custodial, user signs) | **Wired** — ABI verification pending |
| `/api/x-post-generator` | Grok content generation | **Wired** |
| Token monitor | `lib/pons/read` + `lib/pons/indexer` against Robinhood Chain | **Wired** |
| `/api/monitor-actions` | Grok next-actions advisor | **Wired** (mock fallback) |
| Wallet adapter | RainbowKit — MetaMask, Rainbow, Coinbase, Robinhood Wallet (via WalletConnect) | **Wired** |
| Launch history | localStorage (per browser) | **Wired** (Supabase next) |

## Safety model

```
Agent prepares  →  User approves  →  Wallet signs  →  Launch executes
```

- No private key storage.
- No seed phrase prompts.
- No silent fund movement.
- No partnership claims with xAI, X, Grok, Pons, Robinhood, or Uniswap.
- Every on-chain action requires an explicit user wallet signature.

## Pages

| Route | What |
|---|---|
| `/` | Landing — Hero + 5-phase loop + 4 engines + safety + final CTA |
| `/dashboard` | Command Center — Real-time Meme Radar (Phase 01) + agent loop sections |
| `/analyze?meme=<id>` | Launch readiness analysis (Phase 02) — 10 criteria + best angle + risks |
| `/launch` | Launch wizard (Phase 03 + 04) — Concept → Generate → Review → Wallet → Sign → Launched |
| `/launches` | Your launched tokens |
| `/launches/[mint]` | Post-launch monitor (Phase 05) — supply, holders, suggested actions |
| `/settings` | Profile placeholder |

## Phases of development

```
Phase 1 — Full Web App MVP                         (this repo, today)
Phase 2 — GitHub open-source polish + docs         (this repo, ongoing)
Phase 3 — Telegram Bot integration                 (separate workstream)
```

See [ROADMAP.md](./ROADMAP.md) for the public roadmap and [ARCHITECTURE.md](./ARCHITECTURE.md) for the agent + module layout.

## Tech stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS (custom dark theme, Coinbase-grade typography)
- `@solana/web3.js` + wallet-adapter (Phantom / Solflare)
- Pump.fun IPFS + PumpPortal `trade-local`
- Lucide icons
- Vercel-ready

## Getting started

This repository is being brought up in a **test-first, non-custodial** workflow. Do not deploy contracts, launch tokens, or submit mainnet transactions during setup.

```bash
npm ci
cp .env.example .env.local
npm run type-check
npm run build
npm run dev
```

Configure provider keys only in your local `.env.local` or the deployment provider's encrypted environment settings. Never commit local environment files. The application can use its mock fallback when no model key is configured.

### Release gate

Before any live-chain action, verify the active launch adapter, chain ID, contract/program addresses, ABI/IDL, fee accounting, wallet transaction contents, and monitoring against the implementation and tests. The repository currently contains conflicting EVM/Robinhood Chain and Solana/Pump.fun documentation; treat launch execution as **unverified** until that mismatch is resolved. Mainnet remains disabled for this setup.

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — modules, data flow, where to plug new providers.
- [ROADMAP.md](./ROADMAP.md) — Phase 1/2/3 plan + per-phase checklists.
- [LAUNCH.md](./LAUNCH.md) — launch-day runbook.
- [SECURITY.md](./SECURITY.md) — vulnerability reporting + safety rules.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — module conventions and PR rules.
