-- Koki autonomous agent ledger. Server writes only through Supabase service role.
create table if not exists public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  target_asset text not null default 'ETH',
  target_net_revenue numeric(30, 18) not null default 1,
  duration_hours integer not null default 18,
  status text not null default 'monitoring' check (status in ('monitoring','target_reached','stopped','expired','error')),
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null default (now() + interval '18 hours'),
  starting_capital numeric(30, 18) not null default 0,
  verified_fee_revenue numeric(30, 18) not null default 0,
  verified_costs numeric(30, 18) not null default 0,
  net_revenue numeric(30, 18) not null default 0,
  last_cycle_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_sessions_status_deadline_idx on public.agent_sessions(status, deadline_at desc);

create table if not exists public.agent_cycles (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.agent_sessions(id) on delete set null,
  status text not null default 'completed',
  provider text,
  model text,
  market_count integer not null default 0,
  selected_token_address text,
  selected_ticker text,
  selected_volume_24h numeric(30, 18),
  payload jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists agent_cycles_started_idx on public.agent_cycles(started_at desc);
create index if not exists agent_cycles_session_idx on public.agent_cycles(session_id, started_at desc);

create table if not exists public.agent_fee_ledger (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.agent_sessions(id) on delete set null,
  chain text not null,
  asset text not null,
  amount numeric(78, 30) not null,
  fee_kind text not null check (fee_kind in ('trade_fee','protocol_fee','creator_fee','launch_fee','gas_cost','infrastructure_cost','other')),
  tx_hash text,
  log_index integer,
  token_address text,
  source text not null default 'chain_indexer',
  verified boolean not null default false,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(chain, tx_hash, log_index, fee_kind)
);
create index if not exists agent_fee_ledger_session_idx on public.agent_fee_ledger(session_id, occurred_at desc);
create index if not exists agent_fee_ledger_verified_idx on public.agent_fee_ledger(verified, occurred_at desc);

create table if not exists public.agent_market_observations (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.agent_cycles(id) on delete cascade,
  chain text not null,
  token_address text not null,
  ticker text,
  token_name text,
  volume_24h numeric(30, 18) not null default 0,
  market_cap numeric(30, 18),
  progress_bps integer,
  graduated boolean not null default false,
  score numeric(18, 8) not null default 0,
  observed_at timestamptz not null default now(),
  unique(cycle_id, chain, token_address)
);
create index if not exists agent_market_observations_token_idx on public.agent_market_observations(chain, token_address, observed_at desc);

-- Private ledger: RLS enabled; only service-role server code should write/read.
alter table public.agent_sessions enable row level security;
alter table public.agent_cycles enable row level security;
alter table public.agent_fee_ledger enable row level security;
alter table public.agent_market_observations enable row level security;
