/**
 * 广告线索按「表单」分配给业务员。
 *
 * 为什么按表单不按国家（2026-08-21 实测）：卢旺达同时跑着两个表单，
 * RW-Nammi01 归 daimenglong、RW-B2B-QINPLUS 归 2064026258 —— 同一个国家两个人，
 * 按国家分必然分错。boss 的规则是「一个表单只给一个业务员」。
 *
 * 归属从哪来：Meta **不给读**表单绑的 WhatsApp 号（试过 7 种 Graph API
 * 字段/端点、表单库 UI、6 页表单预览、整页 DOM 全文搜索，全拿不到）。
 * 改成从事实反推——客户点了「Chat on WhatsApp」就被真实路由到某个业务员的号上，
 * 而每个业务员用自己的 WhatsApp 登录扩展，contact_handlers 自动登记。
 * 按表单统计主理人分布，占比最高的就是归属。实测纯度 91%–100%。
 *
 * 2026-09-09 起的主路径：**按命名代号归属**（migration 0040）。
 * 表单名 / 广告名开头写业务员代号（`miles-哥伦比亚-904`、`grant-几内亚`），
 * 代号在 lead_owner_aliases 登记过就直接归属，webhook 收到线索当场落主理人，
 * 不用等样本。上面的样本推断保留，给老表单和没按规范命名的表单兜底。
 *
 * 优先级：lead_routing_rules（按表单精确指定）> 表单名代号 > 广告名代号。
 * 这个顺序和 SQL `resolve_lead_owner` 一致，改一处要同步改另一处。
 */
import { supabase } from './supabase';

/**
 * 从表单名 / 广告名里取业务员代号：开头连续的 ASCII 字母数字，小写。
 * 和 SQL `lead_owner_alias_of` 同一规则。
 *   `miles-哥伦比亚-904` → miles   `Cheryl-卢旺达` → cheryl   `视频1` → null
 */
export function aliasOf(name: string | null | undefined): string | null {
  const m = /^\s*([A-Za-z0-9]+)/.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

export interface OwnerAlias {
  alias: string;
  user_id: string;
  note: string | null;
}

/** 样本太少推不准（谁临时点开过聊天都会被当成归属） */
export const MIN_SAMPLE = 3;
/** 纯度低于此说明这个表单同时被多人在跟，要人工定 */
export const MIN_PURITY = 0.7;

export interface RoutingRule {
  id: string;
  form_name: string;
  user_id: string;
  auto_detected: boolean;
  confidence: number | null;
}

export interface LeadSample {
  name: string;
  phone: string;
  at: string;
}

export interface FormStat {
  formName: string;
  /** Meta 的表单 ID */
  formId: string;
  /** 这个表单下出现过的广告 ID（一个表单可能挂多条广告） */
  adIds: string[];
  /** 这个表单下出现过的广告名 */
  adNames: string[];
  /** 按命名代号解析出的归属（表单名优先，其次广告名）；没登记的代号 → null */
  aliasUserId: string | null;
  aliasSource: 'form' | 'ad' | null;
  /** 名字里有代号但没登记（提示去登记） */
  unknownAlias: string | null;
  /** 真正生效的归属：精确规则 > 命名代号 */
  effectiveUserId: string | null;
  /** 这个表单进 CRM 的线索数 */
  total: number;
  /** 其中真的聊过的（有消息） */
  contacted: number;
  /** 其中还没人跟的 */
  unassigned: number;
  /** 主理人分布 user_id → 条数（只统计聊过的） */
  handlers: Record<string, number>;
  /** 推断出的归属 */
  suggestUserId: string | null;
  suggestPurity: number;
  /** 样本够且纯度够 —— 可以一键采用 */
  suggestOk: boolean;
  /** 当前生效的规则 */
  rule: RoutingRule | null;
  /** 还没人跟的那批客户，给界面上展开看「到底分的是谁」 */
  samples: LeadSample[];
}

export interface RoutingSnapshot {
  forms: FormStat[];
  /** 已登记的代号 */
  aliases: OwnerAlias[];
  /** 既没有规则、名字里也没有可识别代号的表单数 */
  formsWithoutRule: number;
  /** 有归属（规则或代号）但还没落主理人的线索数（点一下就能分配） */
  assignable: number;
  /** 没有归属、因此分不出去的线索数 */
  blocked: number;
}

/**
 * ⚠️ 不要用 `.eq('event_type', ...)` 直接扫 contact_events。
 * 2026-08-21 实测：那张表 90 多万行、event_type 没有索引，全表扫直接撞
 * 8 秒 statement timeout（`canceling statement due to statement timeout`）。
 * 正确姿势：先用 contacts 的 (org_id, fb_lead_id) 唯一索引把广告线索客户
 * 捞出来（几百行），再按 contact_id 反查——contact_events 有
 * (contact_id, created_at desc) 索引，走索引几十毫秒。
 */
async function chunked<T>(
  ids: string[],
  size: number,
  run: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(...(await run(ids.slice(i, i + size))));
  }
  return out;
}

export async function loadRoutingSnapshot(orgId: string): Promise<RoutingSnapshot> {
  // 1. 广告线索客户（走 (org_id, fb_lead_id) 索引）
  const leadContacts: { id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id')
      .eq('org_id', orgId)
      .not('fb_lead_id', 'is', null)
      .order('id')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    leadContacts.push(...rows);
    if (rows.length < 1000) break;
  }
  const ids = leadContacts.map((c) => c.id);

  // 2. 只查这批人的事件 / 主理人 / 消息数
  const [events, handlers, signals, rules, aliases] = await Promise.all([
    chunked(ids, 150, async (batch) => {
      const { data, error } = await supabase
        .from('contact_events')
        .select('contact_id, payload, created_at')
        .in('contact_id', batch)
        .eq('event_type', 'fb_lead_received');
      if (error) throw new Error(error.message);
      return (data ?? []) as { contact_id: string; payload: Record<string, unknown>; created_at: string }[];
    }),
    chunked(ids, 150, async (batch) => {
      const { data, error } = await supabase
        .from('contact_handlers')
        .select('contact_id, user_id, last_seen_at')
        .in('contact_id', batch);
      if (error) throw new Error(error.message);
      return (data ?? []) as { contact_id: string; user_id: string; last_seen_at: string }[];
    }),
    chunked(ids, 150, async (batch) => {
      const { data, error } = await supabase
        .from('contact_sales_signals')
        .select('contact_id, message_count')
        .in('contact_id', batch);
      if (error) throw new Error(error.message);
      return (data ?? []) as { contact_id: string; message_count: number }[];
    }),
    supabase
      .from('lead_routing_rules')
      .select('id, form_name, user_id, auto_detected, confidence')
      .eq('org_id', orgId)
      .then((r) => {
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []) as RoutingRule[];
      }),
    supabase
      .from('lead_owner_aliases')
      .select('alias, user_id, note')
      .eq('org_id', orgId)
      .order('alias')
      .then((r) => {
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []) as OwnerAlias[];
      }),
  ]);

  // 一个 contact 可能有多个 handler，取最早接触的（最可能是被路由到的那个）
  const first = new Map<string, { user_id: string; last_seen_at: string }>();
  for (const h of handlers) {
    const p = first.get(h.contact_id);
    if (!p || h.last_seen_at < p.last_seen_at) first.set(h.contact_id, h);
  }
  const msgs = new Map(signals.map((s) => [s.contact_id, s.message_count ?? 0]));

  // 同一个客户可能有多条 fb_lead_received（重复提交），取最新那条的表单
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const latest = new Map<
    string,
    { form: string; formId: string; adId: string; adName: string; at: string; leadAt: string; name: string; phone: string }
  >();
  for (const e of events) {
    const form = str(e.payload?.form_name);
    if (!form) continue;
    const p = latest.get(e.contact_id);
    if (p && e.created_at <= p.at) continue;
    const fields: Record<string, string> = {};
    for (const f of (e.payload?.field_data as { name: string; values: string[] }[]) ?? []) {
      if (f?.name) fields[f.name] = (f.values ?? []).join(', ');
    }
    latest.set(e.contact_id, {
      form,
      formId: str(e.payload?.form_id),
      adId: str(e.payload?.ad_id),
      adName: str(e.payload?.ad_name),
      at: e.created_at,
      leadAt: str(e.payload?.created_time).slice(0, 10),
      name: fields.full_name ?? '',
      phone: fields.phone_number ?? '',
    });
  }

  const ruleOf = new Map(rules.map((r) => [r.form_name, r]));
  const aliasUser = new Map(aliases.map((a) => [a.alias, a.user_id]));
  const acc = new Map<string, FormStat>();
  for (const [contactId, info] of latest) {
    const form = info.form;
    let st = acc.get(form);
    if (!st) {
      st = {
        formName: form,
        formId: info.formId,
        adIds: [],
        adNames: [],
        aliasUserId: null,
        aliasSource: null,
        unknownAlias: null,
        effectiveUserId: null,
        samples: [],
        total: 0,
        contacted: 0,
        unassigned: 0,
        handlers: {},
        suggestUserId: null,
        suggestPurity: 0,
        suggestOk: false,
        rule: ruleOf.get(form) ?? null,
      };
      acc.set(form, st);
    }
    st.total++;
    if (info.adId && !st.adIds.includes(info.adId)) st.adIds.push(info.adId);
    if (info.adName && !st.adNames.includes(info.adName)) st.adNames.push(info.adName);
    const h = first.get(contactId);
    if (!h) {
      st.unassigned++;
      st.samples.push({ name: info.name, phone: info.phone, at: info.leadAt });
    }
    if ((msgs.get(contactId) ?? 0) > 0 && h) {
      st.contacted++;
      st.handlers[h.user_id] = (st.handlers[h.user_id] ?? 0) + 1;
    }
  }

  for (const st of acc.values()) {
    // 命名代号：表单名优先，其次任一广告名（同一表单下广告名代号不一致时取第一个命中的）
    const formAlias = aliasOf(st.formName);
    if (formAlias && aliasUser.has(formAlias)) {
      st.aliasUserId = aliasUser.get(formAlias)!;
      st.aliasSource = 'form';
    } else {
      for (const ad of st.adNames) {
        const a = aliasOf(ad);
        if (a && aliasUser.has(a)) {
          st.aliasUserId = aliasUser.get(a)!;
          st.aliasSource = 'ad';
          break;
        }
      }
      if (!st.aliasUserId && formAlias) st.unknownAlias = formAlias;
    }
    st.effectiveUserId = st.rule?.user_id ?? st.aliasUserId;

    const ranked = Object.entries(st.handlers).sort((a, b) => b[1] - a[1]);
    if (ranked.length && st.contacted > 0) {
      st.suggestUserId = ranked[0][0];
      st.suggestPurity = ranked[0][1] / st.contacted;
      st.suggestOk = st.contacted >= MIN_SAMPLE && st.suggestPurity >= MIN_PURITY;
    }
  }

  const forms = [...acc.values()].sort((a, b) => b.total - a.total);
  return {
    forms,
    aliases,
    formsWithoutRule: forms.filter((f) => !f.effectiveUserId).length,
    assignable: forms.filter((f) => f.effectiveUserId).reduce((n, f) => n + f.unassigned, 0),
    blocked: forms.filter((f) => !f.effectiveUserId).reduce((n, f) => n + f.unassigned, 0),
  };
}

export async function setRule(
  orgId: string,
  formName: string,
  userId: string,
  auto: boolean,
  confidence: number | null,
): Promise<void> {
  const { error } = await supabase.from('lead_routing_rules').upsert(
    {
      org_id: orgId,
      form_name: formName,
      user_id: userId,
      auto_detected: auto,
      confidence,
    },
    { onConflict: 'org_id,form_name' },
  );
  if (error) throw new Error(error.message);
}

export async function clearRule(ruleId: string): Promise<void> {
  const { error } = await supabase.from('lead_routing_rules').delete().eq('id', ruleId);
  if (error) throw new Error(error.message);
}

/** 登记 / 改一个代号。alias 会被规范成小写字母数字，非法直接抛错 */
export async function setAlias(orgId: string, alias: string, userId: string): Promise<void> {
  const norm = alias.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(norm)) {
    throw new Error('代号只能是英文字母和数字，比如 miles / grant / cheryl');
  }
  const { error } = await supabase
    .from('lead_owner_aliases')
    .upsert({ org_id: orgId, alias: norm, user_id: userId }, { onConflict: 'org_id,alias' });
  if (error) throw new Error(error.message);
}

export async function clearAlias(orgId: string, alias: string): Promise<void> {
  const { error } = await supabase
    .from('lead_owner_aliases')
    .delete()
    .eq('org_id', orgId)
    .eq('alias', alias);
  if (error) throw new Error(error.message);
}

/** 走 RPC：contact_handlers 的 RLS 只允许写自己，指派给别人必须 security definer */
export async function applyRouting(orgId: string): Promise<number> {
  const { data, error } = await supabase.rpc('apply_lead_routing', { p_org_id: orgId });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}
