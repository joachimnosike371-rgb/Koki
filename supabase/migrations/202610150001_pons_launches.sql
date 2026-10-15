-- Ensure the live market board's launch-enrichment table exists.
-- Safe to apply repeatedly; existing rows and columns are preserved.
create table if not exists public.pons_launches (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  token_address text not null unique,
  pool_address text,
  ticker text not null,
  token_name text not null,
  chain text not null default 'robinhood',
  status text not null default 'launched',
  tx_hash text,
  pons_url text,
  explorer_url text,
  logo_url text,
  initial_buy_eth numeric,
  mock boolean not null default false,
  source_x_url text,
  created_at timestamptz not null default now()
);

create index if not exists pons_launches_wallet_idx
  on public.pons_launches (wallet_address);
create index if not exists pons_launches_created_idx
  on public.pons_launches (created_at desc);
create index if not exists pons_launches_source_x_url_idx
  on public.pons_launches (source_x_url)
  where source_x_url is not null;

grant all on table public.pons_launches to service_role;

notify pgrst, 'reload schema';
