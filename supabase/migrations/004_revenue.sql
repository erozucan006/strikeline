-- Strikeline: the platform's own books. Run once in the Supabase SQL editor after 003.
--
-- revenue: one row per filled leg (opens, reductions and closes) with the exchange price, the
-- price the client got and the markup earned. Row level security is on and there is no policy,
-- so clients can never read it; only the service role (the Vercel functions) writes and reads it.

create table if not exists public.revenue (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete restrict,
  kind           text not null check (kind in ('open', 'close', 'reduce')),
  position_id    bigint,
  idempotency_key text not null,
  leg_no         smallint not null,
  underlying     text not null check (underlying in ('BTC', 'ETH')),
  instrument     text not null,
  client_side    smallint not null check (client_side in (-1, 1)),  -- +1 client bought, -1 client sold
  qty            numeric(14,4) not null check (qty > 0),
  index_price    numeric(14,2) not null,
  exchange_price numeric(14,4) not null,
  client_price   numeric(14,4) not null,
  markup         numeric(14,4) not null,  -- USD earned on this leg: |client − exchange| × qty
  exchange_fee   numeric(14,4) not null,  -- estimated hedge fee at Deribit
  unique (idempotency_key, leg_no)
);
create index if not exists revenue_created on public.revenue (created_at desc);
alter table public.revenue enable row level security;
revoke all on public.revenue from public, anon, authenticated;
grant select, insert on public.revenue to service_role;

-- The books are append-only like orders.
drop trigger if exists revenue_append_only on public.revenue;
create trigger revenue_append_only before update or delete on public.revenue
  for each row execute function public._orders_append_only();

-- Records the legs of one fill. The same idempotency key twice is ignored, so a replayed order is
-- never counted twice.
create or replace function public.record_revenue(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into revenue (user_id, kind, position_id, idempotency_key, leg_no, underlying, instrument, client_side, qty,
                       index_price, exchange_price, client_price, markup, exchange_fee)
  select (r->>'user_id')::uuid, r->>'kind', nullif(r->>'position_id', '')::bigint, r->>'idempotency_key', (r->>'leg_no')::smallint,
         r->>'underlying', r->>'instrument', (r->>'client_side')::smallint, (r->>'qty')::numeric,
         (r->>'index_price')::numeric, (r->>'exchange_price')::numeric, (r->>'client_price')::numeric,
         (r->>'markup')::numeric, (r->>'exchange_fee')::numeric
    from jsonb_array_elements(p_rows) r
  on conflict (idempotency_key, leg_no) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Everything the admin page shows, in one call.
create or replace function public.admin_summary() returns jsonb
language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'today',  coalesce(sum(markup) filter (where created_at >= date_trunc('day', now())), 0),
        'week',   coalesce(sum(markup) filter (where created_at >= now() - interval '7 days'), 0),
        'all',    coalesce(sum(markup), 0),
        'fees',   coalesce(sum(exchange_fee), 0),
        'fills',  count(*),
        'volume', coalesce(sum(client_price * qty), 0),
        'clients', count(distinct user_id))
      from revenue),
    'daily', (select coalesce(jsonb_agg(d order by d.day), '[]') from (
        select date_trunc('day', created_at)::date as day, round(sum(markup), 2) as markup, round(sum(exchange_fee), 2) as fees, count(*) as fills
          from revenue where created_at >= now() - interval '30 days' group by 1) d),
    'by_instrument', (select coalesce(jsonb_agg(i order by i.markup desc), '[]') from (
        select instrument, round(sum(markup), 2) as markup, count(*) as fills, round(sum(qty), 4) as qty
          from revenue group by instrument order by sum(markup) desc limit 12) i),
    'recent', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select created_at, kind, instrument, client_side, qty, exchange_price, client_price, round(markup, 2) as markup
          from revenue order by created_at desc limit 25) x),
    -- What clients hold right now, summed across all accounts: the platform holds the opposite.
    'exposure', (select coalesce(jsonb_agg(z order by z.underlying, z.t, z.k, z.type), '[]') from (
        select p.underlying, l->>'e' as e, (l->>'t')::bigint as t, (l->>'K')::numeric as k, l->>'type' as type,
               round(sum((l->>'side')::int * (l->>'qty')::numeric), 4) as client_net, count(distinct p.user_id) as clients
          from positions p, jsonb_array_elements(p.legs) l
         where p.closed_at is null and (l->>'t')::bigint > (extract(epoch from now()) * 1000)::bigint
         group by 1, 2, 3, 4, 5
        having abs(sum((l->>'side')::int * (l->>'qty')::numeric)) > 0) z)
  );
$$;

revoke execute on function public.record_revenue(jsonb) from public, anon, authenticated;
revoke execute on function public.admin_summary() from public, anon, authenticated;
grant execute on function public.record_revenue(jsonb) to service_role;
grant execute on function public.admin_summary() to service_role;
