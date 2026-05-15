/**
 * 分页拉一张表全集，规避 Supabase / PostgREST 默认 1000 行 max-rows 上限。
 *
 * 用法：
 *   const rows = await fetchAllPaged<ContactRow>((from, to) =>
 *     supabase
 *       .from('contacts')
 *       .select('*')
 *       .eq('org_id', orgId)
 *       .range(from, to),
 *   );
 *
 * 调用方负责 .from/.select/.eq/.in/.order 等链式调用，最后必须加 .range(from, to)。
 * 这里负责循环到拉不满 PAGE 为止。
 *
 * 历史教训（CLAUDE.md "已知问题" 段记录了多次）：
 * - 任何 .from('xxx').select('*').eq('org_id', orgId) 形态的客户端查询，
 *   如果该表行数可能 > 1000，必须改成 fetchAll 分页
 * - 2026-05-09 service_role 脚本读 contacts 没分页 → 误删 137 contacts
 * - 2026-05-11 useCrmData / ContactsPage 没分页 → 712/1733 客户在 UI 消失
 * - 2026-05-15 vehicle-cleanup 没分页 → "扫描 1000" 后停（用户截图）
 *
 * 这个 helper 让以后写新查询时再也别忘了。
 */

export const SUPABASE_PAGE_SIZE = 1000;

interface PagedResult<T> {
  data: T[] | null;
  error: unknown;
}

export async function fetchAllPaged<T>(
  buildQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await buildQuery(
      from,
      from + SUPABASE_PAGE_SIZE - 1,
    );
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < SUPABASE_PAGE_SIZE) break;
  }
  return out;
}
