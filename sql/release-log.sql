-- Durable GitHub → Discord release digest. Apply once in Supabase before
-- enabling the webhook. This deliberately avoids the settings JSON blob.
create table if not exists public.release_log_batches (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  base_sha text,
  head_sha text not null,
  opened_at timestamptz not null default now(),
  window_closes_at timestamptz not null,
  status text not null check (status in ('open', 'published', 'reverted')),
  version text,
  correlation uuid not null unique,
  discord_channel_id text,
  discord_message_id text,
  published_at timestamptz,
  reverted_at timestamptz
);
create unique index if not exists release_log_one_open_batch_per_branch
  on public.release_log_batches (branch) where status = 'open';
create index if not exists release_log_due_batches
  on public.release_log_batches (status, window_closes_at);

create table if not exists public.release_log_commits (
  batch_id uuid not null references public.release_log_batches(id) on delete cascade,
  sha text not null,
  message text not null,
  committed_at timestamptz not null,
  author_name text,
  removed_at timestamptz,
  primary key (batch_id, sha)
);
create index if not exists release_log_active_commits
  on public.release_log_commits (batch_id) where removed_at is null;

create table if not exists public.release_log_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists release_log_expired_deliveries
  on public.release_log_deliveries (expires_at);

create table if not exists public.release_log_outbox (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references public.release_log_batches(id) on delete cascade,
  operation text not null check (operation = 'publish'),
  state text not null check (state in ('pending', 'sending', 'sent')),
  correlation uuid not null unique,
  attempted_at timestamptz,
  sent_at timestamptz,
  discord_message_id text
);

-- The service-role backend accesses these tables. Keep browser roles out.
alter table public.release_log_batches enable row level security;
alter table public.release_log_commits enable row level security;
alter table public.release_log_deliveries enable row level security;
alter table public.release_log_outbox enable row level security;

