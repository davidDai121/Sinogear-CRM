-- 0044: 业务号码按 org 路由——测试号的消息进测试 org，不进主库
--
-- 背景（2026-09-22）：测试号 +8613552592187 在 CRM 里是 996229439@qq.com 登录的，
-- 那个账号是一个独立测试 org 的 owner，不在主 org。0043 把它登记在主 org 名下，
-- coexistence 接入后它的聊天会写进主库。boss 要求试点数据跟正式客户彻底分开。
--
-- wa-cloud-webhook 现在按「号码登记在哪个 org」决定写进哪个 org（未登记的新号仍走 FB_ORG_ID），
-- 所以一个号码只能属于一个 org：phone 加全局唯一。

create unique index wa_business_numbers_phone_key on public.wa_business_numbers (phone);

-- 测试号挪到 996229439@qq.com 当 owner 的那个 org，归属给这个账号
update public.wa_business_numbers n
set org_id = m.org_id,
    user_id = u.id,
    label = '测试号 David'
from auth.users u
join public.organization_members m on m.user_id = u.id and m.role = 'owner'
where u.email = '996229439@qq.com'
  and n.phone = '+8613552592187';
