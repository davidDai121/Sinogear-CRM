import { loadGptBrowserBinding, templateOwner, browserAllowsTemplate, gptManualTemplateKey, type GptBrowserBinding } from '@/lib/gpt-browser-binding';
import { bindTaskToDraft } from '@/lib/task-send-completion';
import { parseGptResponse, normalizeGptReply } from '@/lib/gpt-reply-state';
import type { ReplyMetrics } from '@/lib/ai-reply-log';
import { quoteConversationId, saveQuotePreview } from '@/lib/quote-preview';
import { snapshotDraftEvidence, type DraftEvidence } from '@/lib/draft-freshness';
import { DraftFreshnessNotice } from './DraftFreshnessNotice';
import { completeFollowupResult, followupProse } from '@/lib/gpt-followup-result';
import { preserveFollowupTasks, translationOnlyRequested, PRESERVE_TASKS_NOTE, TRANSLATION_ONLY_NOTE } from '@/lib/gpt-request-scope';
import { resolveContextLayer, followupContractRequested, threadEndsWithDiscussion } from '@/lib/gpt-context-layer';
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
import { jumpToChat, verifyHeaderMatches } from '@/lib/jump-to-chat';
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
import { makeCrmFreightResolver } from '@/lib/crm-freight';
import { extractFreightResearch } from '@/lib/freight-research';
import { loadPersonalSalesWorkMemory as loadSalesWorkMemory, saveSalesWorkEntry, type SalesWorkMemory } from '@/lib/sales-work-memory';
import { rememberSalesPreferences, saveSalesPreference, type SalesPreference, type PreferenceScope } from '@/lib/sales-preferences';
import { loadGptApprovedKnowledge } from '@/lib/gpt-template-knowledge';
import { resolveGptTemplateRoute, isConversationForGptTemplate, splitsCustomerMessages } from '@/lib/gpt-template-routing';
import { loadApplicableSalesFacts, omitTemplateSourcedFacts } from '@/lib/sales-facts';
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
      requestId?: string;
      followupWarning?: string;
      /** The draft is shown before follow-up/work saving finishes; see ClientRecordCard autoApply. */
      saving?: boolean;
      inputEvidence?: DraftEvidence;
    }
  | { kind: 'error'; message: string };

interface PendingGptAction {
  requestId: string;
  orgId: string;
  contactId: string;
  mode: Mode;
  template: GptTemplateRow;
  workMemory: SalesWorkMemory;
  followupContext: FollowupContext;
  skill?: GptSkill;
  source: MessageSource;
  count: number;
  prompt: string;
  guidance: string | null;
  startedAt: number;
  /** 本轮是否注入了跟进契约（gpt-context-layer.ts）。false = 保存时 preserveExisting，不动任务。旧记录缺此字段时按 guidance 兜底判定。 */
  followupContract?: boolean;
  wasFollowUp?: boolean;
  inputEvidence?: DraftEvidence;
  metrics?: ReplyMetrics;
  prepared?: { chatUrl: string; calculated: Awaited<ReturnType<typeof completeQuoteCalculation>>; research: ReturnType<typeof extractFreightResearch>; messageId?: string; at: string; freightId: string; quoteId: string; draftId: string };
  savedWork?: Awaited<ReturnType<typeof completeFollowupResult>>;
}

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
  const [browserBinding, setBrowserBinding] = useState<GptBrowserBinding | null>(null);
  const [conversations, setConversations] = useState<GptConvRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  // The keyed customer component prevents a manual choice leaking to another contact.
  const [manualTemplateId, setManualTemplateId] = useState<string>();
  const [showTemplates, setShowTemplates] = useState(false);
  const [foreground, setForeground] = useState(false);
  const [modelPreparation, setModelPreparation] = useState<string>();
  const [status, setStoredStatus] = usePersistedReplyStatus<Status>('gpt', contact.id, { kind: 'idle' });
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const setStatus = (next: Status | ((current: Status) => Status)) => {
    const value = typeof next === 'function' ? next(latestStatus.current) : next;
    latestStatus.current = value; setStoredStatus(value);
  };
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
  const requestMetrics = useRef<ReplyMetrics>({ requests: 0, inputChars: 0, outputChars: 0 });
  const activeRequestId = useRef<string>();
  const recoveryKey = `gpt.pendingAction:${orgId}:${contact.id}`;
  const [pendingAction, setPendingAction] = useState<PendingGptAction | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(recoveryKey).then(saved => {
      const action = saved[recoveryKey] as PendingGptAction | undefined;
      if (!cancelled) {
        if (action?.orgId === orgId && action.contactId === contact.id) setPendingAction(action);
        setRecoveryLoaded(true);
      }
    }).catch(error => { if (!cancelled) setStatus({ kind:'error', message:`读取生成记录失败，请刷新重试：${stringifyError(error)}` }); });
    return () => { cancelled = true; };
  }, [recoveryKey, orgId, contact.id]);
  const awaitGptResult = async (requestId: string, initial?: any) => {
    const started = Date.now();
    let result = initial ?? await chrome.runtime.sendMessage({type:'GPT_RESULT', requestId});
    while (result?.pending && Date.now() - started < 22 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { result = await chrome.runtime.sendMessage({type:'GPT_RESULT', requestId}); }
      catch { /* Poll the same request after a temporary channel interruption. */ }
      setModelPreparation(result?.preparation);
    }
    if (result?.pending) throw new Error('GPT 仍未交付，原会话和已完成结果会保留，请稍后取回结果');
    return result;
  };
  const runGpt = async (options: Record<string, unknown>, action?: Omit<PendingGptAction, 'requestId' | 'orgId' | 'contactId'>) => {
    requestMetrics.current.requests++;
    requestMetrics.current.inputChars += typeof options.prompt === 'string' ? options.prompt.length : 0;
    const requestId = crypto.randomUUID();
    if (action) {
      requestMetrics.current.prepareMs ??= Date.now() - action.startedAt;
      const saved = { ...action, requestId, orgId, contactId: contact.id, metrics: { ...requestMetrics.current } };
      // Save the customer binding and delivery context BEFORE sending. Refresh must
      // not lose the only pointer to a durable background result.
      activeRequestId.current = requestId;
      await chrome.storage.local.set({ [recoveryKey]: saved });
      setPendingAction(saved);
    }
    let initial;
    try { initial = await chrome.runtime.sendMessage({...options, requestId}); }
    catch { /* Poll, never resubmit an uncertain send. */ }
    const result = await awaitGptResult(requestId, initial);
    if (action && result?.ok === false) {
      await chrome.storage.local.remove(recoveryKey);
      setPendingAction(null);
    }
    if (result?.timing) {
      const t = result.timing;
      if (t.sentAt) {
        requestMetrics.current.pageMs = (requestMetrics.current.pageMs ?? 0) + t.sentAt - t.startedAt;
        requestMetrics.current.responseMs = (requestMetrics.current.responseMs ?? 0) + t.completedAt - t.sentAt;
      }
      requestMetrics.current.transferMs = (requestMetrics.current.transferMs ?? 0) + Math.max(0, Date.now() - t.completedAt);
    }
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
    setTemplatesLoaded(false);
    const { data, error } = await supabase
      .from('gpt_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (!mounted.current || request !== templateRequest.current) return;
    if (error) {
      setSetupError(`读取 GPT 模板失败：${stringifyError(error)}`);
      setTemplatesLoaded(false);
      return;
    }
    try {
      const rows = data ?? [];
      const binding = rows.length ? await loadGptBrowserBinding(orgId, templateOwner(rows)) : null;
      if (!mounted.current || request !== templateRequest.current) return;
      setBrowserBinding(binding);
      setSetupError('');
      setTemplates(rows);
      setTemplatesLoaded(true);
    } catch (e) {
      if (!mounted.current || request !== templateRequest.current) return;
      setSetupError(stringifyError(e));
      setTemplatesLoaded(false);
    }
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
      manualTemplateId, browserBinding,
    }),
    [templates, selectedTemplateId, routeContext, guidance, manualTemplateId, browserBinding],
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
        manualTemplateId, browserBinding,
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
  const manualTemplateKey = gptManualTemplateKey(orgId, contact.id, browserBinding);
  useEffect(() => {
    let cancelled = false;
    setGuidanceLoaded(false);
    if (!templatesLoaded) return;
    setManualTemplateId(undefined);
    freshResult.current = null;
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
  }, [guidanceKey, manualTemplateKey, templatesLoaded]);

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
    const currentBinding = await loadGptBrowserBinding(orgId, templateOwner(templates));
    if (JSON.stringify(currentBinding) !== JSON.stringify(browserBinding)) {
      await refreshTemplates();
      throw new Error('本浏览器 GPT 入口已改变，已重新加载，请再次生成。');
    }
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
      manualTemplateId, browserBinding,
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
    // 来源就是本模板、或原句已逐字在本轮 [Approved Business Knowledge] 里的事实，本轮不重发（表不动）。
    memory = { ...memory, factLibrary: omitTemplateSourcedFacts(await loadApplicableSalesFacts(supabase, {
      orgId, contactId: contact.id, scopeId: memory.scopeId, contact, messages: loaded.messages,
      vehicleInterests, salesGuidance: guidance, discussionQuestion, workMemory: memory,
    }), template.id, approvedKnowledge?.text) };
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

  const saveGeneratedWork = async (text: string, chatUrl: string, template: GptTemplateRow, memory: SalesWorkMemory, mode: Mode, followupContext: FollowupContext, skill: GptSkill | undefined, messageId: string | undefined, onReady: (text: string) => Promise<void>, pending: PendingGptAction) => {
    const templateId = template.id, scopeId = memory.scopeId;
    const research = pending.prepared?.research ?? extractFreightResearch(text);
    followupProse(research.responseText);
    const calculated = pending.prepared?.calculated ?? await completeQuoteCalculation(normalizeGptReply(research.responseText), mode, async prompt => {
      const next = await runGpt({ type:'GPT_RUN', url:chatUrl, prompt: prompt + followupPrompt(followupContext), skill, active:foreground, ensureThinking:false });
      if (!next?.ok) throw new Error(next?.error ?? '报价核算后的整理失败');
      if (typeof next.chatUrl !== 'string' || next.chatUrl.split('#')[0] !== chatUrl.split('#')[0]) throw new Error('核算后的会话身份变化，未保存或展示报价');
      messageId = next.messageId;
      return next.responseText;
    }, Date.now(), makeCrmFreightResolver(supabase, orgId, contact.country));
    if (!pending.prepared) {
      pending.metrics = { ...requestMetrics.current };
      pending.prepared = { chatUrl, calculated, research, messageId, at: new Date().toISOString(),
        freightId: crypto.randomUUID(), quoteId: crypto.randomUUID(), draftId: crypto.randomUUID() };
      await chrome.storage.local.set({ [recoveryKey]: pending });
    }
    const prepared = pending.prepared;
    messageId = prepared.messageId;
    // Present only validated prose; retry uses this durable calculation, never another GPT pass.
    if (!calculated.result) await onReady(followupProse(calculated.text));
    if (research.record) {
      await saveSalesWorkEntry(supabase, orgId, contact.id, {
        id: prepared.freightId, scopeId, kind: 'freight_lookup', templateId, chatUrl,
        text: JSON.stringify({ schema: 'freight-research.v1', recordedAt: prepared.at,
          status: 'model_research_unverified', bindingQuote: false, raw: research.record }),
      });
    }
    if (calculated.input && calculated.result) {
      await saveQuoteVersion(supabase, orgId, contact.id, prepared.quoteId, {
        schema:'quote-calculation.v1', scopeId, parentId:memory.quoteVersions?.at(-1)?.id ?? null,
        status:'draft', authority:'arithmetic_verified_inputs_require_sources', input:calculated.input, result:calculated.result,
        summary:calculated.result.map(p => `${p.label}: USD ${p.totalUsd}总额 / ${p.perVehicleUsd}每台`).join('；'),
        chatUrl, computedAt:prepared.at,
        ...(calculated.freightEstimates?.length ? { freightEstimates: calculated.freightEstimates } : {}),
      });
    }
    if (calculated.result) await onReady(followupProse(calculated.text));
    // A ready customer draft must not wait for another web round solely to fill task metadata.
    const outcome = pending.savedWork ?? await completeFollowupResult(calculated.text, followupContext, null,
      async decision => {
        const plan = await saveFollowup(supabase, followupContext, decision, templateId, chatUrl);
        await bindTaskToDraft(plan, sanitizeReplyForCustomer(parseGptResponse(calculated.text).reply ?? ''), followupContext);
        return plan;
      }, onReady, !(pending.followupContract ?? !preserveFollowupTasks(pending.guidance)));
    if (!outcome.retryable && !pending.savedWork) {
      pending.savedWork = outcome;
      await chrome.storage.local.set({ [recoveryKey]: pending });
    }
    if (outcome.retryable) return outcome;
    const finalText = outcome.text;
    await saveSalesWorkEntry(supabase, orgId, contact.id, {
      id: prepared.draftId, scopeId, kind: 'assistant_draft', text:finalText, templateId, chatUrl,
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

  const deliverGptResponse = async (response: any, action: Omit<PendingGptAction, 'requestId' | 'orgId' | 'contactId'>, requestId = activeRequestId.current) => {
    if (!response?.ok) throw new Error(response?.error ?? 'GPT 调用失败');
    const finalize = async () => {
      const pending = (await chrome.storage.local.get(recoveryKey))[recoveryKey] as PendingGptAction | undefined;
      if (!pending || pending.requestId !== requestId) {
        // Another mounted receiver already delivered this exact task. Never save it twice.
        const doneKey = `replyStatus:gpt:${contact.id}`;
        const done = (await chrome.storage.local.get(doneKey))[doneKey];
        if (done?.kind === 'done' && done.requestId === requestId) setStatus(done);
        if (mounted.current) setPendingAction(null);
        return;
      }
      const { template, workMemory: memory, mode, followupContext, skill } = action;
      const chatUrl: string = response.chatUrl;
      if (!isConversationForGptTemplate({ contact_id:contact.id, template_id:template.id, chat_url:chatUrl }, contact.id, template)) {
        throw new Error('GPT返回的会话与本次模板不匹配，未保存工作记录。');
      }
      const saveStarted = Date.now();
      const modelTime = () => (requestMetrics.current.pageMs ?? 0) + (requestMetrics.current.responseMs ?? 0) + (requestMetrics.current.transferMs ?? 0);
      const previousModelTime = modelTime();
      const showReady = async (text: string) => {
        const preview: Extract<Status, {kind:'done'}> = { kind:'done', mode, text, chatUrl, source:action.source,
          count:action.count, logId:null, templateId:template.id, templateName:template.name,
          inputEvidence:action.inputEvidence, followupWarning:'回复已就绪，正在保存跟进安排和工作记录…', saving:true, generatedAt:Date.now(), requestId };
        await chrome.storage.local.set({ [`replyStatus:gpt:${contact.id}`]: preview });
        setStatus(preview);
      };
      const savedWork = await saveGeneratedWork(response.responseText, chatUrl, template, memory, mode, followupContext, skill, response.messageId, showReady, pending);
      await saveConversation(template, chatUrl);
      const savedMemory = await loadSalesWorkMemory(supabase, orgId, contact.id);
      if (mounted.current) { setWorkMemory(savedMemory); setMemoryError(''); }
      requestMetrics.current.saveMs = Math.max(0, Date.now() - saveStarted - (modelTime() - previousModelTime));
      const logId = await logAiReply({ orgId, contactId:contact.id, source:'gpt',
        mode:mode === 'discuss' ? 'gpt_discuss' : action.wasFollowUp ? 'gpt_followup' : 'gpt_first',
        prompt:action.prompt, response:savedWork.text, guidance:action.guidance,
        messageSource:action.source, messageCount:action.count, chatUrl,
        durationMs:Date.now()-action.startedAt, metrics:{...requestMetrics.current} });
      freshResult.current = { templateId:template.id, chatUrl };
      const done: Extract<Status, {kind:'done'}> = { kind:'done', mode, text:savedWork.text, chatUrl, source:action.source,
        count:action.count, logId, templateId:template.id, templateName:template.name,
        inputEvidence:action.inputEvidence, followupWarning:savedWork.warning, generatedAt:Date.now(), requestId };
      await chrome.storage.local.set({ [`replyStatus:gpt:${contact.id}`]: done });
      setStatus(done);
      await setReplyProgress(contact.id, 'ready', 'gpt');
      if (!savedWork.retryable) {
        await chrome.storage.local.remove(recoveryKey);
        if (mounted.current) setPendingAction(null);
      }
    };
    // Both original and refreshed receivers may exist (including multiple WA tabs).
    // Serialize final delivery and recheck the durable request under the lock.
    if (navigator.locks) await navigator.locks.request(recoveryKey, finalize);
    else await finalize();
  };

  const recoverGptResult = async () => {
    if (!pendingAction || actionLock.current || busy) return;
    actionLock.current = true;
    if (status.kind !== 'done') setStatus({ kind:'reading' });
    try {
      const saved = (await chrome.storage.local.get(recoveryKey))[recoveryKey] as PendingGptAction | undefined;
      if (!saved || saved.requestId !== pendingAction.requestId || saved.orgId !== orgId || saved.contactId !== contact.id) {
        throw new Error('生成记录已变化，请刷新后检查');
      }
      const current = await loadFollowupContext(supabase, orgId, contact.id);
      if (current.userId !== saved.followupContext.userId || current.scopeId !== saved.followupContext.scopeId) {
        throw new Error('账号或本单需求已变化，未自动归入当前客户；请打开原ChatGPT会话核对');
      }
      const template = templates.find(t => t.id === saved.template.id);
      if (!template || template.gpt_url !== saved.template.gpt_url || template.description !== saved.template.description) {
        throw new Error('原生成模板已变化，未自动恢复，请检查原ChatGPT会话');
      }
      if (latestStatus.current.kind !== 'done') setStatus({ kind:'sending', foreground:false, mode:saved.mode, source:saved.source,
        count:saved.count, templateName:saved.template.name });
      // Recovery only polls the original request; it never invokes GPT_RUN.
      const response = saved.prepared ? { ok:true, responseText:saved.prepared.calculated.text,
        chatUrl:saved.prepared.chatUrl, messageId:saved.prepared.messageId, timing:undefined } : await awaitGptResult(saved.requestId);
      if (response?.ok === false) {
        await chrome.storage.local.remove(recoveryKey);
        await clearReplyProgress(contact.id);
        setPendingAction(null);
        throw new Error(response.error ?? 'GPT 任务已结束，未产生回复，可重新生成');
      }
      requestMetrics.current = saved.metrics ?? { requests: 1, inputChars: saved.prompt.length, outputChars: 0 };
      if (!saved.prepared) requestMetrics.current.outputChars = response?.responseText?.length ?? 0;
      if (response?.timing?.sentAt) { const t = response.timing; requestMetrics.current.pageMs = t.sentAt - t.startedAt; requestMetrics.current.responseMs = t.completedAt - t.sentAt; }
      await deliverGptResponse(response, saved, saved.requestId);
    } catch (err) {
      setStatus(current => current.kind === 'done' ? { ...current, saving:false, followupWarning: `保存未完成：${stringifyError(err)}` } : {kind:'error', message:stringifyError(err)});
    } finally { actionLock.current = false; }
  };

  const releaseRecoveryWait = async () => {
    if (!pendingAction || actionLock.current || busy) return;
    actionLock.current = true;
    try {
      // Keep the original binding for diagnosis/manual recovery. This releases
      // only this panel's wait; it does not cancel a remote ChatGPT generation.
      const latest = (await chrome.storage.local.get(recoveryKey))[recoveryKey] ?? pendingAction;
      await chrome.storage.local.set({ [`gpt.archivedAction:${pendingAction.requestId}`]: latest });
      await chrome.storage.local.remove(recoveryKey);
      await clearReplyProgress(contact.id);
      setPendingAction(null);
      setStatus(current => current.kind === 'done' ? { ...current, saving:false, followupWarning:'已保留正文并解除等待，未完成的保存请核对任务页。' } : {kind:'error', message:'已解除等待并保留原生成记录。这不会取消ChatGPT中的任务；再次生成前请先核对原会话。'});
    } catch (err) { setStatus(current => current.kind === 'done' ? { ...current, saving:false, followupWarning: `保存未完成：${stringifyError(err)}` } : {kind:'error', message:stringifyError(err)}); }
    finally { actionLock.current = false; }
  };

  // ── 主流程 1：写客户回复 ──

  const generate = async () => {
    if (actionLock.current || busy || backgroundBusy || !templatesLoaded || !guidanceLoaded || !recoveryLoaded) return;
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
      const { messages, source: messageSource, vehicleInterests, template, approvedKnowledge, workMemory, conversation: savedConversation, followupContext } = await loadActionContext();
      // 上一轮是讨论的会话不再续用：讨论里的“不要写客户回复 / 不安排跟进”会把生成轮带偏
      // （2026-09-23 Jaycee 实测）。改为带完整上下文另起新会话，成功后 saveConversation 覆盖旧 URL。
      const conversation = savedConversation && threadEndsWithDiscussion(workMemory.entries, savedConversation.chat_url) ? null : savedConversation;
      wasFollowUp = !!conversation;
      const isGroup = !!contact.group_jid;
      const groupMemberNames = isGroup && !conversation ? await loadGroupMemberNames(contact.group_jid) : undefined;
      const url = conversation?.chat_url ?? template.gpt_url;
      // A 层（无老板要求）全量；B 层（有老板要求）紧凑。见 gpt-context-layer.ts / 精简上下文方案。
      const layer = resolveContextLayer({ salesGuidance: guidance });
      const followupContract = followupContractRequested(guidance, 'reply');
      let prompt = conversation
        ? buildFollowUpMessage({
            // 完整消息：full 层构造函数自己取最近 50；compact 层要从更早的历史取价格/承诺锚点，先切 50 会丢
            newMessages: messages,
            isGroup,
            salesGuidance: guidance.trim() || undefined,
            approvedKnowledge,
            workMemory,
            contact,
            vehicleInterests,
            layer,
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
            layer,
          });
      // 跟进契约（2026-09-23 老板收窄）：生成客户回复一律带，由技能同轮判断要不要二次跟进；
      // compact 层带精简账本。老板说“不动任务 / 不安排跟进”才不注入，保存走 preserveExisting。
      if (!followupContract) {
        prompt += PRESERVE_TASKS_NOTE;
      } else {
        prompt += followupPrompt(followupContext, { includedRenderedMessages: chatHistoryEvidence(messages, layer), includedWorkMemory: workMemory, includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes, compact: layer === 'compact' });
      }
      if (translationOnlyRequested(guidance)) prompt += TRANSLATION_ONLY_NOTE;
      if (guidance.trim()) prompt += `\n[Current request — answer this now]\n${guidance.trim()}\nCarry out this task in context. Preserve the owner’s intended customer message and approved selling figures. Put any specific disagreement in Chinese internally; CRM metadata does not require extra customer-facing questions or pleasantries.`;
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
      }, { mode:'reply', template, workMemory, followupContext, skill:approvedKnowledge?.skill,
        source:messageSource, count:messages.length, prompt, guidance:guidanceForLog || null,
        startedAt, followupContract, wasFollowUp, inputEvidence:snapshotDraftEvidence(messages) });

      rawResponseForLog = response?.responseText ?? null;
      chatUrlForLog = response?.chatUrl ?? null;
      await deliverGptResponse(response, { mode:'reply', template, workMemory, followupContext,
        skill:approvedKnowledge?.skill, source:messageSource, count:messages.length, prompt,
        guidance:guidanceForLog || null, startedAt, followupContract, wasFollowUp,
        inputEvidence:snapshotDraftEvidence(messages) });
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
        setStatus(current => current.kind === 'done' ? { ...current, saving:false, followupWarning: `回复已保留；保存未完成，可取回结果重试保存：${msg}` } : { kind: 'error', message: msg });
      }
      void clearReplyProgress(contact.id);
    } finally {
      actionLock.current = false;
    }
  };

  // ── 主流程 2：跟 GPT 讨论这客户 ──

  const sendDiscussion = async () => {
    const q = discuss.trim();
    if (!q || actionLock.current || busy || backgroundBusy || !templatesLoaded || !guidanceLoaded || !recoveryLoaded) return;
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
      // 讨论框任何输入都是老板要求 → B 层；跟进契约只在问题明确要求创建/调整/安排跟进任务时注入。
      const layer = 'compact' as const;
      const followupContract = followupContractRequested(q, 'discuss');
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
          layer,
        });
      } else {
        // 续聊讨论也要补发最近 50 条 — GPT 那边 chat thread 看到的只是
        // 上一次 generate 时的历史快照，之后客户陆续发的新消息（最新预算 /
        // 改车型 / 发图）没人喂给它，必须在本次 prompt 里补上。
        // 同时带精简客户档案，防 thread 长后 GPT 忘客户 anchor。
        prompt = buildDiscussionMessage({
          newMessages: messages,
          isGroup: !!contact.group_jid,
          question: q,
          approvedKnowledge,
          workMemory,
          contact,
          vehicleInterests,
          layer,
        });
      }
      if (!followupContract) {
        prompt += PRESERVE_TASKS_NOTE;
      } else {
        prompt += followupPrompt(followupContext, { includedRenderedMessages: chatHistoryEvidence(messages, layer), includedWorkMemory: workMemory, includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes, compact: true });
      }
      if (translationOnlyRequested(q)) prompt += TRANSLATION_ONLY_NOTE;
      prompt += `\n[Current request — answer this now]\n${q}\nIf this is a judgment or advice question, keep the 2–4 sentence default above: verdict first, then the key reason. For a draft, check the requested sentence count before returning it; greetings count as sentences. The current request takes priority over earlier draft wording and default workflow suggestions.`;
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
      }, { mode:'discuss', template, workMemory, followupContext, skill:approvedKnowledge?.skill,
        source, count, prompt, guidance:q, startedAt, followupContract });
      rawResponseForLog = response?.responseText ?? null;
      chatUrlForLog = response?.chatUrl ?? null;
      await deliverGptResponse(response, { mode:'discuss', template, workMemory, followupContext,
        skill:approvedKnowledge?.skill, source, count, prompt, guidance:q, startedAt, followupContract });
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
        setStatus(current => current.kind === 'done' ? { ...current, saving:false, followupWarning: `回复已保留；保存未完成，可取回结果重试保存：${msg}` } : { kind: 'error', message: msg });
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
      status.kind === 'done' && (status.mode === 'reply'
        || (status.text.includes('[WhatsApp Reply]') && status.text.includes('[Full Translation & Strategy]')))
        ? parseGptResponse(status.text)
        : null,
    [status],
  );

  const isFreshResult = status.kind === 'done'
    && browserAllowsTemplate(browserBinding, status.templateId ?? '')
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

  // 生成这条回复的模板是否要求拆条发送（Miles V3）。按生成时的模板判断，不按当前选中的。
  const resultTemplateId = status.kind === 'done' ? status.templateId ?? selectedTemplate?.id : undefined;
  const resultTemplate = resultTemplateId ? templates.find((t) => t.id === resultTemplateId) : undefined;
  const resultSplitsMessages = !!resultTemplate && splitsCustomerMessages(resultTemplate);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  /** 返回 false = 没填进去（已经弹过提示）；逐条填入靠它决定要不要跳到下一条。 */
  const fillReply = async (text: string): Promise<boolean> => {
    try {
      if (!templatesLoaded || !guidanceLoaded || !recoveryLoaded) {
        alert('正在核对当前客户与模板，请稍后再填入。');
        return false;
      }
      if (!routeContext) {
        alert('尚未核对当前客户的车型，请重新生成以确认回复模板后再填入。');
        return false;
      }
      if (staleResult) {
        alert('旧模板生成，请使用当前模板重新生成后再填入。');
        return false;
      }
      const wasDirty = wasReplyDirty(text);
      const cleanText = sanitizeReplyForCustomer(text);
      if (!cleanText) {
        alert('回复为空（GPT 没生成有效的 [WhatsApp Reply] 段）');
        return false;
      }
      if (wasDirty) {
        const ok = confirm(
          'GPT 的回复里夹了内部段落（[Strategy] / 备注 之类），已自动剥掉。确认要把净化后的版本发给客户？',
        );
        if (!ok) return false;
      }
      if (needsJump) {
        const query = contact.phone
          ? contact.phone.replace(/^\+/, '')
          : contact.name?.trim() || contact.wa_name?.trim() || '';
        if (query) {
          const ok = await jumpToChat(query, { allowDeepLink: true, requireMatch: { phone:contact.phone, name:contact.name, waName:contact.wa_name, groupJid:contact.group_jid } });
          if (!ok) {
            alert('未能跳转到该聊天，请先手动打开后再点填入');
            return false;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!verifyHeaderMatches({ phone:contact.phone, name:contact.name, waName:contact.wa_name, groupJid:contact.group_jid })) {
        alert('当前聊天与这条回复的客户不一致，请打开正确聊天后再填入。');
        return false;
      }
      const ok = fillWhatsAppCompose(cleanText);
      if (!ok) {
        alert('找不到 WhatsApp 输入框，请确认聊天已打开');
        return false;
      }
      const logId = status.kind === 'done' ? status.logId : null;
      if (logId) {
        void markAiReplyFilled(logId);
      }
      // 归因 attribution：记下这次填入，syncMessages 写出站消息时匹配文本来标 ai_source
      void recordFill({ contactId: contact.id, source: 'gpt', text: cleanText, logId });
      return true;
    } catch (err) {
      alert(stringifyError(err));
      return false;
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

  const backgroundBusy = (bgPhase === 'generating' || !!pendingAction) && !busy;

  const actionUnavailable = busy || backgroundBusy || !templatesLoaded || !guidanceLoaded || !recoveryLoaded;
  const generationUnavailable = actionUnavailable || !selectedTemplate || !!previewRoute.error;
  const discussionRoute = resolveGptTemplateRoute(templates, selectedTemplateId, {
    messages: routeContext?.messages ?? [],
    vehicleInterests: routeContext?.vehicleInterests ?? [],
    salesGuidance: guidance,
    discussionQuestion: discuss,
    manualTemplateId, browserBinding,
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
              {templates.filter(t => browserAllowsTemplate(browserBinding, t.id)).map((t) => (
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
          {pendingAction ? '已保留本次生成记录。刷新后可取回原结果，无需重新生成。' : '⏳ 这个客户的回复正在后台生成 —— 可以先去处理别的客户，好了左栏那一行会变成「📝 待填入」'}
          {pendingAction && <button type="button" className="sgc-btn-link" disabled={busy || !templatesLoaded}
            onClick={() => void recoverGptResult()}>取回生成结果</button>}
          {pendingAction && (status.kind === 'error' || status.kind === 'done') && <button type="button" className="sgc-btn-link"
            onClick={() => void releaseRecoveryWait()}>保留原记录并解除等待</button>}
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
              {modelPreparation && <div style={{fontSize:11}}>{({loading:'正在加载 GPT 页面',sending:'正在提交本轮内容'} as Record<string,string>)[modelPreparation]}</div>}
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

          {status.kind === 'done' && parsed && (
            <ResultView
              parsed={parsed}
              source={status.source}
              count={status.count}
              chatUrl={status.chatUrl}
              contact={contact}
              deferRecordApply={!!status.saving && pendingAction?.requestId === status.requestId}
              splitParts={resultSplitsMessages}
              onFillReply={fillReply}
              onCopy={copyToClipboard}
            />
          )}

          {status.kind === 'done' && status.mode === 'discuss' && !parsed && (
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
  parsed: ReturnType<typeof parseGptResponse>;
  source: MessageSource;
  count: number;
  chatUrl: string;
  contact: ContactRow;
  /** Hold the profile auto-save until this run's follow-up is saved, or the follow-up sees its own write as a conflict. */
  deferRecordApply?: boolean;
  /** 生成这条回复的模板要求拆条发送（Miles V3） */
  splitParts?: boolean;
  onFillReply: (text: string) => Promise<boolean>;
  onCopy: (text: string) => void;
}

function ResultView({
  parsed,
  source,
  count,
  chatUrl,
  contact,
  deferRecordApply,
  splitParts = false,
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

      {parsed.noReplyReason && <div role="status" className="sgc-gem-progress">{parsed.noReplyReason}</div>}
      {parsed.reply && (
        <ReplyCard
          label="💬 给客户的回复"
          reply={parsed.reply}
          existingTranslation={parsed.translation}
          splitParts={splitParts}
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
          autoApply={!deferRecordApply}
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
