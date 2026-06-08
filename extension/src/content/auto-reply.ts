/**
 * 自动回复执行器（content script 端）。
 *
 * 收到 SW 发来的 AUTO_REPLY_FIRE 后跑：
 *
 *   首轮（roundCount = 0）：
 *     1. jumpToChat → 等 WA 切过去
 *     2. 跑 Gem（active=true 切到 Gemini tab，~2min）— 用首次客户上下文 prompt
 *     3. 拿到 [WhatsApp Reply]
 *     4a. 有 vehicleId：再 jumpToChat 一次 → paste 车型图 → 填 caption (Gem reply) → 自动点预览发送
 *     4b. 无 vehicleId：再 jumpToChat 一次 → fillWhatsAppCompose(reply) → 自动点 compose 发送
 *     5. upsert gem_conversation（存 chat URL 续聊用）
 *
 *   续聊（roundCount ≥ 1）：客户回了新消息后 1 分钟触发
 *     1. jumpToChat
 *     2. 跑 Gem（用同一 gem_chat_url，formatUpdate prompt 仅带最近几条）
 *     3. 拿到 reply → 再 jumpToChat → fillWhatsAppCompose + sendCurrentCompose（**不发图**）
 *     4. update gem_conversation.last_used_at
 *
 * 失败任一步 → phase=error，state.error 写到 banner。
 * 用户在 banner 点 "中止" 会删 state，下一个 await 之间 wasCancelled 检测到 → return。
 */

import { supabase } from '@/lib/supabase';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  fillWhatsAppCompose,
  pasteFilesToWhatsApp,
  pressEscapeToClosePreview,
  sendCurrentCompose,
  sendPastedImagesNoCaption,
  waitForPreviewClosed,
  waitForPreviewReady,
} from './whatsapp-compose';
import {
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
} from './whatsapp-messages';
import { mergeDomWithDbMessages, syncMessages } from '@/lib/message-sync';
import { formatNewCustomer, formatUpdate } from '@/lib/gem-prompt';
import { parseGemResponse } from '@/lib/gem-parser';
import { getGemModelPreset, GEM_MODEL_STORAGE_KEY } from '@/lib/gem-models';
import { sanitizeReplyForCustomer } from '@/lib/reply-sanitize';
import { recordFill } from '@/lib/ai-reply-attribution';
import { logContactEvent } from '@/lib/events-log';
import { logAiReply } from '@/lib/ai-reply-log';
import {
  getState,
  isContactAutoReplyEnabled,
  listStates,
  patchState,
  type AutoReplyState,
} from '@/lib/auto-reply-state';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleMediaRow = Database['public']['Tables']['vehicle_media']['Row'];
type GemTemplateRow = Database['public']['Tables']['gem_templates']['Row'];
type GemConversationRow =
  Database['public']['Tables']['gem_conversations']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

const MAX_IMAGES = 8;

export function initAutoReply(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'AUTO_REPLY_FIRE') return false;
    const contactId = msg.contactId;
    if (typeof contactId !== 'string') {
      sendResponse({ ok: false, error: '缺少 contactId' });
      return false;
    }
    void executeAutoReply(contactId);
    sendResponse({ ok: true });
    return false;
  });

  // 恢复：用户重开 WA Web 时扫一遍 scheduled 状态。若 scheduledAt 已过
  // （alarm 之前可能在 WA tab 关着时静默失败了）就立即触发。
  void recoverStuckSchedules();
}

async function recoverStuckSchedules(): Promise<void> {
  const states = await listStates();
  const now = Date.now();
  for (const s of states) {
    if (s.phase !== 'scheduled') continue;
    if (s.scheduledAt > now) continue;
    void executeAutoReply(s.contactId);
  }
}

async function executeAutoReply(contactId: string): Promise<void> {
  if (!(await isContactAutoReplyEnabled(contactId))) return;

  const state = await getState(contactId);
  if (!state) return;
  if (state.phase !== 'scheduled') return;

  await patchState(contactId, { phase: 'firing' });
  const isFollowup = state.roundCount > 0;

  // log 用：跨 try/catch 捕获 prompt + 时长 + orgId
  const startedAt = Date.now();
  let promptForLog = '';
  let orgIdForLog: string | null = null;
  const modeForLog = isFollowup ? 'auto_followup' : 'auto_first';

  try {
    if (await wasCancelled(contactId)) return;

    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();
    if (contactErr || !contact) throw new Error('客户记录已被删除');
    if (!contact.phone) {
      throw new Error('客户没有手机号 — 群聊不支持自动回复');
    }
    orgIdForLog = contact.org_id;

    if (await wasCancelled(contactId)) return;

    // 1. jumpToChat
    const query = contact.phone.replace(/^\+/, '');
    const jumped = await jumpToChat(query, { allowDeepLink: true });
    if (!jumped) {
      throw new Error(`无法跳转到聊天 ${contact.phone}（号码可能未注册 WA）`);
    }
    await sleep(1500);

    if (await wasCancelled(contactId)) return;

    // 2. 选 Gem 模板（按 vehicle 匹配，没匹配 fallback 到 default）+ 拿已有 conversation
    const template = await pickGemTemplate(contact.org_id, state.vehicleId);
    if (!template) {
      throw new Error('没有 Gem 模板 — 请先在顶栏 🤖 Gem 添加');
    }
    const existingConv = await fetchGemConversation(contactId, template.id);
    const gemUrl = existingConv?.gem_chat_url ?? template.gem_url;

    // 提前算 shouldSendImages，传进 prompt 让 Gem 知道图会不会发
    const requestedPhotos =
      isFollowup && isPhotoRequest(state.lastInboundText ?? '');
    const shouldSendImages =
      !!state.vehicleId && (!isFollowup || requestedPhotos);

    // 3. 跑 Gem（首轮：formatNewCustomer + lead context；续聊：formatUpdate 仅带新消息）
    await patchState(contactId, {
      phase: 'gem_running',
      gemStartedAt: Date.now(),
    });

    const prompt = await buildPrompt(contact, state, isFollowup, shouldSendImages);
    promptForLog = prompt;

    // 自动回复用跟手动 AI 回复区同一个模型设置（默认 3.5 Flash）
    const modelStore = await chrome.storage.local.get(GEM_MODEL_STORAGE_KEY);
    const modelPreset = getGemModelPreset(
      modelStore[GEM_MODEL_STORAGE_KEY] as string | undefined,
    );
    const response = (await chrome.runtime.sendMessage({
      type: 'GEM_RUN',
      url: gemUrl,
      prompt,
      // 用户选了"切到新 tab 抢焦点"——满足 Gemini 的"页面活跃"判定
      active: true,
      preferModel: modelPreset.prefer,
      avoidModel: modelPreset.avoid,
    })) as
      | {
          ok: true;
          responseText: string;
          chatUrl: string;
          modelSelected: string | null;
        }
      | { ok: false; error: string };
    if (!response.ok) {
      throw new Error(response.error || 'Gem 调用失败');
    }

    if (await wasCancelled(contactId)) return;

    // 4. 解析 reply
    const parsed = parseGemResponse(response.responseText);
    // P0 安全：Gem 返回的 reply 在 auto-send 前必须 sanitize（自动发=没人 review，泄漏=灾难）
    const reply = sanitizeReplyForCustomer(parsed.reply ?? '');
    if (!reply) {
      throw new Error('Gem 没生成 [WhatsApp Reply] 段 — 需要手动复制原始响应');
    }

    // Gem tab 关掉后焦点回 WA，但用户可能在等的过程切聊天了——保险起见再跳一次
    await jumpToChat(query, { allowDeepLink: false });
    await sleep(800);

    if (await wasCancelled(contactId)) return;

    // 5. 发送：首轮 + 有车 → 两步发（图 → 文字）
    //    续聊 + 客户问图 + 有车 → 也发图
    //    其他 → 纯文字
    if (shouldSendImages) {
      await patchState(contactId, { phase: 'sending_images' });
      const imagesSent = await sendImages(state.vehicleId!, contactId);
      if (imagesSent) {
        await patchState(contactId, { imagesSentAt: Date.now() });
      }
      // 不管图是否发出去，文字 reply 都跟着发（确保客户至少收到文字回复）
      const textSent = await sendTextReply(reply, contactId);
      if (!textSent) {
        throw new Error('找不到 WA 输入框或发送键，文字 reply 没发出去');
      }
    } else {
      const ok = await sendTextReply(reply, contactId);
      if (!ok) {
        throw new Error('找不到 WA 输入框或发送键，请检查聊天是否打开');
      }
    }

    await patchState(contactId, {
      phase: 'reply_filled',
      replyFilledAt: Date.now(),
    });

    // 6. upsert gem_conversation
    if (existingConv) {
      await supabase
        .from('gem_conversations')
        .update({
          gem_chat_url: response.chatUrl,
          last_used_at: new Date().toISOString(),
        })
        .eq('id', existingConv.id);
    } else {
      await supabase.from('gem_conversations').insert({
        contact_id: contactId,
        template_id: template.id,
        gem_chat_url: response.chatUrl,
      });
    }

    void logContactEvent(contactId, 'ai_extracted', {
      source: isFollowup ? 'auto-reply-followup' : 'auto-reply',
      round: state.roundCount,
      vehicleId: state.vehicleId,
      model: response.modelSelected,
    });

    // 写 ai_reply_logs — 自动回复直接 was_filled=true（reply 已自动发出）
    void logAiReply({
      orgId: contact.org_id,
      contactId,
      source: 'gem_auto',
      mode: modeForLog,
      prompt,
      response: response.responseText,
      messageSource: 'dom',
      chatUrl: response.chatUrl,
      wasFilled: true,
      durationMs: Date.now() - startedAt,
    });

    await patchState(contactId, { phase: 'done', doneAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auto-reply] 失败', contactId, message);
    if (orgIdForLog) {
      void logAiReply({
        orgId: orgIdForLog,
        contactId,
        source: 'gem_auto',
        mode: modeForLog,
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        messageSource: 'dom',
        durationMs: Date.now() - startedAt,
        error: message,
      });
    }
    await patchState(contactId, { phase: 'error', error: message });
  }
}

/**
 * 发车源图（不带 caption）。
 *
 * 流程：拉 vehicle_media → fetch 成 File[] → paste 到 WA → 等预览弹出 →
 * 点预览的发送键 → 等预览关闭。
 *
 * 不依赖 caption 输入框 selector（最容易漂的那个），仅依赖预览发送键。
 * 文字 reply 由调用方在本函数返回后单独发。
 *
 * @returns true = 图已发出；false = 任意一步失败（caller 应 fallback 到纯文字）
 */
async function sendImages(
  vehicleId: string,
  contactId: string,
): Promise<boolean> {
  const { data: media } = await supabase
    .from('vehicle_media')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .eq('media_type', 'image')
    .order('sort_order')
    .order('created_at');

  if (!media || media.length === 0) {
    console.warn('[auto-reply] 该车没图，跳过发图');
    return false;
  }

  const images = media.slice(0, MAX_IMAGES);
  const files = await downloadAsFiles(images, contactId);
  if (files.length === 0) {
    console.warn('[auto-reply] 车源图片全部下载失败');
    return false;
  }

  const pasted = pasteFilesToWhatsApp(files);
  if (!pasted) {
    console.warn('[auto-reply] paste 失败 — 找不到 WA compose 输入框');
    return false;
  }

  const ready = await waitForPreviewReady(6000);
  if (!ready) {
    console.warn('[auto-reply] WA 图片预览没弹出来');
    return false;
  }

  const sent = await sendPastedImagesNoCaption(8000);
  if (!sent) {
    console.warn('[auto-reply] 预览发送键找不到 — Esc 关掉预览回退');
    pressEscapeToClosePreview();
    await sleep(500);
    return false;
  }

  // 等预览关闭，compose 重新可访问
  const closed = await waitForPreviewClosed(8000);
  if (!closed) {
    console.warn('[auto-reply] 预览迟迟没关（图可能还在上传）— 继续往下');
  }
  return true;
}

async function sendTextReply(reply: string, contactId: string): Promise<boolean> {
  const filled = fillWhatsAppCompose(reply);
  if (!filled) return false;
  // 归因 attribution：自动回复路径下发送的文本走 gem_auto 来源
  void recordFill({ contactId, source: 'gem_auto', text: reply, logId: null });
  // 给 React state 一拍同步，让发送键 enable
  await sleep(400);
  const sent = await sendCurrentCompose();
  return sent;
}

/**
 * 选 Gem 模板：先按 vehicle.brand + vehicle.model 字符串匹配模板名（销售为不同车
 * 建了不同 Gem，如"二手 BYD Qin Plus Dm-i 回复"），找到分数最高的模板用。
 * 没匹配 fallback 到 is_default = true，再 fallback 第一个。
 */
async function pickGemTemplate(
  orgId: string,
  vehicleId: string | null,
): Promise<GemTemplateRow | null> {
  const { data: templates } = await supabase
    .from('gem_templates')
    .select('*')
    .eq('org_id', orgId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (!templates || templates.length === 0) return null;

  if (vehicleId) {
    const { data: vehicle } = await supabase
      .from('vehicles')
      .select('brand, model')
      .eq('id', vehicleId)
      .maybeSingle();
    if (vehicle) {
      const brand = (vehicle.brand ?? '').toLowerCase();
      const model = (vehicle.model ?? '').toLowerCase();
      // 评分：model 命中 +3 / brand 命中 +1 / brand+model 完整命中 +5
      const scored = templates.map((t) => {
        const n = (t.name ?? '').toLowerCase();
        let s = 0;
        if (brand && model && n.includes(`${brand} ${model}`)) s += 5;
        if (model && n.includes(model)) s += 3;
        if (brand && n.includes(brand)) s += 1;
        return { t, s };
      });
      const best = scored
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)[0];
      if (best) return best.t;
    }
  }

  return templates.find((t) => t.is_default) ?? templates[0];
}

async function fetchGemConversation(
  contactId: string,
  templateId: string,
): Promise<GemConversationRow | null> {
  const { data } = await supabase
    .from('gem_conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('template_id', templateId)
    .maybeSingle();
  return data;
}

async function buildPrompt(
  contact: ContactRow,
  state: AutoReplyState,
  isFollowup: boolean,
  sendingPhotosThisRound: boolean,
): Promise<string> {
  // 读 DOM 上的实际消息 —— 用 waitForChatMessages 稳态判定避免读到只有 1 条
  // bubble（销售刚发完图就触发自动回复时常见）。然后 fire-and-forget 持久化到
  // DB + merge 老消息，保证 prompt 上下文齐全。
  let messages: ChatMessage[] = await waitForChatMessages(5000, 30, 1).catch(
    () => readChatMessages(30),
  );
  if (messages.length > 0) {
    void syncMessages(contact.id, messages);
    messages = await mergeDomWithDbMessages(messages, contact.id, 50);
  }

  // DOM 读不到时兜底用 state.leadText
  if (messages.length === 0) {
    messages = [
      {
        id: `lead:${state.leadArrivedAt}`,
        fromMe: false,
        text: state.leadText,
        timestamp: state.leadArrivedAt,
        sender: null,
      },
    ];
  }

  if (isFollowup) {
    const baseUpdate = formatUpdate(contact.phone, messages.slice(-5), false);
    const alreadySentPhotos = !!state.imagesSentAt;
    const photoNote = sendingPhotosThisRound
      ? 'The customer just asked for more photos. A fresh batch of product photos is being auto-sent in a separate WhatsApp message right BEFORE your text reply. Acknowledge briefly ("here are more photos / 这就发"), add 1 useful detail about the car, and ask if they want a specific angle (interior, engine bay, undercarriage). Do NOT say "I cannot send photos" — they are going out.'
      : alreadySentPhotos
        ? 'You ALREADY SENT a batch of product photos to this customer earlier in this conversation (see the [图片 × N] entry from Sales in the chat below). The customer has seen them. DO NOT ask "would you like to see photos?" or "shall I send you photos?" — that already happened. If you want to offer something more visual, offer SPECIFIC additional content (e.g., walk-around video, undercarriage photos, dashboard close-up).'
        : 'This is a TEXT-ONLY follow-up. No photos this round.';
    return `[Auto-Reply Continuation — TOP PRIORITY]
The customer has REPLIED to your earlier message. You are CONTINUING this WhatsApp conversation, not starting a new one. The product photos and your first greeting have ALREADY been sent — the customer can see them.

${photoNote}

Your job for this round:
- Read the LAST [Customer] message(s) below.
- Respond DIRECTLY to what they just asked / said.
- DO NOT reintroduce yourself, do not say "thank you for filling out the form" again, do not repeat the FOB price unless they specifically ask.
- If they say "please tell me more" / "what is the car condition" → give CONCRETE specifics (year, mileage, condition grade, mechanical state).
- If they ask price/shipping → give specifics from the chat context.
- Match their language. Keep it short: 2-3 sentences max.

In the chat below, [图片] / [图片 × N] entries are real photos that were already delivered to WhatsApp (you can't see them but the customer did).

${baseUpdate}`;
  }

  // 首轮：完整客户上下文 + lead 场景提示
  const { data: vehicleInterests } = await supabase
    .from('vehicle_interests')
    .select('*')
    .eq('contact_id', contact.id);

  const base = formatNewCustomer({
    contact,
    vehicleInterests: (vehicleInterests ?? []) as VehicleInterestRow[],
    messages,
  });

  const leadContext = `[Lead Context — TOP PRIORITY]
This is a fresh inbound lead from a Facebook ad form (auto-detected). The customer just filled the form and was contacted on WhatsApp ${formatRelative(state.leadArrivedAt)}. You are sending the FIRST reply on behalf of the sales rep.

${state.vehicleId
  ? 'Product photos will be auto-sent FIRST as a separate WhatsApp message, then your reply below will be sent right after as a text message. Do NOT ask "would you like to see photos?" — the photos are going out moments before your reply.'
  : 'Your reply below will be sent as a text-only WhatsApp message (no photos available in inventory for this lead).'}

Open with a warm greeting in the customer's language (match the lead message language). Acknowledge what they asked about. Ask 1-2 qualifying follow-up questions (e.g., destination port if not given, payment method, target delivery date). Keep it short — 2-3 sentences max for the first touch.

`;
  return leadContext + base;
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}

async function downloadAsFiles(
  media: VehicleMediaRow[],
  contactId: string,
): Promise<File[]> {
  const out: File[] = [];
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    try {
      const res = await fetch(m.url);
      if (!res.ok) {
        console.warn(`[auto-reply] 图 ${i + 1} fetch ${res.status}`, m.url);
        continue;
      }
      const blob = await res.blob();
      const mime = m.mime_type ?? blob.type ?? 'image/jpeg';
      const extMatch = mime.match(/\/(\w+)/);
      const ext = (extMatch?.[1] ?? 'jpg').replace('jpeg', 'jpg');
      // 优先用上传时存的原文件名；老数据 file_name=null 回退
      const filename =
        m.file_name?.trim() || `vehicle-${contactId.slice(0, 8)}-${i + 1}.${ext}`;
      out.push(
        new File([blob], filename, {
          type: mime,
        }),
      );
    } catch (err) {
      console.warn(`[auto-reply] 图 ${i + 1} 下载失败`, err);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 简单关键词识别"客户在要图"。覆盖中英常见说法：
 *   - "more photos / pictures / pics"
 *   - "send / share me / us a photo"
 *   - "图片 / 照片 / 看图 / 发图 / 再发几张 / 多发几张"
 *
 * 命中后 orchestrator 在续聊里也走"发图 + 文字"两步。误识别成本可控
 * （客户没要图也发一遍 ≠ 灾难），所以不加 negative pattern。
 */
function isPhotoRequest(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (/\b(more\s+)?(photo|photos|picture|pictures|pic|pics|image|images)\b/i.test(t))
    return true;
  if (/(send|show|share)\b.*(photo|picture|image|pic)/i.test(t)) return true;
  if (/(图片|照片|看图|发图|再发|再来|多发|多.*图|多.*照|更多.*图|更多.*照)/.test(t))
    return true;
  return false;
}

async function wasCancelled(contactId: string): Promise<boolean> {
  const s = await getState(contactId);
  return !s;
}
