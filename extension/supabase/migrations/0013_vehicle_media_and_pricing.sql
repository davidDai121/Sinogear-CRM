-- Phase A: 车源阶梯价格 + 媒体库（图片/视频/配置表）
-- 媒体存 Cloudinary（unsigned upload preset），库里只存 URL + public_id

-- 阶梯价格 JSONB 数组：[{label: "FOB 单台", price_usd: 28000}, ...]
alter table vehicles
  add column if not exists pricing_tiers jsonb not null default '[]'::jsonb;

create type vehicle_media_type as enum ('image', 'video', 'spec');

create table vehicle_media (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references vehicles(id) on delete cascade,
  media_type      vehicle_media_type not null,
  url             text not null,
  public_id       text,                              -- cloudinary public_id, 用于删除
  caption         text,
  mime_type       text,
  file_size_bytes bigint,
  sort_order      int not null default 0,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index on vehicle_media (vehicle_id, sort_order);
create index on vehicle_media (vehicle_id, media_type);

alter table vehicle_media enable row level security;

create policy "vehicle_media read"
  on vehicle_media for select using (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_media.vehicle_id and public.is_org_member(v.org_id)
    )
  );

create policy "vehicle_media write"
  on vehicle_media for all using (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_media.vehicle_id and public.is_org_member(v.org_id)
    )
  ) with check (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_media.vehicle_id and public.is_org_member(v.org_id)
    )
  );
