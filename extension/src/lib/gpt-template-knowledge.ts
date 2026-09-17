import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { stringifyError } from './errors';

// description 原本是普通说明。只有带专用前缀且 schema/version/字段全部有效的
// envelope 才能提升为业务知识；普通文本、普通 JSON 和客户消息都不是知识来源。
export const GPT_TEMPLATE_METADATA_PREFIX = 'SGC_GPT_TEMPLATE_CONFIG\n';
const SCHEMA = 'sinogear.gpt-template';
const VERSION = 1;

export interface GptTemplateMetadata {
  description: string;
  approvedKnowledge: string;
  hasEnvelope: boolean;
  updatedAt: string | null;
}

export interface GptApprovedKnowledge {
  text: string;
  templateId: string;
  updatedAt: string;
}

export function decodeGptTemplateDescription(raw: unknown): GptTemplateMetadata {
  if (raw !== null && typeof raw !== 'string') {
    throw new Error('GPT 模板说明字段缺失或类型无效，无法读取已确认业务知识。');
  }
  if (raw === null || !raw.startsWith(GPT_TEMPLATE_METADATA_PREFIX)) {
    return { description: raw ?? '', approvedKnowledge: '', hasEnvelope: false, updatedAt: null };
  }

  try {
    const value: unknown = JSON.parse(raw.slice(GPT_TEMPLATE_METADATA_PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const envelope = value as Record<string, unknown>;
    const keys = Object.keys(envelope).sort().join(',');
    if (
      keys !== 'approvedKnowledge,description,schema,updatedAt,version' ||
      envelope.schema !== SCHEMA || envelope.version !== VERSION ||
      typeof envelope.description !== 'string' ||
      typeof envelope.approvedKnowledge !== 'string' ||
      typeof envelope.updatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(envelope.updatedAt) ||
      !Number.isFinite(Date.parse(envelope.updatedAt))
    ) throw new Error();
    return {
      description: envelope.description,
      approvedKnowledge: envelope.approvedKnowledge,
      hasEnvelope: true,
      updatedAt: envelope.updatedAt,
    };
  } catch {
    throw new Error('GPT 模板的已确认业务知识格式损坏或版本不受支持。原始内容已保留，请修复后再生成。');
  }
}

export function encodeGptTemplateDescription(
  description: string,
  approvedKnowledge: string,
  preserveEnvelope = false,
  updatedAt = new Date().toISOString(),
): string | null {
  const summary = description.trim();
  const knowledge = approvedKnowledge.trim();
  // 保持从未启用知识的旧模板行为。曾启用后清空则保留 envelope，向旧对话明确撤销。
  // 说明本身若是转贴来的 envelope，也必须包成纯说明，不能在下一次读取时升级权限。
  if (!knowledge && !preserveEnvelope && !summary.startsWith(GPT_TEMPLATE_METADATA_PREFIX)) {
    return summary || null;
  }
  return GPT_TEMPLATE_METADATA_PREFIX + JSON.stringify({
    schema: SCHEMA,
    version: VERSION,
    description: summary,
    approvedKnowledge: knowledge,
    updatedAt,
  }, null, 2);
}

/** 每次动作都向 DB 读当前模板，不使用组件中的旧缓存，也不回退到其他模板。 */
export async function loadGptApprovedKnowledge(
  client: Pick<SupabaseClient<Database>, 'from'>,
  templateId: string,
  orgId: string,
): Promise<GptApprovedKnowledge | undefined> {
  try {
    if (!templateId || !orgId) throw new Error('缺少模板或组织标识');
    const { data, error } = await client
      .from('gpt_templates')
      .select('id, org_id, description, updated_at')
      .eq('id', templateId)
      .eq('org_id', orgId)
      .single();
    if (error) throw error;
    if (!data || data.id !== templateId || data.org_id !== orgId) {
      throw new Error('当前模板不存在、无权访问或归属不匹配');
    }
    const metadata = decodeGptTemplateDescription(data.description);
    if (!metadata.hasEnvelope) return undefined;
    if (typeof data.updated_at !== 'string' || !data.updated_at) {
      throw new Error('模板更新时间缺失');
    }
    return {
      text: metadata.approvedKnowledge,
      templateId: data.id,
      updatedAt: metadata.updatedAt!,
    };
  } catch (error) {
    throw new Error(`读取 GPT 已确认业务知识失败，已停止本次生成：${stringifyError(error)}`);
  }
}
