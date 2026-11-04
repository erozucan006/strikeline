-- Strikeline: close part of an open position.
-- Run once in the Supabase SQL editor after 001_accounts.sql.

alter table public.orders drop constraint if exists orders_kind_check;
alter table public.orders add constraint orders_kind_check check (kind in ('open','close','reduce','reset'));

-- Closes p_fraction (0 < f < 1) of every leg at the client's mark p_value (value of the closed part).
-- Fees on the remaining part shrink in the same ratio so its P&L stays right.
create or replace function public.reduce_position(p_id bigint, p_fraction numeric, p_value numeric)
returns public.positions
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); pos public.positions; cap numeric; remaining jsonb; closed jsonb;
begin
  if p_fraction is null or p_fraction <= 0 or p_fraction >= 1 then raise exception 'invalid_fraction'; end if;
  select * into pos from positions where id = p_id and user_id = u and closed_at is null for update;
  if pos.id is null then raise exception 'position_not_open'; end if;

  select sum((l->>'qty')::numeric * (l->>'K')::numeric * 3) into cap from jsonb_array_elements(pos.legs) l;
  if abs(p_value) > cap * p_fraction then raise exception 'invalid_value'; end if;

  select jsonb_agg(l || jsonb_build_object('qty', round((l->>'qty')::numeric * (1 - p_fraction), 4)) order by o),
         jsonb_agg(l || jsonb_build_object('qty', round((l->>'qty')::numeric * p_fraction, 4)) order by o)
    into remaining, closed
    from jsonb_array_elements(pos.legs) with ordinality as e(l, o);
  if exists (select 1 from jsonb_array_elements(remaining) l where (l->>'qty')::numeric <= 0)
     or exists (select 1 from jsonb_array_elements(closed) l where (l->>'qty')::numeric <= 0) then
    raise exception 'invalid_fraction';
  end if;

  update positions set legs = remaining, fee = round(fee * (1 - p_fraction), 2) where id = p_id returning * into pos;
  update accounts set cash = cash + p_value where user_id = u;
  insert into orders (user_id, kind, position_id, strategy, net, legs)
  values (u, 'reduce', p_id, pos.name, round(-p_value, 2), closed);
  return pos;
end $$;

revoke execute on function public.reduce_position(bigint, numeric, numeric) from public, anon;
grant execute on function public.reduce_position(bigint, numeric, numeric) to authenticated;
