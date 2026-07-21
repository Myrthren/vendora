-- Whop integration — run once in the Supabase SQL editor.
--
-- Whop runs ALONGSIDE PayPal as an alternative way to buy a Vendora plan.
-- Entitlement still lives in profiles.tier / profiles.subscription_status —
-- Whop is just a second writer to that row, exactly like PayPal is.
--
-- profiles.subscription_source records WHICH provider owns the current tier.
-- This is what stops a Whop cancellation from wiping a PayPal subscriber's
-- access (and vice versa). Existing PayPal rows have it NULL, which is
-- deliberately treated as "not Whop" by the webhook.

alter table profiles add column if not exists subscription_source text;
alter table profiles add column if not exists whop_membership_id  text;

create index if not exists profiles_whop_membership_id_idx
  on profiles (whop_membership_id);

-- Ledger of every membership Whop has told us about.
-- Written on EVERY webhook, before we know who the buyer is. Identity is
-- resolved separately (checkout metadata, or the /claim flow) — so a purchase
-- is never lost just because we couldn't match it to a Discord account yet.
create table if not exists whop_memberships (
  membership_id  text primary key,
  whop_user_id   text,
  whop_email     text,
  plan_id        text,
  product_id     text,
  status         text,
  tier           text,          -- basic | pro | elite, mapped from plan_id
  discord_id     text,          -- null until the buyer is identified
  claim_code     text unique,   -- short code the buyer enters on /claim
  claimed_at     timestamptz,
  raw            jsonb,         -- full payload, for debugging unmapped plans
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists whop_memberships_discord_id_idx  on whop_memberships (discord_id);
create index if not exists whop_memberships_claim_code_idx  on whop_memberships (claim_code);
create index if not exists whop_memberships_unclaimed_idx
  on whop_memberships (created_at desc) where discord_id is null;

-- The backend uses the Supabase SERVICE key, which bypasses RLS. RLS here is
-- belt-and-braces: no anon/authenticated client should ever read this table
-- directly, since claim_code is effectively a bearer token for a paid plan.
alter table whop_memberships enable row level security;
