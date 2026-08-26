-- EngagedLead 候选人查询
--
-- 背景（2026-08-25）：Meta 的合格线索优化要每周约 50 条同类事件才出得了学习期，
-- 而人工判定四天只点了 18 个、合格 1 个 —— 靠人点永远攒不够。这个函数给出
-- 「客户主动聊过 ≥3 句」的广告线索，由 engaged-lead-scan 每小时回传 EngagedLead
-- 事件保住事件量。人工判定继续攒，攒够了再把优化目标换回 QualifiedLead。
--
-- 三条硬规则写在 where 里，不靠调用方自觉：
--   1. 只要带广告标识的（fb_lead_id / ctwa_clid / fb_ad_id），没标识的一律不发
--   2. 排除广告表单的自动首句（"I filled out/in your form..."，全库 1,199 条），
--      那不是客户说的话，算进去等于把每个填表的人都当成聊过天
--   3. **人工判定优先**：销售点过合格/不合格的一律不再发自动事件 ——
--      否则销售判了「同行来套价」，系统还在给 Meta 发「这人不错」，自己打自己脸
--
-- ⚠️ 为什么是两段式而不是直接对 messages 聚合（第一版就是那么写的，翻车了）：
-- `text !~* '...'` 这个正则必须回堆读肥字段，0032 那条
-- (contact_id, direction, sent_at) 覆盖索引的 index-only scan 直接作废 →
-- PostgREST 的 8 秒 statement_timeout 下 57014。而 Management API 的超时更宽，
-- 手跑完全看不出来 —— 又一次「手跑通了 ≠ 线上通」。
-- 所以先用 contact_sales_signals（0034 的汇总表，trigger 维护，每 contact 一行）
-- 把候选压到几百个，再只对这几百个回 messages 精确数。
-- 第 1 段的 inbound_count 含表单自动首句所以是宽进，第 2 段才是准数。
create or replace function public.engaged_lead_candidates(max_rows int default 50)
returns table (contact_id uuid, inbound_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select c.id
    from contacts c
    join contact_sales_signals s on s.contact_id = c.id
    where (c.fb_lead_id is not null or c.fb_ad_id is not null or c.ctwa_clid is not null)
      and s.inbound_count >= 3
      and not exists (
        select 1 from contact_events e
        where e.contact_id = c.id and e.event_type = 'lead_qualified'
      )
      and not exists (
        select 1 from contact_events e
        where e.contact_id = c.id
          and e.event_type = 'fb_conversion_sent'
          and e.payload->>'event_name' = 'EngagedLead'
      )
  )
  select m.contact_id, count(*) as inbound_count
  from messages m
  join base b on b.id = m.contact_id
  where m.direction = 'inbound'
    and m.text !~* 'filled\s+(?:in|out)\s+your\s+form'
  group by m.contact_id
  having count(*) >= 3
  order by count(*) desc
  limit max_rows;
$$;

revoke all on function public.engaged_lead_candidates(int) from anon, authenticated;
