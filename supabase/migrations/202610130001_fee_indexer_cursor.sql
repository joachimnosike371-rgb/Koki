-- Persistent cursor and block provenance for the verified on-chain fee indexer.
alter table public.agent_fee_ledger
  add column if not exists block_number bigint;

create index if not exists agent_fee_ledger_block_idx
  on public.agent_fee_ledger(chain, block_number);

create table if not exists public.agent_indexer_cursors (
  name text primary key,
  last_scanned_block bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.agent_indexer_cursors enable row level security;
