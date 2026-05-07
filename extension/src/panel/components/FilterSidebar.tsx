import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadBrandOverrides,
  saveBrandOverride,
  subscribeBrandOverrides,
} from '@/lib/brand-overrides';
import type { CrmContact } from '../hooks/useCrmData';
import type { CustomerQuality, CustomerStage } from '@/lib/database.types';
import {
  BUDGET_BUCKETS_NEW,
  BUDGET_BUCKETS_USED,
  applyFilter,
  brandOf,
  deserializeFilter,
  emptyFilter,
  isFilterEmpty,
  serializeFilter,
  todoCounts,
  type BudgetCondition,
  type FilterState,
  type TodoBucket,
} from '@/lib/filters';
import { REGIONS } from '@/lib/regions';
import { bulkSyncWhatsAppChats, type BulkSyncResult } from '@/lib/bulk-sync';
import { syncWhatsAppLabels, type LabelSyncResult } from '@/lib/label-sync';
import {
  runBulkExtract,
  findExtractTargets,
  type BulkExtractProgress,
} from '@/lib/bulk-extract';
import {
  cleanupVehicleInterests,
  type VehicleCleanupResult,
} from '@/lib/vehicle-cleanup';
import {
  scanForMismatches,
  repairMismatched,
  type RepairResult,
} from '@/lib/repair-extraction';
import { stringifyError } from '@/lib/errors';

const HAS_QWEN_KEY = Boolean(import.meta.env.VITE_DASHSCOPE_API_KEY);

interface Props {
  contacts: CrmContact[];
  loading: boolean;
  orgId: string;
  onFilterChange: (filtered: CrmContact[] | null) => void;
  onRefresh: () => void;
  onCollapse?: () => void;
  clearSignal?: number;
}

const QUALITIES: { id: CustomerQuality; label: string; icon: string }[] = [
  { id: 'big', label: '大客户', icon: '⭐⭐⭐' },
  { id: 'potential', label: '有潜力', icon: '⭐⭐' },
  { id: 'normal', label: '普通', icon: '⭐' },
  { id: 'spam', label: '垃圾', icon: '🗑' },
];

const STAGES: { id: CustomerStage; label: string }[] = [
  { id: 'new', label: '新客户' },
  { id: 'negotiating', label: '跟进中' },
  { id: 'stalled', label: '待跟进' },
  { id: 'quoted', label: '已报价' },
  { id: 'won', label: '成交' },
  { id: 'lost', label: '流失' },
];

type SectionKey = 'stage' | 'quality' | 'region' | 'vehicle' | 'budget';

function CollapsibleSection(props: {
  title: string;
  icon: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="sgc-filter-section">
      <button className="sgc-filter-section-header" onClick={props.onToggle}>
        <span className="sgc-filter-section-icon">{props.icon}</span>
        <span className="sgc-filter-section-title">{props.title}</span>
        {props.count != null && props.count > 0 && (
          <span className="sgc-filter-section-badge">{props.count}</span>
        )}
        <span className="sgc-filter-section-chevron">
          {props.open ? '▾' : '▸'}
        </span>
      </button>
      {props.open && (
        <div className="sgc-filter-section-body">{props.children}</div>
      )}
    </div>
  );
}

function Chip(props: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={
        'sgc-filter-chip' + (props.active ? ' sgc-filter-chip-active' : '')
      }
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      {props.count != null && (
        <span className="sgc-filter-chip-count">{props.count}</span>
      )}
    </button>
  );
}

const FILTER_KEY = 'sgc:filter-state';

export function FilterSidebar({
  contacts,
  loading,
  orgId,
  onFilterChange,
  onRefresh,
  onCollapse,
  clearSignal,
}: Props) {
  const [filter, setFilter] = useState<FilterState>(emptyFilter);
  const [filterLoaded, setFilterLoaded] = useState(false);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set());

  // Load persisted filter on mount
  useEffect(() => {
    void chrome.storage.local.get(FILTER_KEY).then((r) => {
      const restored = deserializeFilter(r[FILTER_KEY]);
      setFilter(restored);
      setFilterLoaded(true);
    });
  }, []);

  // Re-apply filter when contacts change after initial load
  useEffect(() => {
    if (!filterLoaded) return;
    if (isFilterEmpty(filter)) {
      onFilterChange(null);
    } else {
      onFilterChange(applyFilter(contacts, filter));
    }
  }, [filterLoaded, contacts, filter, onFilterChange]);

  // External clear (e.g. user clicks X on FilteredChatList)
  useEffect(() => {
    if (clearSignal && clearSignal > 0) {
      setFilter(emptyFilter());
    }
  }, [clearSignal]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<BulkSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [labelSyncing, setLabelSyncing] = useState(false);
  const [labelResult, setLabelResult] = useState<LabelSyncResult | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [extractRunning, setExtractRunning] = useState(false);
  const [extractProgress, setExtractProgress] = useState<BulkExtractProgress | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [pendingExtractCount, setPendingExtractCount] = useState<number | null>(null);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<VehicleCleanupResult | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [repairRunning, setRepairRunning] = useState(false);
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const [overrideNonce, setOverrideNonce] = useState(0);
  const [collapsedBrands, setCollapsedBrands] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadBrandOverrides().then(() => setOverrideNonce((n) => n + 1));
    return subscribeBrandOverrides(() => setOverrideNonce((n) => n + 1));
  }, []);

  useEffect(() => {
    void chrome.storage.local.get('sgc:collapsed-brands').then((r) => {
      const arr = r['sgc:collapsed-brands'];
      if (Array.isArray(arr)) setCollapsedBrands(new Set(arr));
    });
  }, []);

  const toggleBrandCollapsed = (brand: string) => {
    const next = new Set(collapsedBrands);
    if (next.has(brand)) next.delete(brand);
    else next.add(brand);
    setCollapsedBrands(next);
    void chrome.storage.local.set({ 'sgc:collapsed-brands': Array.from(next) });
  };

  const reassignBrand = async (model: string, currentBrand: string) => {
    const input = prompt(
      `把 "${model}" 归到哪个品牌组？\n（当前：${currentBrand}）\n留空 = 恢复自动识别`,
      currentBrand,
    );
    if (input == null) return;
    await saveBrandOverride(model, input);
  };

  const runCleanup = async () => {
    setCleanupRunning(true);
    setCleanupError(null);
    setCleanupResult(null);
    try {
      const result = await cleanupVehicleInterests(orgId);
      setCleanupResult(result);
      onRefresh();
    } catch (err) {
      setCleanupError(stringifyError(err));
    } finally {
      setCleanupRunning(false);
    }
  };

  const runRepair = async () => {
    setRepairRunning(true);
    setRepairError(null);
    setRepairResult(null);
    try {
      const scan = await scanForMismatches(orgId);
      if (scan.mismatched.length === 0) {
        setRepairResult({
          contactsRepaired: 0,
          vehiclesRemoved: 0,
          errors: 0,
          errorMessages: [],
        });
        return;
      }
      const ok = window.confirm(
        `找到 ${scan.mismatched.length} 个客户的国家与手机号区号不匹配，可能是早期 AI 错抽。\n\n点确定将：\n• 重置国家为手机号对应的国家\n• 清空 语言 / 预算 / 目的港\n• 删除这些客户的所有车型兴趣\n• 标记为待重抽（下次批量抽取会重做）\n\n姓名 / 备注 / 阶段 / 标签 不动。\n\n继续吗？`,
      );
      if (!ok) {
        setRepairRunning(false);
        return;
      }
      const result = await repairMismatched(scan.mismatched);
      setRepairResult(result);
      onRefresh();
    } catch (err) {
      setRepairError(stringifyError(err));
    } finally {
      setRepairRunning(false);
    }
  };

  const checkPending = async () => {
    setExtractError(null);
    try {
      const targets = await findExtractTargets(orgId);
      setPendingExtractCount(targets.length);
    } catch (err) {
      setExtractError(stringifyError(err));
    }
  };

  const runExtract = async () => {
    if (!HAS_QWEN_KEY) {
      setExtractError('未配置 Qwen API key');
      return;
    }
    if (
      !confirm(
        '批量抽取会自动切换 WhatsApp 聊天（影响你正常浏览）。确认开始？',
      )
    )
      return;
    setExtractRunning(true);
    setExtractError(null);
    stopRef.current = false;
    try {
      await runBulkExtract({
        orgId,
        perMinute: 4,
        onProgress: (p) => setExtractProgress(p),
        shouldStop: () => stopRef.current,
      });
      onRefresh();
    } catch (err) {
      setExtractError(stringifyError(err));
    } finally {
      setExtractRunning(false);
      void checkPending();
    }
  };

  const stopExtract = () => {
    stopRef.current = true;
  };

  const runBulkSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await bulkSyncWhatsAppChats(orgId);
      setSyncResult(result);
      if (result.added > 0) onRefresh();
    } catch (err) {
      setSyncError(stringifyError(err));
    } finally {
      setSyncing(false);
    }
  };

  const runLabelSync = async () => {
    setLabelSyncing(true);
    setLabelError(null);
    setLabelResult(null);
    try {
      const result = await syncWhatsAppLabels(orgId);
      setLabelResult(result);
      onRefresh();
    } catch (err) {
      setLabelError(stringifyError(err));
    } finally {
      setLabelSyncing(false);
    }
  };

  const todos = useMemo(() => todoCounts(contacts), [contacts]);

  const availableModels = useMemo(() => {
    const byBrand = new Map<string, Map<string, number>>();
    for (const c of contacts) {
      for (const v of c.vehicleInterests) {
        const brand = brandOf(v.model);
        const modelMap = byBrand.get(brand) ?? new Map<string, number>();
        modelMap.set(v.model, (modelMap.get(v.model) ?? 0) + 1);
        byBrand.set(brand, modelMap);
      }
    }
    return Array.from(byBrand.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([brand, models]) => ({
        brand,
        models: Array.from(models.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([m, count]) => ({ model: m, count })),
      }));
  }, [contacts, overrideNonce]);

  const countsByDimension = useMemo(() => {
    const stages: Record<string, number> = {};
    const qualities: Record<string, number> = {};
    const regions: Record<string, number> = {};
    const countriesByRegion: Record<string, Map<string, number>> = {};
    for (const c of contacts) {
      if (c.chat?.archive) continue;
      if (c.contact?.quality === 'spam' && !filter.includeSpam) continue;
      if (c.contact?.customer_stage) {
        stages[c.contact.customer_stage] =
          (stages[c.contact.customer_stage] ?? 0) + 1;
      }
      if (c.contact?.quality) {
        qualities[c.contact.quality] =
          (qualities[c.contact.quality] ?? 0) + 1;
      }
      regions[c.region] = (regions[c.region] ?? 0) + 1;
      if (c.contact?.country) {
        const map = countriesByRegion[c.region] ?? new Map<string, number>();
        map.set(c.contact.country, (map.get(c.contact.country) ?? 0) + 1);
        countriesByRegion[c.region] = map;
      }
    }
    return { stages, qualities, regions, countriesByRegion };
  }, [contacts, filter.includeSpam]);

  const filtered = useMemo(
    () => (isFilterEmpty(filter) ? null : applyFilter(contacts, filter)),
    [contacts, filter],
  );

  const resultCount = filtered?.length ?? 0;

  const update = (next: FilterState) => {
    setFilter(next);
    void chrome.storage.local.set({ [FILTER_KEY]: serializeFilter(next) });
    const f = isFilterEmpty(next) ? null : applyFilter(contacts, next);
    onFilterChange(f);
  };

  const toggleSection = (key: SectionKey) => {
    const next = new Set(openSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenSections(next);
  };

  const toggleSet = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  const reset = () => update(emptyFilter());

  const budgetBuckets =
    filter.budgetCondition === 'used' ? BUDGET_BUCKETS_USED : BUDGET_BUCKETS_NEW;

  return (
    <div className="sgc-filter-sidebar">
      <div className="sgc-filter-header">
        <span className="sgc-filter-heading">🔍 筛选客户</span>
        <div className="sgc-filter-header-actions">
          {!isFilterEmpty(filter) && (
            <button className="sgc-filter-reset" onClick={reset}>
              清空
            </button>
          )}
          {onCollapse && (
            <button
              className="sgc-filter-collapse"
              onClick={onCollapse}
              title="收起筛选栏"
              aria-label="收起筛选栏"
            >
              ◀
            </button>
          )}
        </div>
      </div>

      {loading && <div className="sgc-filter-loading">加载中…</div>}

      <div className="sgc-filter-sync">
        <button
          className="sgc-btn-secondary sgc-filter-sync-btn"
          onClick={runBulkSync}
          disabled={syncing}
        >
          {syncing ? '同步中…' : '🔄 同步 WhatsApp 聊天'}
        </button>
        {syncResult && (
          <div className="sgc-filter-sync-result">
            {syncResult.added > 0
              ? `✓ 新增 ${syncResult.added} 个客户`
              : '✓ 全部已同步'}
            {syncResult.skippedNoPhone > 0 &&
              ` · 跳过 ${syncResult.skippedNoPhone} 个无号码`}
          </div>
        )}
        {syncError && (
          <div className="sgc-filter-sync-error">{syncError}</div>
        )}

        <button
          className="sgc-btn-secondary sgc-filter-sync-btn"
          onClick={runLabelSync}
          disabled={labelSyncing}
        >
          {labelSyncing ? '同步标签中…' : '🏷 同步 WhatsApp 标签'}
        </button>
        {labelResult && (
          <div className="sgc-filter-sync-result">
            ✓ 已分类 {labelResult.contactsTouched} 个客户：
            质量 {labelResult.qualityUpdated} ·
            阶段 {labelResult.stageUpdated} ·
            国家 {labelResult.countryUpdated} ·
            车型 {labelResult.vehiclesAdded} ·
            标签 {labelResult.tagsAdded}
          </div>
        )}
        {labelError && (
          <div className="sgc-filter-sync-error">{labelError}</div>
        )}

        {!extractRunning ? (
          <>
            <button
              className="sgc-btn-secondary sgc-filter-sync-btn"
              onClick={() => {
                if (pendingExtractCount === null) {
                  void checkPending();
                } else {
                  void runExtract();
                }
              }}
              disabled={!HAS_QWEN_KEY}
              title={!HAS_QWEN_KEY ? '需要先配 Qwen key' : ''}
            >
              {pendingExtractCount === null
                ? '🤖 检查待抽取客户'
                : `🤖 开始抽取 ${pendingExtractCount} 个`}
            </button>
            {pendingExtractCount === 0 && (
              <div className="sgc-filter-sync-result">
                ✓ 所有客户已抽取过
              </div>
            )}
          </>
        ) : (
          <div className="sgc-filter-extract-running">
            <div className="sgc-filter-extract-progress">
              {extractProgress
                ? `${extractProgress.done} / ${extractProgress.total}` +
                  (extractProgress.errors > 0
                    ? ` (${extractProgress.errors} 错误)`
                    : '')
                : '准备中…'}
            </div>
            {extractProgress?.current && (
              <div className="sgc-filter-extract-current">
                正在: {extractProgress.current}
              </div>
            )}
            <button
              className="sgc-btn-secondary sgc-filter-sync-btn"
              onClick={stopExtract}
            >
              ⏸ 停止
            </button>
          </div>
        )}
        {extractError && (
          <div className="sgc-filter-sync-error">{extractError}</div>
        )}

        <button
          className="sgc-btn-secondary sgc-filter-sync-btn"
          onClick={runCleanup}
          disabled={cleanupRunning}
        >
          {cleanupRunning ? '清理中…' : '🧹 合并重复车型'}
        </button>
        {cleanupResult && (
          <div className="sgc-filter-sync-result">
            ✓ 扫描 {cleanupResult.scanned} · 改名 {cleanupResult.renamed} · 删重复 {cleanupResult.deleted} · 删噪音 {cleanupResult.noiseDeleted}
          </div>
        )}
        {cleanupError && (
          <div className="sgc-filter-sync-error">{cleanupError}</div>
        )}

        <button
          className="sgc-btn-secondary sgc-filter-sync-btn"
          onClick={runRepair}
          disabled={repairRunning}
        >
          {repairRunning ? '修复中…' : '🛠 修复 AI 错抽'}
        </button>
        {repairResult && (
          <div className="sgc-filter-sync-result">
            {repairResult.contactsRepaired === 0
              ? '✓ 没有发现需修复的客户'
              : `✓ 修复 ${repairResult.contactsRepaired} 个客户 · 删车型 ${repairResult.vehiclesRemoved}` +
                (repairResult.errors > 0
                  ? ` · ${repairResult.errors} 错误`
                  : '')}
          </div>
        )}
        {repairError && (
          <div className="sgc-filter-sync-error">{repairError}</div>
        )}
      </div>

      <div className="sgc-filter-today">
        <div className="sgc-filter-today-title">🚨 今日待办</div>
        {[
          { id: 'needs_reply', icon: '⚠️', label: '我该回', count: todos.needs_reply },
          { id: 'negotiating', icon: '🔥', label: '谈判中', count: todos.negotiating },
          { id: 'priority', icon: '⭐', label: '重点客户', count: todos.priority },
          { id: 'stalled', icon: '💤', label: '长期未联系', count: todos.stalled },
          { id: 'new', icon: '🆕', label: '新客户', count: todos.new },
        ].map((b) => (
          <button
            key={b.id}
            className={
              'sgc-filter-todo-item' +
              (filter.todoBucket === b.id
                ? ' sgc-filter-todo-item-active'
                : '')
            }
            onClick={() =>
              update({
                ...filter,
                todoBucket:
                  filter.todoBucket === (b.id as TodoBucket)
                    ? null
                    : (b.id as TodoBucket),
              })
            }
          >
            <span className="sgc-filter-todo-icon">{b.icon}</span>
            <span className="sgc-filter-todo-label">{b.label}</span>
            <span className="sgc-filter-todo-count">{b.count}</span>
          </button>
        ))}
      </div>

      <div className="sgc-filter-sep">多维筛选</div>

      <CollapsibleSection
        title="阶段"
        icon="🎯"
        count={filter.stages.size}
        open={openSections.has('stage')}
        onToggle={() => toggleSection('stage')}
      >
        {STAGES.map((s) => (
          <Chip
            key={s.id}
            label={s.label}
            count={countsByDimension.stages[s.id] ?? 0}
            active={filter.stages.has(s.id)}
            onClick={() =>
              update({ ...filter, stages: toggleSet(filter.stages, s.id) })
            }
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection
        title="质量"
        icon="⭐"
        count={filter.qualities.size}
        open={openSections.has('quality')}
        onToggle={() => toggleSection('quality')}
      >
        {QUALITIES.map((q) => (
          <Chip
            key={q.id}
            label={`${q.icon} ${q.label}`}
            count={countsByDimension.qualities[q.id] ?? 0}
            active={filter.qualities.has(q.id)}
            onClick={() =>
              update({
                ...filter,
                qualities: toggleSet(filter.qualities, q.id),
                includeSpam: q.id === 'spam' ? true : filter.includeSpam,
              })
            }
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection
        title="区域"
        icon="🌍"
        count={filter.regions.size + filter.countries.size}
        open={openSections.has('region')}
        onToggle={() => toggleSection('region')}
      >
        {REGIONS.map((r) => {
          const active = filter.regions.has(r.id);
          const count = countsByDimension.regions[r.id] ?? 0;
          if (count === 0) return null;
          const countryCounts = countsByDimension.countriesByRegion[r.id];
          const countriesWithData = countryCounts
            ? Array.from(countryCounts.entries()).sort((a, b) => b[1] - a[1])
            : [];
          return (
            <div key={r.id} className="sgc-filter-region">
              <Chip
                label={`${r.emoji} ${r.name}`}
                count={count}
                active={active}
                onClick={() =>
                  update({
                    ...filter,
                    regions: toggleSet(filter.regions, r.id),
                  })
                }
              />
              {active && countriesWithData.length > 0 && (
                <div className="sgc-filter-subcountries">
                  {countriesWithData.map(([c, n]) => (
                    <Chip
                      key={c}
                      label={c}
                      count={n}
                      active={filter.countries.has(c)}
                      onClick={() =>
                        update({
                          ...filter,
                          countries: toggleSet(filter.countries, c),
                        })
                      }
                    />
                  ))}
                </div>
              )}
              {active && countriesWithData.length === 0 && (
                <div className="sgc-filter-empty">
                  这些客户还没识别国家（开聊天会自动 AI 抽取）
                </div>
              )}
            </div>
          );
        })}
      </CollapsibleSection>

      <CollapsibleSection
        title="车型"
        icon="🚗"
        count={filter.vehicleModels.size}
        open={openSections.has('vehicle')}
        onToggle={() => toggleSection('vehicle')}
      >
        {availableModels.length === 0 && (
          <div className="sgc-filter-empty">暂无车型数据</div>
        )}
        {availableModels.map(({ brand, models }) => {
          const isCollapsed = collapsedBrands.has(brand);
          const totalCount = models.reduce((sum, m) => sum + m.count, 0);
          return (
            <div key={brand} className="sgc-filter-brand">
              <button
                className="sgc-filter-brand-title sgc-filter-brand-toggle"
                onClick={() => toggleBrandCollapsed(brand)}
                title="点击收起/展开"
              >
                <span className="sgc-filter-brand-chevron">
                  {isCollapsed ? '▸' : '▾'}
                </span>
                <span className="sgc-filter-brand-name">{brand}</span>
                <span className="sgc-filter-brand-count">{totalCount}</span>
              </button>
              {!isCollapsed &&
                models.map(({ model, count }) => (
                  <div
                    key={model}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void reassignBrand(model, brand);
                    }}
                    title="右键改品牌分组"
                  >
                    <Chip
                      label={model}
                      count={count}
                      active={filter.vehicleModels.has(model)}
                      onClick={() =>
                        update({
                          ...filter,
                          vehicleModels: toggleSet(
                            filter.vehicleModels,
                            model,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
            </div>
          );
        })}
      </CollapsibleSection>

      <CollapsibleSection
        title="预算"
        icon="💰"
        count={filter.budgetBuckets.size}
        open={openSections.has('budget')}
        onToggle={() => toggleSection('budget')}
      >
        <div className="sgc-filter-seg">
          {(['all', 'new', 'used'] as BudgetCondition[]).map((c) => (
            <button
              key={c}
              className={
                'sgc-filter-seg-btn' +
                (filter.budgetCondition === c
                  ? ' sgc-filter-seg-btn-active'
                  : '')
              }
              onClick={() =>
                update({
                  ...filter,
                  budgetCondition: c,
                  budgetBuckets: new Set(),
                })
              }
            >
              {c === 'all' ? '全部' : c === 'new' ? '新车' : '二手'}
            </button>
          ))}
        </div>
        {budgetBuckets.map((b) => (
          <Chip
            key={b.id}
            label={b.label}
            active={filter.budgetBuckets.has(b.id)}
            onClick={() =>
              update({
                ...filter,
                budgetBuckets: toggleSet(filter.budgetBuckets, b.id),
              })
            }
          />
        ))}
      </CollapsibleSection>

      {filtered && (
        <div className="sgc-filter-result-count">
          筛选结果 <b>{resultCount}</b> 个
        </div>
      )}
    </div>
  );
}
