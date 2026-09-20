import { quoteConversationId, saveQuotePreview } from '@/lib/quote-preview';
import { snapshotDraftEvidence, type DraftEvidence } from '@/lib/draft-freshness';
import { DraftFreshnessNotice } from './DraftFreshnessNotice';
import { completeFollowupResult } from '@/lib/gpt-followup-result';
import {
  loadChatContext,
  loadGroupMemberNames,
  type MessageSource,
} from '@/lib/chat-context';
import { loadFollowupContext, followupPrompt, saveFollowup, type FollowupContext } from '@/lib/gpt-followup';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersistedReplyStatus } from '@/panel/hooks/usePersistedReplyStatus';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat } from '@/lib/jump-to-chat';
import { type ChatMessage } from '@/content/whatsapp-messages';
import { loadMessages } from '@/lib/message-sync';
import {
  buildFirstMessage,
  buildFollowUpMessage,
  buildDiscussionMessage,
  chatHistoryEvidence,
} from '@/lib/gpt-prompt';
import { parseClaudeResponse } from '@/lib/claude-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { recordFill } from '@/lib/ai-reply-attribution';
import { setReplyProgress, clearReplyProgress } from '@/lib/reply-progress';
import { useReplyProgress } from '../hooks/useReplyProgress';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';
import { ClientRecordCard } from './ClientRecordCard';
import { GPTTemplatesModal } from './GPTTemplatesModal';
import { GeneratedAtBadge } from './GeneratedAtBadge';
import type { GptSkill } from '@/lib/gpt-skill';
import { publicQuoteAmounts, completeQuoteCalculation, saveQuoteVersion } from '@/lib/quote-workflow';
import { extractFreightResearch } from '@/lib/freight-research';
import { loadPersonalSalesWorkMemory as loadSalesWorkMemory, saveSalesWorkEntry, type SalesWorkMemory } from '@/lib/sales-work-memory';
import { rememberSalesPreferences, saveSalesPreference, type SalesPreference, type PreferenceScope } from '@/lib/sales-preferences';
import { loadGptApprovedKnowledge } from '@/lib/gpt-template-knowledge';
import { resolveGptTemplateRoute, isConversationForGptTemplate } from '@/lib/gpt-template-routing';
import { loadApplicableSalesFacts } from '@/lib/sales-facts';
import { SalesFactsPanel } from './SalesFactsPanel';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type GptConvRow = Database['public']['Tables']['gpt_conversations']['Row'];
type GptTemplateRow = Database['public']['Tables']['gpt_templates']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  orgId: string;
  contact: ContactRow;
  needsJump?: boolean;
}

type Mode = 'reply' | 'discuss';

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | {
      kind: 'sending';
      foreground: boolean;
      mode: Mode;
      source: MessageSource;
      count: number;
      templateName: string;
    }
  | {
      kind: 'done';
      mode: Mode;
      text: string;
      chatUrl: string;
      source: MessageSource;
      count: number;
      logId: string | null;
      templateId?: string;
      templateName?: string;
      /** 自动由 usePersistedReplyStatus 注入（done 状态写 chrome.storage 时盖戳） */
      generatedAt?: number;
      followupWarning?: string;
      inputEvidence?: DraftEvidence;
    }
  | { kind: 'error'; message: string };

/**
 * GPT 回复 — 走 chatgpt.com 网页端自动化。
 *
 * 跟 Gem 一样的模板架构（per-user）：
 *   - 用户在 chatgpt.com/gpts 自建 Custom GPT，URL 录入 gpt_templates 表
 *   - 每个 (contact, template) 的对话 URL 缓存到 gpt_conversations，下次续聊
 *   - per-user RLS：每个销售只看到自己 ChatGPT 账号下的 Custom GPT
 *   - 没有模板时不让生成（必须先建一个，URL 可填默认 https://chatgpt.com/?model=gpt-5-thinking）
 *
 * 两条主流程：
 *   - generate(): 给客户写下一条回复（三段 Client Record / WhatsApp Reply / Translation & Strategy）
 *   - sendDiscussion(): 跟 GPT 商量这客户怎么办（自由中文回答，不走三段格式）
 */
export function GPTReplySection(props: Props) {
  // Keep in-flight work and restored UI state bound to the original customer.
  return <GPTReplyForContact key={`${props.orgId}:${props.contact.id}`} {...props} />;
}

function GPTReplyForContact({ orgId, contact, needsJump }: Props) {
  const [templates, setTemplates] = useState<GptTemplateRow[]>([]);
  const [conversations, setConversations] = useState<GptConvRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  // The keyed customer component prevents a manual choice leaking to another contact.
  const [manualTemplateId, setManualTemplateId] = useState<string>();
  const [showTemplates, setShowTemplates] = useState(false);
  const [foreground, setForeground] = useState(false);
  const [status, setStatus] = usePersistedReplyStatus<Status>('gpt', contact.id, { kind: 'idle' });
  const [guidance, setGuidance] = useState('');
  const [guidanceLoaded, setGuidanceLoaded] = useState(false);
  const [discuss, setDiscuss] = useState('');
  const [workMemory, setWorkMemory] = useState<SalesWorkMemory>();
  const [memoryError, setMemoryError] = useState('');
  const [preferenceNotice, setPreferenceNotice] = useState('');
  const [newDemand, setNewDemand] = useState('');
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [routeContext, setRouteContext] = useState<{
    messages: ChatMessage[];
    vehicleInterests: VehicleInterestRow[];
  } | null>(null);
  const [routeContextError, setRouteContextError] = useState('');
  const actionLock = useRef(false);
  const requestMetrics = useRef({ requests: 0, inputChars: 0, outputChars: 0 });
  const runGpt = async (options: Record<string, unknown>) => {
    requestMetrics.current.requests++;
    requestMetrics.current.inputChars += typeof options.prompt === 'string' ? options.prompt.length : 0;
    const requestId = crypto.randomUUID();
    const started = Date.now();
    let result;
    try { result = await chrome.runtime.sendMessage({...options, requestId}); }
    catch { result = await chrome.runtime.sendMessage({type:'GPT_RESULT', requestId}); }
    while (result?.pending && Date.now() - started < 22 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { result = await chrome.runtime.sendMessage({type:'GPT_RESULT', requestId}); }
      catch { /* 短暂通道断开后继续取同一个结果，不重发 prompt。 */ }
    }
    if (result?.pending) throw new Error('GPT 仍未交付，原会话和已完成结果会保留，请稍后检查');
    requestMetrics.current.outputChars += typeof result?.responseText === 'string' ? result.responseText.length : 0;
    return result;
  };
  const mounted = useRef(true);
  const templateRequest = useRef(0);
  const conversationRequest = useRef(0);
  const routeContextRequest = useRef(0);
  // A successful owner-directed result stays valid when its one-shot guidance
  // is cleared. This exemption is local to this view, never restored from cache.
  const freshResult = useRef<{ templateId: string; chatUrl: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadSalesWorkMemory(supabase, orgId, contact.id).then(memory => {
      if (!cancelled) { setWorkMemory(memory); setMemoryError(''); }
    }).catch(error => { if (!cancelled) setMemoryError(stringifyError(error)); });
    return () => { cancelled = true; };
  }, [orgId, contact.id]);

  const startDemand = async () => {
    if (actionLock.current || !newDemand.trim()) return;
    actionLock.current = true;
    setStatus({ kind: 'reading' });
    try {
      const scopeId = crypto.randomUUID();
      await saveSalesWorkEntry(supabase, orgId, contact.id, {
        id: scopeId, scopeId, kind: 'scope', text: newDemand.trim(),
      });
      const memory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) {
        setWorkMemory(memory); setMemoryError(''); setNewDemand('');
        setGuidance(''); setDiscuss(''); freshResult.current = null;
        setStatus({ kind: 'idle' });
      }
    } catch (error) {
      setMemoryError(stringifyError(error)); setStatus({ kind: 'idle' });
    } finally { actionLock.current = false; }
  };

  const revisePreference = async (preference: SalesPreference, scope?: PreferenceScope) => {
    if (actionLock.current) return;
    actionLock.current = true;
    try {
      const { id: _id, at: _at, ...value } = preference;
      await saveSalesPreference(supabase, { ...value, active: scope ? false : !preference.active });
      if (scope) await saveSalesPreference(supabase, { ...value, contactId: contact.id,
        scopeId: workMemory?.scopeId ?? contact.id, scope, active: true });
      const memory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) { setWorkMemory(memory); setPreferenceNotice(''); }
    } catch (error) { setPreferenceNotice(stringifyError(error)); }
    finally { actionLock.current = false; }
  };

  // ── 前台开关 ──
  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get('gptForeground').then((s) => {
      if (!cancelled) setForeground(Boolean(s.gptForeground));
    });
    return () => { cancelled = true; };
  }, []);

  // ── 模板 + 对话拉取 ──
  const refreshTemplates = async () => {
    const request = ++templateRequest.current;
    const { data, error } = await supabase
      .from('gpt_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (!mounted.current || request !== templateRequest.current) return;
    setTemplatesLoaded(true);
    if (error) {
      setSetupError(`读取 GPT 模板失败：${stringifyError(error)}`);
      return;
    }
    setSetupError('');
    setTemplates(data ?? []);
  };

  const refreshConversations = async () => {
    const request = ++conversationRequest.current;
    const { data, error } = await supabase
      .from('gpt_conversations')
      .select('*')
      .eq('contact_id', contact.id);
    if (!mounted.current || request !== conversationRequest.current) return;
    if (error) {
      setSetupError(`读取 GPT 会话失败：${stringifyError(error)}`);
      return;
    }
    setConversations(data ?? []);
  };

  const loadVehicleInterests = async () => {
    const { data, error } = await supabase
      .from('vehicle_interests')
      .select('*')
      .eq('contact_id', contact.id);
    if (error) throw new Error(`读取车型兴趣失败：${stringifyError(error)}`);
    return data ?? [];
  };

  useEffect(() => {
    void refreshTemplates();
  }, [orgId]);

  useEffect(() => {
    void refreshConversations();
    // status 由 usePersistedReplyStatus 接管：切 contact 时它会自动恢复上次 done card（如有）
    setDiscuss('');
  }, [contact.id]);

  useEffect(() => {
    let cancelled = false;
    const request = ++routeContextRequest.current;
    void Promise.all([loadMessages(contact.id, 50), loadVehicleInterests()])
      .then(([rows, vehicleInterests]) => {
        if (cancelled || request !== routeContextRequest.current) return;
        setRouteContext({
          messages: rows.map((r) => ({
            id: r.wa_message_id,
            fromMe: r.direction === 'outbound',
            text: r.text,
            timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
            sender: null,
          })),
          vehicleInterests,
        });
        setRouteContextError('');
      })
      .catch((error) => {
        if (!cancelled && request === routeContextRequest.current) {
          setRouteContextError(`模板预匹配失败，生成时将重新核对：${stringifyError(error)}`);
        }
      });
    return () => { cancelled = true; };
  }, [contact.id]);

  // ── 一次性迁移：把老的 chrome.storage.local['gptCustomUrl'] 转成第一个模板 ──
  // 0026 之前用户把 Custom GPT URL 存在 chrome.storage 里。改 DB 模板后，
  // 第一次打开看到自己有老 URL 但没模板 → 自动建一个名叫"我的 Custom GPT"的模板，
  // 然后清掉 chrome.storage 那条。一台机器一次。
  useEffect(() => {
    if (!templatesLoaded || setupError || templates.length > 0) return;
    let cancelled = false;
    void chrome.storage.local.get('gptCustomUrl').then(async (s) => {
      const legacy =
        typeof s.gptCustomUrl === 'string' ? s.gptCustomUrl.trim() : '';
      if (!legacy || cancelled) return;
      // 建模板（created_by 由 trigger 自动填 auth.uid()）
      const { error } = await supabase.from('gpt_templates').insert({
        org_id: orgId,
        name: '我的 Custom GPT',
        gpt_url: legacy,
        description: '从旧 chrome.storage 自动迁移',
        is_default: true,
      });
      if (error) {
        console.warn('[gpt-template-migrate]', error.message);
        return;
      }
      await chrome.storage.local.remove('gptCustomUrl');
      if (!cancelled) await refreshTemplates();
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, templates.length, templatesLoaded, setupError]);

  // 自动选默认（or 第一个）模板
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      const def = templates.find((t) => t.is_default) ?? templates[0];
      setSelectedTemplateId(def.id);
    }
  }, [templates, selectedTemplateId]);

  const previewRoute = useMemo(
    () => resolveGptTemplateRoute(templates, selectedTemplateId, {
      messages: routeContext?.messages ?? [],
      vehicleInterests: routeContext?.vehicleInterests ?? [],
      salesGuidance: guidance,
      manualTemplateId,
    }),
    [templates, selectedTemplateId, routeContext, guidance, manualTemplateId],
  );
  const selectedTemplate = previewRoute.template;

  const updateGuidance = (next: string) => {
    if (freshResult.current) {
      // With no old customer topic, a non-model edit keeps the result's route;
      // an explicit instruction changing models invalidates that local result.
      const nextRoute = resolveGptTemplateRoute(templates, freshResult.current.templateId, {
        messages: [],
        vehicleInterests: [],
        salesGuidance: next,
        manualTemplateId,
      });
      if (nextRoute.error || nextRoute.template?.id !== freshResult.current.templateId) {
        freshResult.current = null;
      }
    }
    setGuidance(next);
  };

  const existingConv = useMemo(
    () =>
      selectedTemplate
        ? conversations.find((c) => isConversationForGptTemplate(c, contact.id, selectedTemplate)) ?? null
        : null,
    [conversations, selectedTemplate, contact.id],
  );

  // ── 销售指令（per-contact 持久化） ──
  const guidanceKey = `gptGuidance:${contact.id}`;
  const manualTemplateKey = `gptManualTemplate:${orgId}:${contact.id}`;
  useEffect(() => {
    let cancelled = false;
    setGuidanceLoaded(false);
    void chrome.storage.local.get([guidanceKey, manualTemplateKey]).then((s) => {
      if (cancelled) return;
      const saved =
        typeof s[guidanceKey] === 'string' ? (s[guidanceKey] as string) : '';
      setGuidance(saved);
      const manual = s[manualTemplateKey];
      if (typeof manual === 'string' && manual) { setManualTemplateId(manual); setSelectedTemplateId(manual); }
      setGuidanceLoaded(true);
    });
    return () => { cancelled = true; };
  }, [guidanceKey]);

  useEffect(() => {
    if (!guidanceLoaded) return;
    if (guidance) {
      void chrome.storage.local.set({ [guidanceKey]: guidance });
    } else {
      void chrome.storage.local.remove(guidanceKey);
    }
  }, [guidance, guidanceLoaded, guidanceKey]);

  const toggleForeground = (next: boolean) => {
    setForeground(next);
    void chrome.storage.local.set({ gptForeground: next });
  };

  // 读 messages：DOM 优先 + DB merge + 持久化，DOM 空 fallback 纯 DB。
  // 共享实现见 lib/chat-context.ts（含身份校验 / 冷启动语义的完整注释）。
  const loadChatMessages = () =>
    loadChatContext(contact, {
      needsJump: Boolean(needsJump),
      logTag: 'GPTReplySection.generate',
      guidance,
      // GPT 跟进保存前必须确保最新消息已入库，sync 失败要抛错
      awaitSync: true,
      // DOM 路径向上滚动补采更多历史
      collectRecent: true,
    });

  const loadActionContext = async (discussionQuestion?: string) => {
    const request = ++routeContextRequest.current;
    const [loaded, vehicleInterests] = await Promise.all([
      loadChatMessages(),
      loadVehicleInterests(),
    ]);
    if (mounted.current && request === routeContextRequest.current) {
      setRouteContext({ messages: loaded.messages, vehicleInterests });
      setRouteContextError('');
    }
    const route = resolveGptTemplateRoute(templates, selectedTemplateId, {
      messages: loaded.messages,
      vehicleInterests,
      salesGuidance: guidance.trim() || undefined,
      discussionQuestion,
      manualTemplateId,
    });
    if (route.error) throw new Error(route.error);
    const template = route.template;
    if (!template) throw new Error('请先选择一个 Custom GPT 模板，或点"管理模板"添加。');
    const [approvedKnowledge, initialMemory] = await Promise.all([
      loadGptApprovedKnowledge(supabase, template.id, orgId),
      loadSalesWorkMemory(supabase, orgId, contact.id),
    ]);
    let memory = initialMemory;
    const input = discussionQuestion?.trim() || guidance.trim();
    const kind = discussionQuestion ? 'sales_discussion' as const : 'sales_instruction' as const;
    const lastInput = memory.entries.filter(e => e.kind === 'sales_instruction' || e.kind === 'sales_discussion').at(-1);
    let sourceEntryId = lastInput?.id ?? '';
    if (input && (lastInput?.text !== input || lastInput.kind !== kind)) {
      sourceEntryId = crypto.randomUUID();
      await saveSalesWorkEntry(supabase, orgId, contact.id, {
        id: sourceEntryId, scopeId: memory.scopeId, kind, text: input, templateId: template.id,
      });
    }
    if (mounted.current) { setWorkMemory(memory); setMemoryError(''); }
    const { data, error } = await supabase
      .from('gpt_conversations')
      .select('*')
      .eq('contact_id', contact.id)
      .eq('template_id', template.id)
      .maybeSingle();
    if (error) throw new Error(`读取 GPT 会话失败：${stringifyError(error)}`);
    // An old/misbound URL is never used with a different Custom GPT's knowledge.
    const scopeStart = memory.entries.find(e => e.kind === 'scope');
    const conversation = data && isConversationForGptTemplate(data, contact.id, template)
      && (!scopeStart || Date.parse(data.last_used_at) >= Date.parse(scopeStart.at)) ? data : null;
    const followupContext = await loadFollowupContext(supabase, orgId, contact.id);
    if (input && sourceEntryId) {
      try {
        await rememberSalesPreferences(supabase, { orgId, userId: followupContext.userId, contactId: contact.id,
          scopeId: memory.scopeId, sourceEntryId, sourceText: input }, memory.preferences ?? []);
        setPreferenceNotice('');
      } catch (error) {
        setPreferenceNotice(`本轮指令已保存，偏好提取未保存：${stringifyError(error)}`);
      }
      memory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) setWorkMemory(memory);
    }
    memory = { ...memory, factLibrary: await loadApplicableSalesFacts(supabase, {
      orgId, contactId: contact.id, scopeId: memory.scopeId, contact, messages: loaded.messages,
      vehicleInterests, salesGuidance: guidance, discussionQuestion, workMemory: memory,
    }) };
    if (mounted.current) setWorkMemory(memory);
    return { ...loaded, vehicleInterests, template, approvedKnowledge, workMemory: memory, conversation, followupContext };
  };

  const saveConversation = async (template: GptTemplateRow, chatUrl: string) => {
    const record = { contact_id: contact.id, template_id: template.id, chat_url: chatUrl };
    if (typeof chatUrl !== 'string' || !isConversationForGptTemplate(record, contact.id, template)) {
      throw new Error('GPT 返回的会话与本次模板不匹配，未保存此会话。请重新生成。');
    }
    const { data, error } = await supabase
      .from('gpt_conversations')
      .upsert({ ...record, last_used_at: new Date().toISOString() }, { onConflict: 'contact_id,template_id' })
      .select('*')
      .single();
    if (error) throw new Error(`保存 GPT 会话失败：${stringifyError(error)}`);
    ++conversationRequest.current;
    if (mounted.current) {
      setConversations((current) => [
        ...current.filter((c) => c.contact_id === contact.id && c.template_id !== template.id),
        data,
      ]);
    }
  };

  const saveGeneratedWork = async (text: string, chatUrl: string, template: GptTemplateRow, memory: SalesWorkMemory, mode: Mode, followupContext: FollowupContext, skill?: GptSkill, messageId?: string) => {
    const templateId = template.id, scopeId = memory.scopeId;
    const research = extractFreightResearch(text);
    if (research.record) {
      await saveSalesWorkEntry(supabase, orgId, contact.id, {
        id: crypto.randomUUID(), scopeId, kind: 'freight_lookup', templateId, chatUrl,
        text: JSON.stringify({ schema: 'freight-research.v1', recordedAt: new Date().toISOString(),
          status: 'model_research_unverified', bindingQuote: false, raw: research.record }),
      });
    }
    const calculated = await completeQuoteCalculation(research.responseText, mode, async prompt => {
      const next = await runGpt({ type:'GPT_RUN', url:chatUrl, prompt: prompt + followupPrompt(followupContext), skill, active:foreground, ensureThinking:false });
      if (!next?.ok) throw new Error(next?.error ?? '报价核算后的整理失败');
      if (typeof next.chatUrl !== 'string' || next.chatUrl.split('#')[0] !== chatUrl.split('#')[0]) throw new Error('核算后的会话身份变化，未保存或展示报价');
      messageId = next.messageId;
      return next.responseText;
    });
    if (calculated.input && calculated.result) {
      await saveQuoteVersion(supabase, orgId, contact.id, crypto.randomUUID(), {
        schema:'quote-calculation.v1', scopeId, parentId:memory.quoteVersions?.at(-1)?.id ?? null,
        status:'draft', authority:'arithmetic_verified_inputs_require_sources', input:calculated.input, result:calculated.result,
        summary:calculated.result.map(p => `${p.label}: USD ${p.totalUsd}总额 / ${p.perVehicleUsd}每台`).join('；'),
        chatUrl, computedAt:new Date().toISOString(),
      });
    }
    // A ready customer draft must not wait for another web round solely to fill task metadata.
    const outcome = await completeFollowupResult(calculated.text, followupContext, null,
      decision => saveFollowup(supabase, followupContext, decision, templateId, chatUrl));
    const finalText = outcome.text;
    await saveSalesWorkEntry(supabase, orgId, contact.id, {
      id: crypto.randomUUID(), scopeId, kind: 'assistant_draft', text:finalText, templateId, chatUrl,
    });
    const conversationId = quoteConversationId(chatUrl);
    if (mode === 'reply' && conversationId && messageId && calculated.result) {
      const reply = sanitizeReplyForCustomer(parseClaudeResponse(finalText).reply ?? '');
      try {
        await saveQuotePreview({ conversationId, messageId, reply,
          amounts: publicQuoteAmounts(calculated.result), savedAt: Date.now() });
      } catch {
        return { text: finalText, warning: [outcome.warning, '报价已保存在CRM；ChatGPT页面的金额展示未同步，请以本页报价为准。'].filter(Boolean).join('；') };
      }
    }
    return outcome;
  };

  // ── 主流程 1：写客户回复 ──

  const generate = async () => {
    if (actionLock.current || busy || backgroundBusy || !templatesLoaded || !guidanceLoaded) return;
    actionLock.current = true;
    setStatus({ kind: 'reading' });
    // 左栏那一行立刻显示「⏳ 生成中」——切走客户也还在，见 reply-progress
    void setReplyProgress(contact.id, 'generating', 'gpt');
    requestMetrics.current = { requests: 0, inputChars: 0, outputChars: 0 };
    const startedAt = Date.now();
    let promptForLog = '';
    let rawResponseForLog: string | null = null;
    let chatUrlForLog: string | null = null;
    let messageSourceForLog: MessageSource = 'dom';
    let messageCountForLog = 0;
    let wasFollowUp = false;
    const guidanceForLog = guidance.trim();
    // useCustomGpt 总是 true：模板化后所有调用都走用户自建的 Custom GPT URL，
    // 链接里的 instructions 已含 Miles 角色，不再重发 ROLE_PROMPT
    const useCustomGpt = true;
    try {
      const { messages, source: messageSource, vehicleInterests, template, approvedKnowledge, workMemory, conversation, followupContext } = await loadActionContext();
      wasFollowUp = !!conversation;
      const isGroup = !!contact.group_jid;
      const groupMemberNames = isGroup && !conversation ? await loadGroupMemberNames(contact.group_jid) : undefined;
      const url = conversation?.chat_url ?? template.gpt_url;
      let prompt = conversation
        ? buildFollowUpMessage({
            newMessages: messages.slice(-50),
            isGroup,
            salesGuidance: guidance.trim() || undefined,
            approvedKnowledge,
            workMemory,
            contact,
            vehicleInterests,
          })
        : buildFirstMessage({
            contact,
            vehicleInterests,
            messages,
            groupMemberNames,
            salesGuidance: guidance.trim() || undefined,
            approvedKnowledge,
            workMemory,
            useCustomGpt,
          });
      prompt += followupPrompt(followupContext, { includedRenderedMessages: chatHistoryEvidence(conversation ? messages.slice(-50) : messages), includedWorkMemory: workMemory, includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes });
      promptForLog = prompt;
      messageSourceForLog = messageSource;
      messageCountForLog = messages.length;

      setStatus({
        kind: 'sending',
        foreground,
        mode: 'reply',
        source: messageSource,
        count: messages.length,
        templateName: template.name,
      });
      const response = await runGpt({
        type: 'GPT_RUN',
        url,
        prompt,
        skill: approvedKnowledge?.skill,
        active: foreground,
        // Custom GPT 里已设了模型；默认 URL 也带了 ?model=gpt-5-thinking query param。
        // ensureThinking 是 DOM 点击切换的保险路径，默认不开（避免误点）。
        ensureThinking: false,
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? 'GPT 调用失败');
      }

      rawResponseForLog = response.responseText;
      chatUrlForLog = response.chatUrl;
      const newChatUrl: string = response.chatUrl;
      if (!isConversationForGptTemplate({contact_id: contact.id, template_id: template.id, chat_url: newChatUrl}, contact.id, template)) {
        throw new Error('GPT返回的会话与本次模板不匹配，未保存工作记录。');
      }
      const savedWork = await saveGeneratedWork(response.responseText, newChatUrl, template, workMemory, 'reply', followupContext, approvedKnowledge?.skill, response.messageId);
      response.responseText = savedWork.text;
      await saveConversation(template, newChatUrl);
      const savedMemory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) { setWorkMemory(savedMemory); setMemoryError(''); }

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: conversation ? 'gpt_followup' : 'gpt_first',
        prompt,
        response: response.responseText,
        guidance: guidanceForLog || null,
        messageSource,
        messageCount: messages.length,
        chatUrl: newChatUrl,
        durationMs: Date.now() - startedAt,
        metrics: { ...requestMetrics.current },
      });

      void setReplyProgress(contact.id, 'ready', 'gpt');

      freshResult.current = { templateId: template.id, chatUrl: newChatUrl };
      setStatus({
        kind: 'done',
        mode: 'reply',
        followupWarning: savedWork.warning,
        inputEvidence: snapshotDraftEvidence(messages),
        text: response.responseText,
        chatUrl: newChatUrl,
        source: messageSource,
        count: messages.length,
        logId,
        templateId: template.id,
        templateName: template.name,
      });
      setGuidance('');
    } catch (err) {
      const msg = stringifyError(err);
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: wasFollowUp ? 'gpt_followup' : 'gpt_first',
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        response: rawResponseForLog,
        chatUrl: chatUrlForLog,
        guidance: guidanceForLog || null,
        messageSource: messageSourceForLog,
        messageCount: messageCountForLog,
        durationMs: Date.now() - startedAt,
        metrics: { ...requestMetrics.current },
        error: msg,
      });
      if (msg.includes('GPT_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message:
            '需要先登录 ChatGPT。请打开 https://chatgpt.com 登录后再试（同一个 Chrome profile 即可）。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
      void clearReplyProgress(contact.id);
    } finally {
      actionLock.current = false;
    }
  };

  // ── 主流程 2：跟 GPT 讨论这客户 ──

  const sendDiscussion = async () => {
    const q = discuss.trim();
    if (!q || actionLock.current || busy || backgroundBusy || !templatesLoaded || !guidanceLoaded) return;
    actionLock.current = true;
    setStatus({ kind: 'reading' });
    void setReplyProgress(contact.id, 'generating', 'gpt');
    requestMetrics.current = { requests: 0, inputChars: 0, outputChars: 0 };
    const startedAt = Date.now();
    let promptForLog = '';
    let rawResponseForLog: string | null = null;
    let chatUrlForLog: string | null = null;
    let sourceForLog: MessageSource = 'dom';
    let countForLog = 0;
    const useCustomGpt = true;
    try {
      const { messages, source, vehicleInterests, template, approvedKnowledge, workMemory, conversation, followupContext } = await loadActionContext(q);
      const url = conversation?.chat_url ?? template.gpt_url;
      let prompt: string;
      const count = messages.length;
      if (!conversation) {
        // 第一次讨论 — 带客户上下文 + 历史
        const isGroup = !!contact.group_jid;
        const groupMemberNames = isGroup ? await loadGroupMemberNames(contact.group_jid) : undefined;
        prompt = buildDiscussionMessage({
          ctx: {
            contact,
            vehicleInterests,
            messages,
            groupMemberNames,
            useCustomGpt,
          },
          question: q,
          approvedKnowledge,
          workMemory,
        });
      } else {
        // 续聊讨论也要补发最近 50 条 — GPT 那边 chat thread 看到的只是
        // 上一次 generate 时的历史快照，之后客户陆续发的新消息（最新预算 /
        // 改车型 / 发图）没人喂给它，必须在本次 prompt 里补上。
        // 同时带精简客户档案，防 thread 长后 GPT 忘客户 anchor。
        prompt = buildDiscussionMessage({
          newMessages: messages.slice(-50),
          isGroup: !!contact.group_jid,
          question: q,
          approvedKnowledge,
          workMemory,
          contact,
          vehicleInterests,
        });
      }
      prompt += followupPrompt(followupContext, { includedRenderedMessages: chatHistoryEvidence(conversation ? messages.slice(-50) : messages), includedWorkMemory: workMemory, includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes });
      promptForLog = prompt;
      sourceForLog = source;
      countForLog = count;

      setStatus({
        kind: 'sending',
        foreground,
        mode: 'discuss',
        source,
        count,
        templateName: template.name,
      });
      const response = await runGpt({
        type: 'GPT_RUN',
        url,
        prompt,
        skill: approvedKnowledge?.skill,
        active: foreground,
        ensureThinking: false,
      });
      if (!response?.ok) throw new Error(response?.error ?? 'GPT 调用失败');

      rawResponseForLog = response.responseText;
      chatUrlForLog = response.chatUrl;
      const newChatUrl: string = response.chatUrl;
      if (!isConversationForGptTemplate({contact_id: contact.id, template_id: template.id, chat_url: newChatUrl}, contact.id, template)) {
        throw new Error('GPT返回的会话与本次模板不匹配，未保存工作记录。');
      }
      const savedWork = await saveGeneratedWork(response.responseText, newChatUrl, template, workMemory, 'discuss', followupContext, approvedKnowledge?.skill, response.messageId);
      response.responseText = savedWork.text;
      await saveConversation(template, newChatUrl);
      const savedMemory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) { setWorkMemory(savedMemory); setMemoryError(''); }

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: 'gpt_discuss',
        prompt,
        response: response.responseText,
        guidance: q,
        messageSource: source,
        messageCount: count,
        chatUrl: newChatUrl,
        durationMs: Date.now() - startedAt,
        metrics: { ...requestMetrics.current },
      });
      void setReplyProgress(contact.id, 'ready', 'gpt');
      freshResult.current = { templateId: template.id, chatUrl: newChatUrl };
      setStatus({
        kind: 'done',
        mode: 'discuss',
        followupWarning: savedWork.warning,
        text: response.responseText,
        chatUrl: newChatUrl,
        source,
        count,
        logId,
        templateId: template.id,
        templateName: template.name,
      });
      setDiscuss('');
    } catch (err) {
      const msg = stringifyError(err);
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: 'gpt_discuss',
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        response: rawResponseForLog,
        chatUrl: chatUrlForLog,
        guidance: q,
        messageSource: sourceForLog,
        messageCount: countForLog,
        durationMs: Date.now() - startedAt,
        metrics: { ...requestMetrics.current },
        error: msg,
      });
      if (msg.includes('GPT_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message: '需要先登录 ChatGPT。打开 https://chatgpt.com 登录后再试。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
      void clearReplyProgress(contact.id);
    } finally {
      actionLock.current = false;
    }
  };

  const reset = async () => {
    if (!existingConv || !selectedTemplate || actionLock.current || busy || backgroundBusy) return;
    if (!confirm('清除此客户在此 Custom GPT 上的对话？下次将开新对话。')) return;
    actionLock.current = true;
    try {
      const { error } = await supabase
        .from('gpt_conversations')
        .delete()
        .eq('id', existingConv.id)
        .eq('contact_id', contact.id)
        .eq('template_id', selectedTemplate.id);
      if (error) throw new Error(`清除 GPT 会话失败：${stringifyError(error)}`);
      await refreshConversations();
      freshResult.current = null;
      setStatus({ kind: 'idle' });
      setDiscuss('');
    } catch (error) {
      setStatus({ kind: 'error', message: stringifyError(error) });
    } finally {
      actionLock.current = false;
    }
  };

  const parsed = useMemo(
    () =>
      status.kind === 'done' && status.mode === 'reply'
        ? parseClaudeResponse(status.text)
        : null,
    [status],
  );

  const isFreshResult = status.kind === 'done'
    && freshResult.current?.templateId === status.templateId
    && freshResult.current?.chatUrl === status.chatUrl
    && templates.some((template) => template.id === status.templateId
      && isConversationForGptTemplate({
        contact_id: contact.id,
        template_id: template.id,
        chat_url: status.chatUrl,
      }, contact.id, template));
  const staleResult = status.kind === 'done' && templatesLoaded && !isFreshResult && (
    !selectedTemplate || !isConversationForGptTemplate({
      contact_id: contact.id,
      template_id: status.templateId ?? selectedTemplate.id,
      chat_url: status.chatUrl,
    }, contact.id, selectedTemplate)
  );

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const fillReply = async (text: string) => {
    try {
      if (!templatesLoaded || !guidanceLoaded) {
        alert('正在核对当前客户与模板，请稍后再填入。');
        return;
      }
      if (!routeContext) {
        alert('尚未核对当前客户的车型，请重新生成以确认回复模板后再填入。');
        return;
      }
      if (staleResult) {
        alert('旧模板生成，请使用当前模板重新生成后再填入。');
        return;
      }
      const wasDirty = wasReplyDirty(text);
      const cleanText = sanitizeReplyForCustomer(text);
      if (!cleanText) {
        alert('回复为空（GPT 没生成有效的 [WhatsApp Reply] 段）');
        return;
      }
      if (wasDirty) {
        const ok = confirm(
          'GPT 的回复里夹了内部段落（[Strategy] / 备注 之类），已自动剥掉。确认要把净化后的版本发给客户？',
        );
        if (!ok) return;
      }
      if (needsJump) {
        const query = contact.phone
          ? contact.phone.replace(/^\+/, '')
          : contact.name?.trim() || contact.wa_name?.trim() || '';
        if (query) {
          const ok = await jumpToChat(query, { allowDeepLink: true });
          if (!ok) {
            alert('未能跳转到该聊天，请先手动打开后再点填入');
            return;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      const ok = fillWhatsAppCompose(cleanText);
      if (!ok) {
        alert('找不到 WhatsApp 输入框，请确认聊天已打开');
        return;
      }
      const logId = status.kind === 'done' ? status.logId : null;
      if (logId) {
        void markAiReplyFilled(logId);
      }
      // 归因 attribution：记下这次填入，syncMessages 写出站消息时匹配文本来标 ai_source
      void recordFill({ contactId: contact.id, source: 'gpt', text: cleanText, logId });
    } catch (err) {
      alert(stringifyError(err));
    }
  };

  const replyProgress = useReplyProgress();

  const busy = status.kind === 'reading' || status.kind === 'sending';

  /**

   * 后台还在跑同一个客户的生成。

   *

   * usePersistedReplyStatus 只持久化 done，reading/sending 是 transient ——

   * 所以切走客户再切回来，本地 status 是 idle，生成按钮又可点了，而 SW 那边

   * 其实还在跑（结果会写进旧 contact 的 storage key，不会丢）。不拦的话销售

   * 一并发就容易对同一个人点两次，白烧一次 40-50 秒。

   * reply-progress 是跨组件、跨 mount 的，正好补这个洞。

   */

  const bgPhase = replyProgress[contact.id]?.phase;

  const backgroundBusy = bgPhase === 'generating' && !busy;

  const actionUnavailable = busy || backgroundBusy || !templatesLoaded || !guidanceLoaded;
  const generationUnavailable = actionUnavailable || !selectedTemplate || !!previewRoute.error;
  const discussionRoute = resolveGptTemplateRoute(templates, selectedTemplateId, {
    messages: routeContext?.messages ?? [],
    vehicleInterests: routeContext?.vehicleInterests ?? [],
    salesGuidance: guidance,
    discussionQuestion: discuss,
    manualTemplateId,
  });


  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">
          🧠 GPT AI 回复{' '}
          {selectedTemplate && (
            <span
              className="sgc-muted"
              style={{ fontSize: 11, fontWeight: 400 }}
            >
              · {selectedTemplate.name}
            </span>
          )}
        </div>
        <div className="sgc-section-actions">
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setShowTemplates(true)}
          >
            管理模板
          </button>
        </div>
      </div>

      {setupError && <div className="sgc-error">{setupError}</div>}
      {routeContextError && <div className="sgc-muted">{routeContextError}</div>}
      {templatesLoaded && previewRoute.error && (
        <div className="sgc-error">{previewRoute.error}</div>
      )}
      {templatesLoaded && !manualTemplateId && previewRoute.isR08 && selectedTemplate && (
        <div className="sgc-gem-progress">
          已自动匹配 R08 专用模板：{selectedTemplate.name} · {previewRoute.reason}
        </div>
      )}
      {manualTemplateId && (
        <div className="sgc-gem-progress">
          已手动选择：{selectedTemplate?.name ?? '模板不可用'}
          {' · '}
          <button
            type="button"
            className="sgc-btn-link"
            disabled={actionUnavailable}
            onClick={() => {
              freshResult.current = null;
              void chrome.storage.local.remove(manualTemplateKey);
              setManualTemplateId(undefined);
              setSelectedTemplateId('');
            }}
          >
            恢复自动匹配
          </button>
        </div>
      )}

      {!templatesLoaded ? (
        <div className="sgc-empty">正在读取 GPT 模板…</div>
      ) : templates.length === 0 ? (
        <div className="sgc-empty">
          还没有 Custom GPT 模板。
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setShowTemplates(true)}
          >
            添加模板
          </button>
          <div
            className="sgc-muted"
            style={{ fontSize: 11, marginTop: 6 }}
          >
            可填 chatgpt.com/g/g-xxx 自建 GPT URL，或填默认{' '}
            <code>https://chatgpt.com/?model=gpt-5-thinking</code> 直接用 Thinking 模型
          </div>
        </div>
      ) : (
        <div className="sgc-gem-section">
          <div className="sgc-gem-controls">
            <select
              value={selectedTemplate?.id ?? ''}
              onChange={(e) => {
                freshResult.current = null;
                setSelectedTemplateId(e.target.value);
                setManualTemplateId(e.target.value);
                void chrome.storage.local.set({ [manualTemplateKey]: e.target.value });
              }}
              disabled={actionUnavailable}
              aria-label="GPT 模板"
            >
              {!selectedTemplate && <option value="">请选择可用模板</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_default ? ' · 默认' : ''}
                </option>
              ))}
            </select>
            <label
              className="sgc-checkbox-row"
              style={{ marginBottom: 0, fontSize: 12 }}
              title="开启后会切到 ChatGPT 标签页便于调试"
            >
              <input
                type="checkbox"
                checked={foreground}
                onChange={(e) => toggleForeground(e.target.checked)}
              />
              <span>前台</span>
            </label>
            <button
              type="button"
              className="sgc-btn-primary"
              onClick={() => generate()}
              disabled={generationUnavailable}
            >
              {busy
                ? status.kind === 'reading'
                  ? '读取聊天…'
                  : status.kind === 'sending' && status.mode === 'reply'
                    ? '🧠 GPT 思考中…'
                    : '处理中…'
                : existingConv
                  ? '续聊生成'
                  : '生成'}
            </button>
          </div>

          {/* 销售指令（per-contact 持久化） */}
          <div className="sgc-gem-guidance" style={{ marginTop: 12 }}>
            <div
              className="sgc-section-title"
              style={{ fontSize: 12, marginBottom: 4 }}
            >
              🎯 想让 GPT 怎么回？（可选）
            </div>
            <textarea
              value={guidance}
              onChange={(e) => updateGuidance(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!generationUnavailable) void generate();
                }
              }}
              placeholder="可选 · Cmd/Ctrl+Enter 直接生成
例：用法语回 / 客气一点 / 强调 1 万定金锁车 / 直接报 35k USD / 别问太多问题"
              rows={3}
              disabled={actionUnavailable}
            />
          </div>

          <SalesFactsPanel key={contact.id} orgId={orgId} contactId={contact.id} disabled={actionUnavailable} />
          {preferenceNotice && <p role="status" style={{ fontSize: 12 }}>{preferenceNotice}</p>}
          {!!workMemory?.preferences?.length && <details style={{ marginTop: 10 }}>
            <summary>已记住的回复偏好 · {workMemory.preferences.filter(p => p.active).length} 条</summary>
            <p style={{ fontSize: 12 }}>明确的语气和表达习惯会自动记住；价格与本轮操作仍保留在本单记录。个人通用偏好仅对你生效。</p>
            {workMemory.preferences.map(p => <div key={p.id} style={{ fontSize: 12, marginBottom: 8, opacity: p.active ? 1 : 0.6 }}>
              <span>{p.scope === 'personal' ? '我的通用偏好' : p.scope === 'customer' ? '此客户' : '本单'} · {p.text}{p.active ? '' : '（已撤销）'}</span>
              <button type="button" className="sgc-btn-link" disabled={actionUnavailable} onClick={() => void revisePreference(p)}>{p.active ? '撤销' : '恢复'}</button>
              {p.active && <select aria-label={`偏好作用范围：${p.text}`} value={p.scope} disabled={actionUnavailable}
                onChange={e => void revisePreference(p, e.target.value as PreferenceScope)}>
                <option value="order">本单</option><option value="customer">此客户</option><option value="personal">我的所有客户</option>
              </select>}
            </div>)}
          </details>}
          {!!workMemory?.quarantinedGuidance?.length && <details style={{ marginTop: 10 }}>
            <summary>已隔离的历史指导 · {workMemory.quarantinedGuidance.length} 条</summary>
            {workMemory.quarantinedGuidance.map(e => <div key={e.id} style={{ fontSize: 12, marginBottom: 8 }}>
              <p>{e.reason}</p><details><summary>查看原始记录（保留原归档）</summary><p style={{ whiteSpace: 'pre-wrap' }}>{String(e.payload.text ?? '')}</p></details>
            </div>)}
          </details>}

          <details style={{ marginTop: 10 }}>
            <summary>本单记忆 · {workMemory?.label ?? '读取中'} · {workMemory?.entries.filter(e => e.kind !== 'scope').length ?? 0} 条记录</summary>
            <p style={{ fontSize: 12 }}>销售补充和讨论会保存到此客户，下次生成及新建对话自动读取。草稿仅供参考，不代表已批准或已发送。</p>
            {memoryError && <div className="sgc-error">{memoryError}</div>}
            {workMemory?.entries.filter(e => e.kind !== 'assistant_draft' && e.kind !== 'scope').map(e => (
              <div key={e.id} style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                <small>{new Date(e.at).toLocaleString()} · {e.kind === 'sales_discussion' ? '内部讨论' : e.kind === 'freight_lookup' ? '运费查询记录' : '销售补充'}</small><br />{e.text}
              </div>
            ))}
            {!!workMemory?.historicalGuidance?.length && <details>
              <summary>历史对话指导 · {workMemory.historicalGuidance.length} 条（按原单核对）</summary>
              {workMemory.historicalGuidance.map(e => <div key={e.id} style={{ fontSize:12, whiteSpace:'pre-wrap', margin:'8px 0' }}>
                <span>{String(e.payload.sourceAt ?? '')} · </span>
                <a href={String(e.payload.sourceChatUrl ?? '')} target="_blank" rel="noreferrer">原对话</a>
                <div>{String(e.payload.text ?? '')}</div>
              </div>)}
            </details>}
            {!!workMemory?.quoteVersions?.length && <details>
              <summary>报价核算历史 · {workMemory.quoteVersions.length} 版（草稿，未发送）</summary>
              {[...workMemory.quoteVersions].reverse().map(e => <div key={e.id} style={{ fontSize:12, whiteSpace:'pre-wrap', margin:'8px 0' }}>
                <div>{new Date(e.at).toLocaleString()} · {String(e.payload.summary ?? '')}</div>
                <details><summary>费用、来源及计算明细</summary><pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify({input:e.payload.input,result:e.payload.result},null,2)}</pre></details>
              </div>)}
            </details>}
            {!!workMemory?.tasks.length && <p style={{ fontSize: 12 }}>每次同时读取 {workMemory.tasks.length} 项未完成CRM任务。</p>}
            <input aria-label="另一笔需求名称" placeholder="另一笔需求名称（例如：第二批两台柴油车）" value={newDemand}
              onChange={e => setNewDemand(e.target.value)} disabled={actionUnavailable} />
            <button type="button" className="sgc-btn-link" onClick={() => void startDemand()}
              disabled={actionUnavailable || !newDemand.trim()}>开始另一笔需求</button>
            <p style={{ fontSize: 11 }}>开始另一笔需求会保留旧记录，新需求不沿用旧单条件。仅清除ChatGPT对话则保留本单记忆。</p>
          </details>

          {/* 续聊状态 */}
          {existingConv && (
            <div className="sgc-gem-progress">
              已有对话 · 最近使用 {new Date(existingConv.last_used_at).toLocaleString()}
              <a
                className="sgc-btn-link"
                href={existingConv.chat_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: 8 }}
                title="在新标签页打开此客户在 ChatGPT 上的对话"
              >
                🔗 打开 ChatGPT
              </a>
              <button
                type="button"
                className="sgc-btn-link sgc-btn-danger-link"
                onClick={reset}
                disabled={actionUnavailable}
                style={{ marginLeft: 8 }}
              >
                清除并新建
              </button>
            </div>
          )}
      {backgroundBusy && (
        <div className="sgc-gem-progress">
          ⏳ 这个客户的回复正在后台生成 —— 可以先去处理别的客户，好了左栏那一行会变成「📝 待填入」
        </div>
      )}

          {status.kind === 'sending' && (
            <div className="sgc-gem-progress">
              {status.source === 'db' && (
                <>📜 用导入的历史记录（{status.count} 条）·{' '}</>
              )}
              {status.source === 'guidance' && (
                <>📝 仅按销售指令冷启动 ·{' '}</>
              )}
              正在{status.foreground ? '前台' : '后台'}打开 ChatGPT 并
              {status.mode === 'discuss' ? '发送讨论' : '生成回复'}… · {status.templateName}
            </div>
          )}

          {status.kind === 'error' && (
            <div className="sgc-error">{status.message}</div>
          )}

          {status.kind === 'done' && status.followupWarning && (
            <div role="status" className="sgc-gem-error">{status.followupWarning}</div>
          )}

          {status.kind === 'done' && (
            <>
              <GeneratedAtBadge generatedAt={status.generatedAt} />
              <DraftFreshnessNotice evidence={status.inputEvidence} identity={{ phone: contact.phone, name: contact.name, waName: contact.wa_name, groupJid: contact.group_jid }} />
              {status.templateName && (
                <div className="sgc-muted" style={{ fontSize: 11 }}>生成模板：{status.templateName}</div>
              )}
              {staleResult && (
                <div className="sgc-error">旧模板生成，请重新生成。下方保留历史结果供核对。</div>
              )}
            </>
          )}

          {status.kind === 'done' && status.mode === 'reply' && parsed && (
            <ResultView
              parsed={parsed}
              source={status.source}
              count={status.count}
              chatUrl={status.chatUrl}
              contact={contact}
              onFillReply={fillReply}
              onCopy={copyToClipboard}
            />
          )}

          {status.kind === 'done' && status.mode === 'discuss' && (
            <DiscussionResultView
              text={status.text}
              chatUrl={status.chatUrl}
              onCopy={copyToClipboard}
            />
          )}

          {/* 讨论框（永远显示在底部） */}
          <div className="sgc-gem-guidance" style={{ marginTop: 14 }}>
            <div
              className="sgc-section-title"
              style={{ fontSize: 12, marginBottom: 4 }}
            >
              💬 跟 GPT 讨论这客户
              {!existingConv && (
                <span
                  className="sgc-muted"
                  style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}
                >
                  （首次发送会带上客户聊天历史）
                </span>
              )}
            </div>
            <textarea
              value={discuss}
              onChange={(e) => setDiscuss(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!actionUnavailable && discussionRoute.template && !discussionRoute.error && discuss.trim()) {
                    void sendDiscussion();
                  }
                }
              }}
              placeholder={
                existingConv
                  ? '例：他这句话什么意思 / 如果对方嫌贵怎么办 / 这个客户值不值得继续追'
                  : '例：先帮我分析这客户 / 这单值不值得追 / 怎么破他的"再考虑考虑"'
              }
              rows={2}
              disabled={actionUnavailable}
            />
            {discuss.trim() && discussionRoute.error && (
              <div className="sgc-error">{discussionRoute.error}</div>
            )}
            {discuss.trim() && discussionRoute.template?.id !== selectedTemplate?.id && discussionRoute.template && (
              <div className="sgc-muted" style={{ fontSize: 11 }}>
                本次讨论将使用：{discussionRoute.template.name}
              </div>
            )}
            <div className="sgc-gem-result-actions">
              <button
                type="button"
                className="sgc-btn-secondary"
                onClick={() => sendDiscussion()}
                disabled={actionUnavailable || !discussionRoute.template || !!discussionRoute.error || !discuss.trim()}
              >
                {busy ? '处理中…' : '💬 发送讨论（Cmd/Ctrl+Enter）'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTemplates && (
        <GPTTemplatesModal
          orgId={orgId}
          onClose={async () => {
            setShowTemplates(false);
            await refreshTemplates();
          }}
        />
      )}
    </section>
  );
}

// ── ResultView（reply 模式：三段解析） ──

interface ResultViewProps {
  parsed: ReturnType<typeof parseClaudeResponse>;
  source: MessageSource;
  count: number;
  chatUrl: string;
  contact: ContactRow;
  onFillReply: (text: string) => void;
  onCopy: (text: string) => void;
}

function ResultView({
  parsed,
  source,
  count,
  chatUrl,
  contact,
  onFillReply,
  onCopy,
}: ResultViewProps) {
  return (
    <>
      {source === 'db' && (
        <div className="sgc-gem-progress">
          ✅ 基于导入的历史记录（{count} 条）
        </div>
      )}
      {source === 'guidance' && (
        <div className="sgc-gem-progress">
          📝 仅按销售指令冷启动生成（无聊天历史）
        </div>
      )}

      {parsed.reply && (
        <ReplyCard
          label="💬 给客户的回复"
          reply={parsed.reply}
          existingTranslation={parsed.translation}
          onFillReply={onFillReply}
          onCopy={onCopy}
        />
      )}

      {!parsed.reply && parsed.translation && (
        <div
          className="sgc-gem-card"
          style={{ background: '#fffbeb', borderColor: '#fde68a' }}
        >
          <div className="sgc-gem-card-label">💡 内部处理说明（不发送给客户）</div>
          <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
            {parsed.translation}
          </div>
        </div>
      )}

      {parsed.strategy && (
        <div
          className="sgc-gem-card"
          style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}
        >
          <div className="sgc-gem-card-label">💡 销售策略</div>
          <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
            {parsed.strategy}
          </div>
        </div>
      )}

      {parsed.clientRecord && (
        <ClientRecordCard
          record={parsed.clientRecord}
          contact={contact}
          source="gpt"
        />
      )}

      <details className="sgc-gem-raw-toggle">
        <summary>查看完整原始响应</summary>
        <div className="sgc-gem-result">{parsed.raw}</div>
      </details>

      <div className="sgc-gem-result-actions">
        <a
          className="sgc-btn-link"
          href={chatUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在 ChatGPT 打开此对话
        </a>
      </div>
    </>
  );
}

// ── DiscussionResultView（discuss 模式：自由中文文本） ──

function DiscussionResultView({
  text,
  chatUrl,
  onCopy,
}: {
  text: string;
  chatUrl: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div
      className="sgc-gem-card"
      style={{ background: '#fff7ed', borderColor: '#fed7aa' }}
    >
      <div className="sgc-gem-card-label">🧠 GPT 的分析</div>
      <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
      <div className="sgc-gem-result-actions">
        <button
          type="button"
          className="sgc-btn-secondary"
          onClick={() => onCopy(text)}
        >
          📋 复制
        </button>
        <a
          className="sgc-btn-link"
          href={chatUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在 ChatGPT 继续
        </a>
      </div>
    </div>
  );
}
