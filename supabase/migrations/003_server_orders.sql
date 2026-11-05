-- Strikeline: server-priced orders, duplicate protection and append-only records.
-- Run once in the Supabase SQL editor after 001 and 002.
--
-- After this migration a browser can no longer place, close or reduce positions itself. Those
-- functions are callable only by the service role, i.e. the Vercel functions /api/order and
-- /api/close, which price every leg from a fresh Deribit ticker. The browser keeps read access
-- to its own rows and its knowledge-check functions.

-- ---------------------------------------------------------------- orders: duplicates and quote time
alter table public.orders add column if not exists idempotency_key text;
alter table public.orders add column if not exists quote_ts timestamptz;
create unique index if not exists orders_idempotency on public.orders (user_id, idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------- retention (MiFID II: keep records)
-- Deleting a sign-in account must not delete its knowledge checks or orders. Such a deletion is now
-- refused and has to go through a manual process that keeps the records (pseudonymised if needed).
alter table public.assessments drop constraint if exists assessments_user_id_fkey;
alter table public.assessments add constraint assessments_user_id_fkey foreign key (user_id) references auth.users(id) on delete restrict;
alter table public.orders drop constraint if exists orders_user_id_fkey;
alter table public.orders add constraint orders_user_id_fkey foreign key (user_id) references auth.users(id) on delete restrict;
alter table public.orders drop constraint if exists orders_position_id_fkey;
alter table public.orders add constraint orders_position_id_fkey foreign key (position_id) references public.positions(id) on delete restrict;

-- Orders are never changed or deleted once written.
create or replace function public._orders_append_only() returns trigger
language plpgsql as $$ begin raise exception 'records_are_append_only'; end $$;
drop trigger if exists orders_append_only on public.orders;
create trigger orders_append_only before update or delete on public.orders
  for each row execute function public._orders_append_only();

-- A knowledge check is never changed or deleted, except that its warning may be accepted once.
create or replace function public._assessments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'records_are_append_only'; end if;
  if old.warned_ack_at is not null
     or (new.id, new.user_id, new.created_at, new.expires_at, new.version, new.experience, new.answers, new.score, new.level)
        is distinct from
        (old.id, old.user_id, old.created_at, old.expires_at, old.version, old.experience, old.answers, old.score, old.level)
  then raise exception 'records_are_append_only'; end if;
  return new;
end $$;
drop trigger if exists assessments_guard on public.assessments;
create trigger assessments_guard before update or delete on public.assessments
  for each row execute function public._assessments_guard();

-- ---------------------------------------------------------------- shared checks
create or replace function public._check_quote(p_quote_ts timestamptz) returns void
language plpgsql as $$
begin
  if p_quote_ts is null or p_quote_ts < now() - interval '30 seconds' or p_quote_ts > now() + interval '5 seconds' then
    raise exception 'stale_quote';
  end if;
end $$;

create or replace function public._check_rate(u uuid) returns void
language plpgsql as $$
begin
  if (select count(*) from public.orders where user_id = u and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'rate_limited';
  end if;
end $$;

-- ---------------------------------------------------------------- service-only order functions
-- Same rules as place_order in 001 (level from the legs, fee and capital bounds, cash), with the
-- user passed in by the trusted server, a quote-time check, a rate limit and an idempotency key:
-- the same key twice returns the first result instead of a second order.
create or replace function public.place_order_v2(p_user uuid, p_name text, p_underlying text, p_legs jsonb,
  p_fee numeric, p_required numeric, p_idem text, p_quote_ts timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := p_user; eff record; need smallint; net numeric; gross numeric; cash_now numeric; pos public.positions; l jsonb; prev bigint;
begin
  if u is null or not exists (select 1 from auth.users where id = u) then raise exception 'not_signed_in'; end if;
  perform pg_advisory_xact_lock(hashtext('order:' || u::text));
  select position_id into prev from orders where user_id = u and idempotency_key = p_idem;
  if prev is not null then
    return jsonb_build_object('replayed', true, 'position', (select to_jsonb(p) - 'user_id' from positions p where id = prev),
                              'cash', (select cash from accounts where user_id = u));
  end if;
  perform _check_quote(p_quote_ts);
  perform _check_rate(u);

  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) not between 1 and 8 then raise exception 'invalid_legs'; end if;
  for l in select * from jsonb_array_elements(p_legs) loop
    if l->>'type' not in ('C','P') or (l->>'side')::int not in (-1, 1)
       or (l->>'qty')::numeric <= 0 or (l->>'qty')::numeric > 100
       or (l->>'K')::numeric <= 0 or (l->>'entry')::numeric < 0
       or (l->>'t')::bigint <= (extract(epoch from now()) * 1000)::bigint then
      raise exception 'invalid_legs' using detail = l::text;
    end if;
  end loop;

  select * into eff from _effective(u);
  if eff.assessment_id is null then raise exception 'assessment_required'; end if;
  need := required_level(p_legs);
  if eff.level < need then raise exception 'level_required' using detail = need::text; end if;

  select sum((x->>'side')::int * (x->>'qty')::numeric * (x->>'entry')::numeric),
         sum((x->>'qty')::numeric * (x->>'entry')::numeric)
    into net, gross from jsonb_array_elements(p_legs) x;
  if p_fee < 0 or p_fee > gross * 0.125 + 0.01 then raise exception 'invalid_fee'; end if;
  if p_required < greatest(net, 0) + p_fee - 0.01 then raise exception 'invalid_required'; end if;

  perform _ensure_account(u);
  select cash into cash_now from accounts where user_id = u for update;
  if cash_now < p_required then raise exception 'insufficient_cash' using detail = cash_now::text; end if;

  update accounts set cash = cash - net - p_fee where user_id = u;
  insert into positions (user_id, name, underlying, legs, fee)
  values (u, left(p_name, 40), p_underlying, p_legs, round(p_fee, 2)) returning * into pos;
  insert into orders (user_id, kind, position_id, assessment_id, strategy, level_required, after_warning, net, fee, legs, idempotency_key, quote_ts)
  values (u, 'open', pos.id, eff.assessment_id, left(p_name, 40), need, eff.after_warning, round(net, 2), round(p_fee, 2), p_legs, p_idem, p_quote_ts);
  return jsonb_build_object('replayed', false, 'position', to_jsonb(pos) - 'user_id', 'cash', (select cash from accounts where user_id = u));
end $$;

create or replace function public.close_position_v2(p_user uuid, p_id bigint, p_value numeric, p_idem text, p_quote_ts timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := p_user; pos public.positions; cap numeric;
begin
  perform pg_advisory_xact_lock(hashtext('order:' || u::text));
  if exists (select 1 from orders where user_id = u and idempotency_key = p_idem) then
    return jsonb_build_object('replayed', true, 'cash', (select cash from accounts where user_id = u));
  end if;
  perform _check_quote(p_quote_ts);
  perform _check_rate(u);
  select * into pos from positions where id = p_id and user_id = u and closed_at is null for update;
  if pos.id is null then raise exception 'position_not_open'; end if;
  select sum((l->>'qty')::numeric * (l->>'K')::numeric * 3) into cap from jsonb_array_elements(pos.legs) l;
  if abs(p_value) > cap then raise exception 'invalid_value'; end if;
  update positions set closed_at = now(), close_value = round(p_value, 2) where id = p_id returning * into pos;
  update accounts set cash = cash + p_value where user_id = u;
  insert into orders (user_id, kind, position_id, strategy, net, legs, idempotency_key, quote_ts)
  values (u, 'close', p_id, pos.name, round(-p_value, 2), pos.legs, p_idem, p_quote_ts);
  return jsonb_build_object('replayed', false, 'cash', (select cash from accounts where user_id = u));
end $$;

create or replace function public.reduce_position_v2(p_user uuid, p_id bigint, p_fraction numeric, p_value numeric, p_idem text, p_quote_ts timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := p_user; pos public.positions; cap numeric; remaining jsonb; closed jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('order:' || u::text));
  if exists (select 1 from orders where user_id = u and idempotency_key = p_idem) then
    return jsonb_build_object('replayed', true, 'cash', (select cash from accounts where user_id = u));
  end if;
  perform _check_quote(p_quote_ts);
  perform _check_rate(u);
  if p_fraction is null or p_fraction <= 0 or p_fraction >= 1 then raise exception 'invalid_fraction'; end if;
  select * into pos from positions where id = p_id and user_id = u and closed_at is null for update;
  if pos.id is null then raise exception 'position_not_open'; end if;
  select sum((l->>'qty')::numeric * (l->>'K')::numeric * 3) into cap from jsonb_array_elements(pos.legs) l;
  if abs(p_value) > cap * p_fraction then raise exception 'invalid_value'; end if;
  select jsonb_agg(l || jsonb_build_object('qty', round((l->>'qty')::numeric * (1 - p_fraction), 4)) order by o),
         jsonb_agg(l || jsonb_build_object('qty', round((l->>'qty')::numeric * p_fraction, 4)) order by o)
    into remaining, closed from jsonb_array_elements(pos.legs) with ordinality as e(l, o);
  if exists (select 1 from jsonb_array_elements(remaining) l where (l->>'qty')::numeric <= 0)
     or exists (select 1 from jsonb_array_elements(closed) l where (l->>'qty')::numeric <= 0) then
    raise exception 'invalid_fraction';
  end if;
  update positions set legs = remaining, fee = round(fee * (1 - p_fraction), 2) where id = p_id returning * into pos;
  update accounts set cash = cash + p_value where user_id = u;
  insert into orders (user_id, kind, position_id, strategy, net, legs, idempotency_key, quote_ts)
  values (u, 'reduce', p_id, pos.name, round(-p_value, 2), closed, p_idem, p_quote_ts);
  return jsonb_build_object('replayed', false, 'cash', (select cash from accounts where user_id = u));
end $$;

-- ---------------------------------------------------------------- who may call what
-- Browsers lose the ability to book trades with their own prices.
revoke execute on function public.place_order(text, text, jsonb, numeric, numeric) from authenticated;
revoke execute on function public.close_position(bigint, numeric) from authenticated;
revoke execute on function public.reduce_position(bigint, numeric, numeric) from authenticated;

revoke execute on function public.place_order_v2(uuid, text, text, jsonb, numeric, numeric, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.close_position_v2(uuid, bigint, numeric, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.reduce_position_v2(uuid, bigint, numeric, numeric, text, timestamptz) from public, anon, authenticated;
grant execute on function public.place_order_v2(uuid, text, text, jsonb, numeric, numeric, text, timestamptz) to service_role;
grant execute on function public.close_position_v2(uuid, bigint, numeric, text, timestamptz) to service_role;
grant execute on function public.reduce_position_v2(uuid, bigint, numeric, numeric, text, timestamptz) to service_role;
grant select on public.positions to service_role;
