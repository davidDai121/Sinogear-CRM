-- 0043: coexistence 接入用——业务号码 → 业务员，消息记录是哪个号收发的
--
-- 背景（2026-09-22）：wa-cloud-webhook 接 coexistence 后，Meta 推来的每条消息都带
-- metadata.display_phone_number（我们自己的业务号）。团队 5 人用 5 个独立号码
-- （whatsapp_labels 每人标签集完全不同，确认没有共用），同一个客户可能跟两个号都聊过，
-- 不记号码就分不清是谁的对话、新客户该归谁。
--
-- 号码来源（2026-09-22 从聊天记录/客户表反推，boss 确认 Cheryl 的号）：
--   Miles  +8615555172187  自己报号给客户
--   Grant  +8617364388937  8/20 邮件签名
--   Sophia +8618949842722  9/10 Miles 告知客户「Sino Gear Sophia」账号
--   Cheryl +8618399455977  boss 口头确认
--   David  +8613552592187  测试号（CRM 账号 dengrongc6 已不活跃，不绑业务员）
--
-- last_webhook_at：coexistence 的 App 大约 13–14 天不打开就会静默断开、没有任何通知。
-- webhook 每收到一次就刷新，某个号很久没动静 = 可能断了，要人去看。

create table public.wa_business_numbers (
  org_id           uuid not null references public.organizations(id) on delete cascade,
  phone            text not null check (phone ~ '^\+[0-9]{6,20}$'),
  user_id          uuid references auth.users(id) on delete set null,
  label            text,
  phone_number_id  text,          -- Meta phone_number_id，webhook 首次收到时写入
  last_webhook_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, phone)
);

alter table public.wa_business_numbers enable row level security;

create policy "wa numbers read"   on public.wa_business_numbers for select using (public.is_org_member(org_id));
create policy "wa numbers insert" on public.wa_business_numbers for insert with check (public.is_org_member(org_id));
create policy "wa numbers update" on public.wa_business_numbers for update using (public.is_org_member(org_id));
create policy "wa numbers delete" on public.wa_business_numbers for delete using (public.is_org_member(org_id));

create trigger wa_business_numbers_touch
  before update on public.wa_business_numbers
  for each row execute function public.touch_updated_at();

-- 登记已知号码。user_id 按 lead_owner_aliases 里的代号取，不写死 uuid。
insert into public.wa_business_numbers (org_id, phone, user_id, label)
select a.org_id, v.phone, a.user_id, v.label
from (values
  ('+8615555172187', 'miles',  'Miles'),
  ('+8617364388937', 'grant',  'Grant'),
  ('+8618949842722', 'sophia', 'Sophia'),
  ('+8618399455977', 'cheryl', 'Cheryl')
) as v(phone, alias, label)
join public.lead_owner_aliases a on a.alias = v.alias
on conflict (org_id, phone) do nothing;

insert into public.wa_business_numbers (org_id, phone, user_id, label)
select distinct org_id, '+8613552592187', null::uuid, '测试号 David'
from public.lead_owner_aliases
on conflict (org_id, phone) do nothing;

-- 消息是哪个业务号收发的。DOM / 备份导入的老数据为 NULL（当时不知道）。
alter table public.messages add column business_phone text;

-- 接入凭证：wa-onboard 换来的 business token，之后补同步 / 下载媒体要用。
-- 只给 service_role 用：开 RLS 不建任何 policy，业务员身份读不到。
create table public.wa_business_accounts (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  waba_id       text not null,
  access_token  text not null,
  onboarded_by  uuid references auth.users(id) on delete set null,
  onboarded_at  timestamptz not null default now(),
  sync_result   jsonb,          -- 触发通讯录 / 历史同步时 Meta 的原始返回，排查用
  primary key (org_id, waba_id)
);

alter table public.wa_business_accounts enable row level security;
