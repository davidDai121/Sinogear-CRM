/**
 * WhatsApp Web DOM 漂移自检：跑一组关键 selector 的健康检查。
 *
 * 设计原则：
 * - 只在 WA Web 已加载且适用上下文下检查（避免误报）
 * - skipped ≠ broken：当前不在该状态（如没开聊天）就跳过
 * - 只在面板里被 hook 调用，不主动改 DOM
 */

export type CheckStatus = 'ok' | 'broken' | 'skipped';

export interface CheckResult {
  name: string;
  description: string;
  status: CheckStatus;
  hint?: string;
}

function getMainPane(): Element | null {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel"]')
  );
}

function isWhatsAppLoaded(): boolean {
  // 侧边栏：聊天列表容器
  return !!(
    document.querySelector('#pane-side') ||
    document.querySelector('[data-testid="chat-list"]')
  );
}

const CHECKS: Array<() => CheckResult> = [
  () => ({
    name: 'wa-loaded',
    description: 'WhatsApp Web 主界面（侧边栏）',
    status: isWhatsAppLoaded() ? 'ok' : 'broken',
    hint: '页面没在 web.whatsapp.com / 还没加载完 / 选择器变了（#pane-side）',
  }),
  () => {
    if (!isWhatsAppLoaded()) {
      return { name: 'main-pane', description: '当前聊天主面板', status: 'skipped' };
    }
    const ok = !!getMainPane();
    return {
      name: 'main-pane',
      description: '当前聊天主面板（div#main）',
      status: 'skipped',
      // 主面板只在打开聊天时才有，用 skipped 兜底；如果有别的迹象表明应该有再 broken
      ...(ok ? { status: 'ok' as CheckStatus } : {}),
    };
  },
  () => {
    const main = getMainPane();
    if (!main) {
      return {
        name: 'chat-title',
        description: '当前聊天联系人姓名（header span[title]）',
        status: 'skipped',
      };
    }
    const titleEl = main.querySelector(
      'header [data-testid="conversation-info-header-chat-title"], header span[title], header span[dir="auto"]',
    );
    return {
      name: 'chat-title',
      description: '当前聊天联系人姓名（header span[title]）',
      status: titleEl ? 'ok' : 'broken',
      hint: '取不到 → 客户卡显示不出名字，useCurrentChat 拿不到当前聊天',
    };
  },
  () => {
    const main = getMainPane();
    if (!main) {
      return {
        name: 'message-data-id',
        description: '消息气泡 data-id（提取手机号靠它）',
        status: 'skipped',
      };
    }
    const hasDataId = main.querySelectorAll('[data-id]').length > 0;
    return {
      name: 'message-data-id',
      description: '消息气泡 data-id 属性',
      status: hasDataId ? 'ok' : 'skipped',
      hint: '当前聊天没消息或新对话不会有 data-id；多次 skipped 不一定是问题',
    };
  },
  () => {
    if (!isWhatsAppLoaded()) {
      return {
        name: 'search-input',
        description: '左侧顶部搜索框（jumpToChat 跳转用）',
        status: 'skipped',
      };
    }
    // WA 搜索框：原生 input contenteditable 兼容
    const input = document.querySelector(
      '#side input[type="text"], #side div[contenteditable="true"]',
    );
    return {
      name: 'search-input',
      description: '左侧搜索框（跳转聊天靠它）',
      status: input ? 'ok' : 'broken',
      hint: '取不到 → 跳转聊天功能失效（搜手机号 + Enter）',
    };
  },
];

export function runDomHealthCheck(): CheckResult[] {
  return CHECKS.map((c) => {
    try {
      return c();
    } catch (e) {
      return {
        name: 'unknown',
        description: 'check threw',
        status: 'broken',
        hint: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export function brokenCount(results: CheckResult[]): number {
  return results.filter((r) => r.status === 'broken').length;
}
