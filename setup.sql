-- IWC Team dashboard: database setup.
-- Run once in Supabase → SQL editor on the production project. Safe to run again (it replaces what it made).
--
-- What it adds (all names start with team_, nothing of the website's is changed):
--   team_members      who can open the dashboard (email → name)
--   team_tasks        each member's task list
--   team_is_member()  true when the signed-in user is one of team_members (with a confirmed email)
--   team_analytics()  every number the analytics section shows, computed here so the page downloads a few KB
--
-- The website never reads these. The dashboard only reads the website's tables (orders, order_items, products)
-- through team_analytics(), and never writes to them.

-- ---------------------------------------------------------------------------
-- 1. Members
-- ---------------------------------------------------------------------------
create table if not exists public.team_members (
  name text primary key,
  email text not null unique check (email = lower(email)),
  sort smallint not null default 0
);

-- Put each member's sign-in email here (lower case). Edit and run the whole file again to change them.
insert into public.team_members (name, email, sort) values
  ('Yogesh',    'ykadyan@iwc.com',    1),
  ('Jollwin',   'jgonsalves@iwc.com',   2),
  ('Pritishma', 'ppradhanang@iwc.com', 3),
  ('Sahil',     'sahil@iwc.com',     4)
on conflict (name) do update set email = excluded.email, sort = excluded.sort;

create or replace function public.team_is_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from auth.users u
    join public.team_members m on m.email = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;

create or replace function public.team_me() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.name
  from auth.users u
  join public.team_members m on m.email = lower(u.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tasks
-- ---------------------------------------------------------------------------
create table if not exists public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  member text not null references public.team_members (name) on update cascade on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 300),
  done boolean not null default false,
  due_on date,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists team_tasks_member_idx on public.team_tasks (member, done);

create or replace function public.team_tasks_stamp() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := public.team_me();
    new.done_at := case when new.done then now() end;
  elsif new.done is distinct from old.done then
    new.done_at := case when new.done then now() end;
  else
    new.done_at := old.done_at;
  end if;
  return new;
end $$;

drop trigger if exists team_tasks_stamp on public.team_tasks;
create trigger team_tasks_stamp before insert or update on public.team_tasks
  for each row execute function public.team_tasks_stamp();

-- ---------------------------------------------------------------------------
-- 3. Access: members only (every member can edit every list), nobody else, not even signed-in customers
-- ---------------------------------------------------------------------------
alter table public.team_members enable row level security;
alter table public.team_tasks enable row level security;

drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members for select to authenticated using (public.team_is_member());

drop policy if exists team_tasks_all on public.team_tasks;
create policy team_tasks_all on public.team_tasks for all to authenticated
  using (public.team_is_member()) with check (public.team_is_member());

revoke all on public.team_members, public.team_tasks from anon, authenticated;
grant select on public.team_members to authenticated;
grant select, insert, update, delete on public.team_tasks to authenticated;

revoke all on function public.team_is_member(), public.team_me() from public, anon;
grant execute on function public.team_is_member(), public.team_me() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Analytics
-- "Sold" means what the website's own admin counts (admin_sales): active lines of paid orders, not cancelled or
-- refunded. Sales are the goods' prices (before shipping, tax and discounts). Days are counted in p_tz.
-- ---------------------------------------------------------------------------
create or replace function public.team_analytics(p_days integer default 30, p_tz text default 'Asia/Kolkata')
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  v_tz text := coalesce(p_tz, 'Asia/Kolkata');
  v_today date;
  v_from timestamptz;   -- start of the period (midnight in v_tz, v_days - 1 days ago)
  v_prev timestamptz;   -- start of the period before it
  v_result jsonb;
begin
  if not public.team_is_member() then
    raise exception 'team_only' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;
  v_today := (now() at time zone v_tz)::date;
  v_from := ((v_today - (v_days - 1))::timestamp) at time zone v_tz;
  v_prev := ((v_today - (2 * v_days - 1))::timestamp) at time zone v_tz;

  with paid as (
    select o.id, o.email, o.created_at, o.status, o.est_delivery_to
    from public.orders o
    where o.payment_status in ('paid', 'partially_refunded')
      and o.status not in ('pending_payment', 'cancelled', 'refunded')
  ),
  lines as (
    select p.id as order_id, p.email, p.created_at, oi.quantity, oi.total_price_cents,
           coalesce(oi.region_name, 'All India') as region_name,
           coalesce(pr.name, oi.product_name) as product_name,
           coalesce(pr.product_type::text, 'other') as product_type
    from paid p
    join public.order_items oi on oi.order_id = p.id and oi.status = 'active'
    left join public.products pr on pr.id = oi.product_id
    where p.created_at >= v_prev
  ),
  cur as (select * from lines where created_at >= v_from),
  prv as (select * from lines where created_at < v_from),
  first_order as (
    select email, min(created_at) as first_at from paid group by email
  ),
  days as (
    select d::date as day from generate_series(v_today - (v_days - 1), v_today, interval '1 day') d
  )
  select jsonb_build_object(
    'days', v_days,
    'tz', v_tz,
    'from', (v_today - (v_days - 1)),
    'to', v_today,
    'generated_at', now(),
    'now', (select jsonb_build_object(
        'sales_cents', coalesce(sum(total_price_cents), 0),
        'orders', count(distinct order_id),
        'pieces', coalesce(sum(quantity), 0),
        'customers', count(distinct email),
        'new_customers', (select count(*) from first_order f where f.first_at >= v_from)
      ) from cur),
    'before', (select jsonb_build_object(
        'sales_cents', coalesce(sum(total_price_cents), 0),
        'orders', count(distinct order_id),
        'pieces', coalesce(sum(quantity), 0),
        'customers', count(distinct email),
        'new_customers', (select count(*) from first_order f where f.first_at >= v_prev and f.first_at < v_from)
      ) from prv),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'sales_cents', coalesce(x.sales, 0),
                                                           'orders', coalesce(x.orders, 0)) order by d.day), '[]'::jsonb)
              from days d
              left join (select (created_at at time zone v_tz)::date as day, sum(total_price_cents) as sales,
                                count(distinct order_id) as orders
                         from cur group by 1) x on x.day = d.day),
    'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', product_type, 'sales_cents', sales, 'pieces', pieces)
                                          order by sales desc), '[]'::jsonb)
                from (select product_type, sum(total_price_cents) as sales, sum(quantity) as pieces
                      from cur group by product_type) g),
    'top_regions', (select coalesce(jsonb_agg(jsonb_build_object('name', region_name, 'sales_cents', sales, 'orders', orders)
                                              order by sales desc, region_name), '[]'::jsonb)
                    from (select region_name, sum(total_price_cents) as sales, count(distinct order_id) as orders
                          from cur group by region_name order by sum(total_price_cents) desc, region_name limit 5) g),
    'top_products', (select coalesce(jsonb_agg(jsonb_build_object('name', product_name, 'pieces', pieces, 'sales_cents', sales)
                                               order by pieces desc, sales desc), '[]'::jsonb)
                     from (select product_name, sum(quantity) as pieces, sum(total_price_cents) as sales
                           from cur group by product_name order by sum(quantity) desc, sum(total_price_cents) desc limit 5) g),
    -- Where every open order stands right now (not limited to the period), and how many are past their window.
    'pipeline', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'orders', n) order by ord), '[]'::jsonb)
                 from (select status::text as status, count(*) as n,
                              array_position(array['confirmed','collecting','packed','in_transit','arrived','shipped'],
                                             status::text) as ord
                       from paid where status not in ('delivered') group by status) g),
    'late', (select count(*) from paid
             where status not in ('delivered') and est_delivery_to is not null and est_delivery_to < v_today),
    'catalogue', (select jsonb_build_object(
        'live', count(*) filter (where status = 'live'),
        'drafts', count(*) filter (where status = 'draft'),
        'live_by_type', (select coalesce(jsonb_object_agg(t, n), '{}'::jsonb)
                         from (select product_type::text as t, count(*) as n from public.products
                               where status = 'live' and not is_placeholder group by 1) g),
        'listed_in_period', count(*) filter (where status = 'live' and published_at >= v_from)
      ) from public.products where not is_placeholder)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.team_analytics(integer, text) from public, anon;
grant execute on function public.team_analytics(integer, text) to authenticated;

-- Let the API see the new tables and functions straight away.
notify pgrst, 'reload schema';
