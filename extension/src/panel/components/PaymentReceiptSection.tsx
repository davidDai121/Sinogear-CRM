/**
 * 「✅ 已收水单」—— 把客户置为成交的唯一入口。
 *
 * 为什么（2026-08-19 boss 定的口径）：客户发来水单（银行回单）才算成交。
 * 在这之前 won 是 AI 从回复文本里解析出来的，实测有还在砍价的客户被标成成交。
 * AI 那条路已经在 useAutoFbStage 里堵死，客户阶段下拉里的「成交」也已禁用，
 * 所以现在只剩这个按钮能产生 won —— 每点一次都在 contact_events 留一条
 * payment_received 事件当凭证（append-only，事后删不掉）。
 *
 * 水单图片是「建议传」不是「必须传」：销售在 WhatsApp 里干活，强制上传会
 * 直接把这个按钮变成第二个没人用的 tasks 表。没传图的确认照样入库，
 * 但会被标成「未附水单图」，复核清单里挑得出来。
 */
import { useEffect, useRef, useState } from 'react';
import { uploadToCloudinary, isCloudinaryConfigured } from '@/lib/cloudinary';
import {
  confirmPaymentReceived,
  fetchLatestReceipt,
  type PaymentReceipt,
} from '@/lib/payment-receipt';
import { stringifyError } from '@/lib/errors';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  contact: ContactRow;
  /** 事件写成功之后才调用，把 stage 落成 won（走 useContact.save，顺带记 stage_changed） */
  onConfirmed: () => Promise<void>;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function PaymentReceiptSection({ contact, onConfirmed }: Props) {
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isWon = contact.customer_stage === 'won';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOpen(false);
    setFile(null);
    setAmount('');
    setNote('');
    setError(null);
    void (async () => {
      const r = await fetchLatestReceipt(contact.id);
      if (cancelled) return;
      setReceipt(r);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id]);

  const submit = async () => {
    setError(null);
    try {
      let receiptUrl: string | null = null;
      let publicId: string | null = null;
      if (file) {
        setBusy('上传水单…');
        const res = await uploadToCloudinary(
          file,
          file.type.startsWith('image/') ? 'image' : 'spec',
          { folder: 'payment-receipts' },
        );
        receiptUrl = res.secure_url;
        publicId = res.public_id;
      }
      setBusy('记录中…');
      const saved = await confirmPaymentReceived(contact.id, {
        receiptUrl,
        receiptPublicId: publicId,
        fileName: file?.name ?? null,
        amountUsd: amount ? Number(amount) : null,
        note: note.trim() || null,
      });
      // 凭证落库成功之后才动 stage —— 反过来的话，事件写失败就会留下
      // 一个又是 won、又没有任何凭证的客户，正是这次要消灭的东西。
      if (!isWon) {
        setBusy('标记成交…');
        await onConfirmed();
      }
      setReceipt(saved);
      setOpen(false);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;

  const form = open && (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      {isCloudinaryConfigured() ? (
        <label style={{ display: 'grid', gap: 3, fontSize: 12 }}>
          <span>水单图片 / PDF（建议传，事后对账全靠它）</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 11 }}
          />
        </label>
      ) : (
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          （Cloudinary 未配置，本次只能记文字，不能存水单图）
        </span>
      )}
      <label style={{ display: 'grid', gap: 3, fontSize: 12 }}>
        <span>到账金额 USD（可留空）</span>
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="7300"
        />
      </label>
      <label style={{ display: 'grid', gap: 3, fontSize: 12 }}>
        <span>备注（车型 / 定金还是全款 / 谁核对的）</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="秦Plus 1台 定金，David 核过"
        />
      </label>
      {!file && (
        <span style={{ fontSize: 11, color: '#9a6700' }}>
          没附水单图也能确认，但会被记成「未附水单图」，复核时要重新找证据。
        </span>
      )}
      {error && (
        <span style={{ fontSize: 11, color: '#b91c1c', wordBreak: 'break-word' }}>
          ⚠️ {error}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="sgc-btn-primary"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={!!busy}
          onClick={() => void submit()}
        >
          {busy ?? (isWon ? '补录水单' : '确认收到水单，标记成交')}
        </button>
        <button
          type="button"
          className="sgc-btn-secondary"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={!!busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          取消
        </button>
      </div>
    </div>
  );

  // 已成交 + 有水单 → 绿的，显示凭证
  if (isWon && receipt) {
    return (
      <div className="sgc-sales-signal sgc-sales-signal-success">
        <strong>✅ 已收水单 · {fmtDate(receipt.confirmedAt)}</strong>
        <span>
          {receipt.amountUsd != null ? `到账 $${receipt.amountUsd.toLocaleString()}` : '金额未填'}
          {receipt.note ? ` · ${receipt.note}` : ''}
          {receipt.receiptUrl ? ' · ' : ' · 未附水单图'}
          {receipt.receiptUrl && (
            <a href={receipt.receiptUrl} target="_blank" rel="noreferrer">
              查看水单
            </a>
          )}
        </span>
      </div>
    );
  }

  // 已成交 + 没水单 → 这就是要人工复核的那批
  if (isWon && !receipt) {
    return (
      <div className="sgc-sales-signal sgc-sales-signal-danger">
        <strong>⚠️ 这单没有水单凭证</strong>
        <span>
          可能是 8/19 之前 AI 自动标的。收到水单请点「补录水单」；
          如果客户其实还没付款，把上面的客户阶段改回「已报价」。
        </span>
        {!open && (
          <div>
            <button
              type="button"
              className="sgc-btn-secondary"
              style={{ fontSize: 11, padding: '2px 8px', marginTop: 4 }}
              onClick={() => setOpen(true)}
            >
              补录水单
            </button>
          </div>
        )}
        {form}
      </div>
    );
  }

  // 未成交 → 唯一能置 won 的入口
  return (
    <div className="sgc-sales-signal sgc-sales-signal-info">
      <strong>💳 收到水单了吗？</strong>
      <span>客户发来银行回单才算成交 —— 只能从这里标，AI 和下拉框都不行。</span>
      {!open && (
        <div>
          <button
            type="button"
            className="sgc-btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px', marginTop: 4 }}
            onClick={() => setOpen(true)}
          >
            ✅ 已收水单
          </button>
        </div>
      )}
      {form}
    </div>
  );
}
