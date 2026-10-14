-- =====================================================================
-- SỔ CHI TIÊU – cấu trúc dữ liệu cho Supabase (Postgres)
-- Cách chạy: Supabase → SQL Editor → New query → dán toàn bộ file này → Run.
-- Chạy lại nhiều lần vẫn an toàn (không mất dữ liệu).
-- =====================================================================

-- 1) Cài đặt của từng người dùng ----------------------------------------
create table if not exists public.settings (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  cycle_day     int  not null default 1 check (cycle_day between 1 and 31), -- kỳ mới bắt đầu vào ngày này hằng tháng
  auto_rollover boolean not null default true,                              -- tự chuyển sang kỳ mới khi hết kỳ
  timezone      text not null default 'Asia/Ho_Chi_Minh',
  created_at    timestamptz not null default now()
);

-- 2) Kỳ chi tiêu (mỗi kỳ tối đa 31 ngày) ---------------------------------
create table if not exists public.periods (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  budget     bigint not null default 0 check (budget >= 0),
  created_at timestamptz not null default now(),
  constraint periods_range_ok check (end_date >= start_date and end_date - start_date <= 30),
  constraint periods_unique_start unique (user_id, start_date)
);
create index if not exists periods_user_start_idx on public.periods (user_id, start_date desc);

-- 3) Khoản chi: mỗi khoản một dòng ---------------------------------------
create table if not exists public.expenses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  spent_on   date not null,
  amount     bigint not null check (amount >= 0),
  note       text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists expenses_user_day_idx on public.expenses (user_id, spent_on);

-- 4) Đánh dấu "đã qua" cho từng ngày --------------------------------------
create table if not exists public.day_marks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day     date not null,
  passed  boolean not null default true,
  primary key (user_id, day)
);

-- 5) Bảo mật: mỗi người chỉ thấy và sửa dữ liệu của chính mình (RLS) --------
alter table public.settings  enable row level security;
alter table public.periods   enable row level security;
alter table public.expenses  enable row level security;
alter table public.day_marks enable row level security;

drop policy if exists "settings: chủ sở hữu"  on public.settings;
drop policy if exists "periods: chủ sở hữu"   on public.periods;
drop policy if exists "expenses: chủ sở hữu"  on public.expenses;
drop policy if exists "day_marks: chủ sở hữu" on public.day_marks;

create policy "settings: chủ sở hữu"  on public.settings  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "periods: chủ sở hữu"   on public.periods   for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "expenses: chủ sở hữu"  on public.expenses  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "day_marks: chủ sở hữu" on public.day_marks for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Người chưa đăng nhập (anon) không được đụng vào bảng nào
revoke all on public.settings, public.periods, public.expenses, public.day_marks from anon;
grant select, insert, update, delete
  on public.settings, public.periods, public.expenses, public.day_marks to authenticated;

-- 6) Tính ngày cuối của một kỳ -------------------------------------------
-- Kỳ bắt đầu ở p_start sẽ kết thúc ngay trước ngày "bắt đầu kỳ" kế tiếp (p_cd = ngày bắt đầu kỳ hằng tháng, 1–31).
-- Ví dụ p_cd = 1: kỳ chạy từ 1 đến cuối tháng. p_cd = 15: kỳ chạy từ 15 đến 14 tháng sau. Tối đa 31 ngày.
create or replace function public.period_end(p_start date, p_cd int)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  m0 date := date_trunc('month', p_start)::date;
  c  date;
  e  date;
begin
  c := m0 + (least(p_cd, extract(day from (m0 + interval '1 month' - interval '1 day'))::int) - 1);
  if c <= p_start then
    m0 := (m0 + interval '1 month')::date;
    c  := m0 + (least(p_cd, extract(day from (m0 + interval '1 month' - interval '1 day'))::int) - 1);
  end if;
  e := c - 1;
  if e - p_start + 1 > 31 then
    e := p_start + 30;
  end if;
  return e;
end;
$$;

-- 7) Tự chuyển kỳ -----------------------------------------------------------
-- App gọi hàm này mỗi lần mở. Nếu hôm nay đã qua ngày kết thúc kỳ mới nhất và bật tự chuyển kỳ,
-- hàm tạo kỳ mới liền kề (giữ nguyên ngân sách cũ để bạn tự sửa), rồi trả về kỳ mới nhất.
-- Nếu bạn bỏ không dùng nhiều tháng, hàm nhảy thẳng tới kỳ chứa ngày hôm nay (không tạo kỳ rỗng ở giữa).
create or replace function public.ensure_current_period()
returns setof public.periods
language plpgsql
security invoker
set search_path = public
as $$
declare
  s     public.settings;
  p     public.periods;
  today date;
  ns    date;
  ne    date;
  n     int := 0;
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập';
  end if;

  insert into public.settings (user_id) values (auth.uid()) on conflict do nothing;
  select * into s from public.settings where user_id = auth.uid();
  today := (now() at time zone s.timezone)::date;

  select * into p from public.periods where user_id = auth.uid() order by start_date desc limit 1;

  if found and s.auto_rollover and today > p.end_date then
    ns := p.end_date + 1;
    ne := public.period_end(ns, s.cycle_day);
    while ne < today and n < 60 loop
      ns := ne + 1;
      ne := public.period_end(ns, s.cycle_day);
      n  := n + 1;
    end loop;
    insert into public.periods (user_id, start_date, end_date, budget)
      values (auth.uid(), ns, ne, p.budget)
      on conflict (user_id, start_date) do nothing;
  end if;

  return query
    select * from public.periods where user_id = auth.uid() order by start_date desc limit 1;
end;
$$;

revoke all on function public.ensure_current_period() from public, anon;
grant execute on function public.ensure_current_period() to authenticated;
revoke all on function public.period_end(date, int) from public, anon;
grant execute on function public.period_end(date, int) to authenticated;
