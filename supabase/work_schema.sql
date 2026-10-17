-- =====================================================================
-- MỤC "CÔNG VIỆC" – cấu trúc dữ liệu cho Supabase
-- Chạy SAU file schema.sql: SQL Editor → New query → dán toàn bộ file này → Run.
-- Chạy lại nhiều lần vẫn an toàn (không mất dữ liệu).
-- Gồm: ghi chú kỹ thuật (có ảnh), két mật khẩu (mã hóa), kho tài liệu, lịch năm.
-- =====================================================================

-- 1) Ghi chú kỹ thuật: linh kiện, chức năng, cách sửa, ảnh ----------------
create table if not exists public.tech_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  model        text not null default '' check (char_length(model) <= 200),
  tags         text[] not null default '{}',
  function_text text not null default '' check (char_length(function_text) <= 20000),
  repair_text  text not null default '' check (char_length(repair_text) <= 40000),
  images       jsonb not null default '[]',          -- [{p:"đường dẫn ảnh lớn", t:"đường dẫn ảnh nhỏ"}]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tech_notes_user_idx on public.tech_notes (user_id, updated_at desc);

-- 2) Két mật khẩu --------------------------------------------------------
-- Mật khẩu được MÃ HÓA NGAY TRÊN TRÌNH DUYỆT bằng "mật khẩu két" của bạn (AES-GCM).
-- Supabase chỉ lưu dữ liệu đã mã hóa nên chính chủ project cũng không đọc được.
create table if not exists public.vault_meta (
  user_id   uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  salt      text not null,
  iter      int  not null default 600000,
  check_iv  text not null,
  check_ct  text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.vault_items (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  location   text not null default '' check (char_length(location) <= 200),
  iv         text not null,
  ct         text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vault_items_user_idx on public.vault_items (user_id, name);

-- 3) Kho tài liệu ----------------------------------------------------------
create table if not exists public.documents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 300),
  category   text not null default 'Khác' check (char_length(category) <= 80),
  note       text not null default '' check (char_length(note) <= 2000),
  path       text not null,
  size       bigint not null default 0,
  mime       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists documents_user_idx on public.documents (user_id, created_at desc);

-- 4) Lịch năm: ghi chú theo ngày ---------------------------------------------
create table if not exists public.calendar_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,
  text       text not null check (char_length(text) between 1 and 1000),
  color      text not null default 'blue',
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists calendar_notes_user_day_idx on public.calendar_notes (user_id, day);

-- 5) Bảo mật: mỗi người chỉ thấy dữ liệu của chính mình (RLS) --------------------
alter table public.tech_notes     enable row level security;
alter table public.vault_meta     enable row level security;
alter table public.vault_items    enable row level security;
alter table public.documents      enable row level security;
alter table public.calendar_notes enable row level security;

drop policy if exists "tech_notes: chủ sở hữu"     on public.tech_notes;
drop policy if exists "vault_meta: chủ sở hữu"     on public.vault_meta;
drop policy if exists "vault_items: chủ sở hữu"    on public.vault_items;
drop policy if exists "documents: chủ sở hữu"      on public.documents;
drop policy if exists "calendar_notes: chủ sở hữu" on public.calendar_notes;

create policy "tech_notes: chủ sở hữu"     on public.tech_notes     for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "vault_meta: chủ sở hữu"     on public.vault_meta     for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "vault_items: chủ sở hữu"    on public.vault_items    for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "documents: chủ sở hữu"      on public.documents      for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "calendar_notes: chủ sở hữu" on public.calendar_notes for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.tech_notes, public.vault_meta, public.vault_items, public.documents, public.calendar_notes from anon;
grant select, insert, update, delete
  on public.tech_notes, public.vault_meta, public.vault_items, public.documents, public.calendar_notes to authenticated;

-- 6) Đổi mật khẩu két: cập nhật khóa và toàn bộ mục trong MỘT giao dịch ----------------
-- (tránh trường hợp đổi dở dang làm mất quyền mở két)
create or replace function public.vault_rekey(p_meta jsonb, p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_db  int;
  n_in  int := jsonb_array_length(p_items);
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập'; end if;
  select count(*) into n_db from public.vault_items where user_id = auth.uid();
  if n_db <> n_in then
    raise exception 'Số mục trong két đã thay đổi (% so với %). Hãy tải lại trang rồi thử lại.', n_db, n_in;
  end if;

  update public.vault_meta
     set salt = p_meta->>'salt', iter = (p_meta->>'iter')::int,
         check_iv = p_meta->>'check_iv', check_ct = p_meta->>'check_ct'
   where user_id = auth.uid();

  update public.vault_items v
     set iv = i->>'iv', ct = i->>'ct', updated_at = now()
    from jsonb_array_elements(p_items) i
   where v.id = (i->>'id')::uuid and v.user_id = auth.uid();
end;
$$;
revoke all on function public.vault_rekey(jsonb, jsonb) from public, anon;
grant execute on function public.vault_rekey(jsonb, jsonb) to authenticated;

-- 7) Kho chứa ảnh và file: bucket riêng tư "work-files" (mỗi người một thư mục theo user id) -----
insert into storage.buckets (id, name, public, file_size_limit)
values ('work-files', 'work-files', false, 52428800)          -- tối đa 50 MB / file
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "work-files: xem file của mình"  on storage.objects;
drop policy if exists "work-files: tải lên thư mục của mình" on storage.objects;
drop policy if exists "work-files: sửa file của mình"  on storage.objects;
drop policy if exists "work-files: xóa file của mình"  on storage.objects;

create policy "work-files: xem file của mình" on storage.objects for select to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "work-files: tải lên thư mục của mình" on storage.objects for insert to authenticated
  with check (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "work-files: sửa file của mình" on storage.objects for update to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "work-files: xóa file của mình" on storage.objects for delete to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
