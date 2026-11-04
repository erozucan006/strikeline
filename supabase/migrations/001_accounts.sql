-- Strikeline: user accounts, appropriateness records and paper trading.
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Design:
--  * Clients can only SELECT their own rows (RLS). Every write goes through a SECURITY DEFINER
--    function below, so the browser can never set its own level, cash or assessment result.
--  * The knowledge check is scored here, with the answer key kept server-side.
--  * Assessments are append-only: the record of what the client answered and which warning
--    they saw is kept (MiFID II record-keeping). Only the warning acceptance time is ever set later.

-- ---------------------------------------------------------------- tables
create table if not exists public.assessments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 months',
  version       text not null,
  experience    jsonb not null,
  answers       jsonb not null,
  score         jsonb not null,
  level         smallint not null check (level between 0 and 3),
  warned_ack_at timestamptz
);
create index if not exists assessments_user_created on public.assessments (user_id, created_at desc);

create table if not exists public.accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  cash       numeric(14,2) not null default 10000,
  created_at timestamptz not null default now()
);

create table if not exists public.positions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  name        text not null,
  underlying  text not null check (underlying in ('BTC','ETH')),
  legs        jsonb not null,
  fee         numeric(14,2) not null default 0,
  close_value numeric(14,2)
);
create index if not exists positions_user_open on public.positions (user_id) where closed_at is null;

create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  kind           text not null check (kind in ('open','close','reset')),
  position_id    bigint references public.positions(id) on delete set null,
  assessment_id  uuid references public.assessments(id) on delete set null,
  strategy       text,
  level_required smallint,
  after_warning  boolean not null default false,
  net            numeric(14,2),
  fee            numeric(14,2),
  legs           jsonb
);
create index if not exists orders_user_created on public.orders (user_id, created_at desc);

-- ---------------------------------------------------------------- row level security
alter table public.assessments enable row level security;
alter table public.accounts    enable row level security;
alter table public.positions   enable row level security;
alter table public.orders      enable row level security;

drop policy if exists "own assessments" on public.assessments;
drop policy if exists "own account"     on public.accounts;
drop policy if exists "own positions"   on public.positions;
drop policy if exists "own orders"      on public.orders;
create policy "own assessments" on public.assessments for select to authenticated using (user_id = auth.uid());
create policy "own account"     on public.accounts    for select to authenticated using (user_id = auth.uid());
create policy "own positions"   on public.positions   for select to authenticated using (user_id = auth.uid());
create policy "own orders"      on public.orders      for select to authenticated using (user_id = auth.uid());

revoke all on public.assessments, public.accounts, public.positions, public.orders from anon, authenticated;
grant select on public.assessments, public.accounts, public.positions, public.orders to authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public._uid() returns uuid
language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public._ensure_account(u uuid) returns void
language sql as $$ insert into public.accounts (user_id) values (u) on conflict do nothing $$;

-- Latest unexpired assessment → effective level. Level 0 + accepted warning = level 1 (buy only).
create or replace function public._effective(u uuid)
returns table (assessment_id uuid, level smallint, after_warning boolean)
language sql stable as $$
  select a.id,
         case when a.level > 0 then a.level when a.warned_ack_at is not null then 1 else 0 end::smallint,
         (a.level = 0 and a.warned_ack_at is not null)
  from public.assessments a
  where a.user_id = u and a.expires_at > now()
  order by a.created_at desc
  limit 1
$$;

-- Same rule as the page: a sold option is covered when bought options of the same type, expiring
-- no earlier, match its size. No sold legs → 1, all covered → 2, otherwise 3.
create or replace function public.required_level(p_legs jsonb) returns smallint
language plpgsql immutable as $$
declare s jsonb; cover numeric; need numeric;
begin
  if not exists (select 1 from jsonb_array_elements(p_legs) l where (l->>'side')::int < 0) then return 1; end if;
  for s in select l from jsonb_array_elements(p_legs) l where (l->>'side')::int < 0 loop
    select coalesce(sum((l->>'qty')::numeric),0) into cover from jsonb_array_elements(p_legs) l
      where l->>'type' = s->>'type' and (l->>'side')::int > 0 and (l->>'t')::bigint >= (s->>'t')::bigint;
    select coalesce(sum((l->>'qty')::numeric),0) into need from jsonb_array_elements(p_legs) l
      where l->>'type' = s->>'type' and (l->>'side')::int < 0 and (l->>'t')::bigint <= (s->>'t')::bigint;
    if cover + 1e-9 < need then return 3; end if;
  end loop;
  return 2;
end $$;

-- ---------------------------------------------------------------- knowledge check
create or replace function public.submit_assessment(p_version text, p_experience jsonb, p_answers jsonb)
returns public.assessments
language plpgsql security definer set search_path = public as $$
declare
  u uuid := _uid();
  -- Answer key lives only here. Keep in sync with QS in index.html (question ids q1..q7).
  key constant jsonb := '{"q1":"a","q2":"a","q3":"a","q4":"a","q5":"a","q6":"a","q7":"a"}';
  allowed constant jsonb := '{"e1":["0","1-9","10-49","50+"],"e2":["<1","1-3","3+"],"e4":["<500","500-5k","5k+"],"e5":["no","study","work"]}';
  e3_allowed constant text[] := array['stocks','crypto','fx','options','futures','cfd','none'];
  k text; tries int; core int; spread bool; short bool; opt_exp bool; lvl smallint; rec public.assessments;
begin
  perform pg_advisory_xact_lock(hashtext('assess:' || u::text));
  select count(*) into tries from assessments where user_id = u and created_at > now() - interval '24 hours';
  if tries >= 3 then
    raise exception 'attempt_limit' using detail = (select (min(created_at) + interval '24 hours')::text
      from assessments where user_id = u and created_at > now() - interval '24 hours');
  end if;

  for k in select jsonb_object_keys(allowed) loop
    if not (allowed->k) ? coalesce(p_experience->>k, '') then raise exception 'invalid_experience' using detail = k; end if;
  end loop;
  if jsonb_typeof(p_experience->'e3') <> 'array' or jsonb_array_length(p_experience->'e3') = 0
     or exists (select 1 from jsonb_array_elements_text(p_experience->'e3') v where v <> all (e3_allowed)) then
    raise exception 'invalid_experience' using detail = 'e3';
  end if;
  for k in select jsonb_object_keys(key) loop
    if coalesce(p_answers->>k, '') not in ('a','b','c','d','dk') then raise exception 'invalid_answers' using detail = k; end if;
  end loop;

  select count(*) into core from unnest(array['q1','q2','q3','q4']) q where p_answers->>q = key->>q;
  spread  := p_answers->>'q5' = key->>'q5';
  short   := p_answers->>'q6' = key->>'q6' and p_answers->>'q7' = key->>'q7';
  opt_exp := p_experience->>'e1' in ('10-49','50+') or (p_experience->>'e1' = '1-9' and p_experience->>'e5' = 'work');
  lvl := case when core < 3 then 0 when not spread then 1 when not (short and opt_exp) then 2 else 3 end;

  perform _ensure_account(u);
  insert into assessments (user_id, version, experience, answers, score, level)
  values (u, left(p_version, 20), p_experience, (select jsonb_object_agg(k2, p_answers->k2) from jsonb_object_keys(key) k2),
          jsonb_build_object('core', core, 'spread', spread, 'short', short, 'optExp', opt_exp), lvl)
  returning * into rec;
  return rec;
end $$;

create or replace function public.accept_warning(p_id uuid) returns public.assessments
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); rec public.assessments;
begin
  update assessments set warned_ack_at = now()
   where id = p_id and user_id = u and level = 0 and warned_ack_at is null
     and id = (select assessment_id from _effective(u))
  returning * into rec;
  if rec.id is null then raise exception 'warning_not_open'; end if;
  return rec;
end $$;

-- ---------------------------------------------------------------- paper trading
-- Prices come from the client's live Deribit quote. Fine for paper trading; a real broker
-- integration must price and fill on the server.
create or replace function public.place_order(p_name text, p_underlying text, p_legs jsonb, p_fee numeric, p_required numeric)
returns public.positions
language plpgsql security definer set search_path = public as $$
declare
  u uuid := _uid(); eff record; need smallint; net numeric; gross numeric; cash_now numeric; pos public.positions; l jsonb;
begin
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
  insert into orders (user_id, kind, position_id, assessment_id, strategy, level_required, after_warning, net, fee, legs)
  values (u, 'open', pos.id, eff.assessment_id, left(p_name, 40), need, eff.after_warning, round(net, 2), round(p_fee, 2), p_legs);
  return pos;
end $$;

create or replace function public.close_position(p_id bigint, p_value numeric) returns public.positions
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); pos public.positions; cap numeric;
begin
  select * into pos from positions where id = p_id and user_id = u and closed_at is null for update;
  if pos.id is null then raise exception 'position_not_open'; end if;
  -- Sanity bound on the client's mark: no position can be worth more than its strikes allow.
  select sum((l->>'qty')::numeric * ((l->>'K')::numeric * 3)) into cap from jsonb_array_elements(pos.legs) l;
  if abs(p_value) > cap then raise exception 'invalid_value'; end if;
  update positions set closed_at = now(), close_value = round(p_value, 2) where id = p_id returning * into pos;
  update accounts set cash = cash + p_value where user_id = u;
  insert into orders (user_id, kind, position_id, strategy, net, legs) values (u, 'close', p_id, pos.name, round(-p_value, 2), pos.legs);
  return pos;
end $$;

create or replace function public.reset_account() returns public.accounts
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); acc public.accounts;
begin
  perform _ensure_account(u);
  update positions set closed_at = now(), close_value = null where user_id = u and closed_at is null;
  update accounts set cash = 10000 where user_id = u returning * into acc;
  insert into orders (user_id, kind) values (u, 'reset');
  return acc;
end $$;

-- One round trip on page load.
create or replace function public.my_state() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  perform _ensure_account(u);
  return jsonb_build_object(
    'cash',       (select cash from accounts where user_id = u),
    'assessment', (select to_jsonb(a) - 'user_id' from assessments a where user_id = u order by created_at desc limit 1),
    'tries24h',   (select coalesce(jsonb_agg(extract(epoch from created_at) * 1000), '[]') from assessments
                    where user_id = u and created_at > now() - interval '24 hours'),
    'orders',     (select count(*) from orders o where user_id = u and kind = 'open'
                    and assessment_id = (select id from assessments where user_id = u order by created_at desc limit 1)),
    'positions',  (select coalesce(jsonb_agg(to_jsonb(p) - 'user_id' order by opened_at desc), '[]') from positions p
                    where user_id = u and closed_at is null)
  );
end $$;

revoke execute on function public.submit_assessment(text, jsonb, jsonb), public.accept_warning(uuid),
  public.place_order(text, text, jsonb, numeric, numeric), public.close_position(bigint, numeric),
  public.reset_account(), public.my_state(), public._uid(), public._ensure_account(uuid), public._effective(uuid)
  from public, anon;
grant execute on function public.submit_assessment(text, jsonb, jsonb), public.accept_warning(uuid),
  public.place_order(text, text, jsonb, numeric, numeric), public.close_position(bigint, numeric),
  public.reset_account(), public.my_state(), public.required_level(jsonb) to authenticated;
