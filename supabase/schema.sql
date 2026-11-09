-- ============================================================
-- Bunny's Home · 数据库结构（第五章）
-- 在 Supabase → SQL Editor 里整段粘贴执行，可以重复执行
-- ============================================================

-- ---------- 1. 会话 ----------
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '新的对话',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 2. 消息 ----------
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null default '',
  model            text,
  tokens           integer not null default 0,
  image_url        text,
  -- 思考链、工具调用记录都塞这里，不单独建表
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists messages_conv_time_idx
  on public.messages (conversation_id, created_at);

-- ---------- 3. 记忆摘要（压缩后的旧对话） ----------
create table if not exists public.memories (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete cascade,
  summary          text not null,
  -- 这段摘要覆盖到哪一条消息为止
  covers_up_to     timestamptz,
  tokens           integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists memories_conv_idx
  on public.memories (conversation_id, created_at desc);

-- ---------- 4. 日记（双方各写各的） ----------
create table if not exists public.diary_entries (
  id          uuid primary key default gen_random_uuid(),
  author      text not null check (author in ('me', 'ta')),
  entry_date  date not null default current_date,
  title       text,
  body        text not null default '',
  mood        text,
  created_at  timestamptz not null default now(),
  unique (author, entry_date)
);

-- ---------- 5. 小纸条 ----------
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  author      text not null check (author in ('me', 'ta')),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ---------- 6. 日程（每天要做什么 / 做了什么） ----------
create table if not exists public.agenda_items (
  id          uuid primary key default gen_random_uuid(),
  item_date   date not null default current_date,
  at_time     text,
  text        text not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists agenda_date_idx on public.agenda_items (item_date);

-- ---------- 7. 键值设置（主题、名字、拍一拍文案…） ----------
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- 权限：只允许后端（service_role）访问
-- ------------------------------------------------------------
-- 这个 App 是单用户的，前端不直接连数据库，所有读写都走后端。
-- 所以这里开启 RLS 但【不建任何 anon 策略】——
-- anon key 拿到手也读不到一行数据，只有 service_role 能进。
-- 等以后要做多用户/登录，再按 user_id 加策略。
-- ============================================================
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.memories       enable row level security;
alter table public.diary_entries  enable row level security;
alter table public.notes          enable row level security;
alter table public.agenda_items   enable row level security;
alter table public.app_settings   enable row level security;

-- ---------- 顺手建一条会话，方便第六章直接测 ----------
insert into public.conversations (title)
select '第一个对话'
where not exists (select 1 from public.conversations);
