# Setup and release runbook

## Current release status

**Test and audit only. Do not use this document to launch a mainnet token.** The repository's documentation currently describes incompatible EVM/Robinhood Chain and Solana/Pump.fun launch paths. Confirm the actual adapter and contract/program implementation before selecting a chain or deploying.

## 1. Prepare the app

Requires Node.js 20 or newer.

```bash
npm ci
cp .env.example .env.local
npm run type-check
npm run build
npm run dev
```

Provider credentials belong in an untracked local `.env.local` or encrypted deployment environment variables. Never paste credentials into chat, source code, commits, logs, or client-visible `NEXT_PUBLIC_*` variables unless the value is explicitly public.

## 2. Validate without transactions

- Open the app and exercise dashboard, narrative analysis, launch-kit generation, settings, and monitoring.
- Confirm mock/fallback state is labelled honestly and no UI implies live X data, volume, or chain state when mocked.
- Inspect every launch request and wallet transaction before connecting a funded wallet.
- Run type-check and production build; add automated tests for chain selection, fee calculations, failure paths, and transaction construction.

## 3. Testnet gate

No live transaction until all of these are true:

- One launch chain/protocol is selected and the UI, adapters, env vars, docs, and tests agree.
- Contract/program addresses and ABI/IDL are verified against source and chain explorers.
- Any fee logic is tested for rounding, recipient, caps, revert behavior, and accounting; no 0.5% fee claim without verified implementation.
- Wallet signatures are explicit per transaction; no private keys or seed phrases are collected or stored.
- Kill/rotate controls fail closed and are tested under stale, missing, and manipulated volume data.
- CI passes type-check, build, unit tests, and integration tests.
- A testnet deployment and test transactions are reviewed in an explorer.

## 4. Mainnet release

Mainnet is a separate release decision and is not authorized by setup or testnet success. Require an explicit approval for the specific chain, contract addresses, fee recipients, and transaction. Never enable autonomous signing or move user funds without their explicit wallet approval.
