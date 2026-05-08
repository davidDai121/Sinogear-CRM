import { useEffect, useRef, useState } from 'react';
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
  orgId: string;
  onRefresh: () => void;
}

const MAINT_OPEN_KEY = 'sgc:maint-open';

export function FilterMaintenancePanel({ orgId, onRefresh }: Props) {
  const [open, setOpen] = useState(false);

  // 持久化展开状态（默认折叠）
  useEffect(() => {
    void chrome.storage.local.get(MAINT_OPEN_KEY).then((s) => {
      if (s[MAINT_OPEN_KEY] === true) setOpen(true);
    });
  }, []);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    void chrome.storage.local.set({ [MAINT_OPEN_KEY]: next });
  };

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

  return (
    <div className="sgc-filter-sync">
      <button
        type="button"
        className="sgc-maint-toggle"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        <span className="sgc-maint-toggle-label">🔧 维护工具</span>
        <span className="sgc-maint-toggle-caret">{open ? '▾' : '▸'}</span>
      </button>

      {!open ? null : <>
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
      {syncError && <div className="sgc-filter-sync-error">{syncError}</div>}

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
      {labelError && <div className="sgc-filter-sync-error">{labelError}</div>}

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
            <div className="sgc-filter-sync-result">✓ 所有客户已抽取过</div>
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
              (repairResult.errors > 0 ? ` · ${repairResult.errors} 错误` : '')}
        </div>
      )}
      {repairError && (
        <div className="sgc-filter-sync-error">{repairError}</div>
      )}
      </>}
    </div>
  );
}
