import { useEffect, useState } from 'react';
import type { Database } from '@/lib/database.types';
import { gptBrowserBindingKey, loadGptBrowserBinding, templateOwner } from '@/lib/gpt-browser-binding';
import { isR08Template } from '@/lib/gpt-template-routing';
import { stringifyError } from '@/lib/errors';

type Template = Database['public']['Tables']['gpt_templates']['Row'];

export function GPTBrowserSettings({ orgId, templates }: { orgId: string; templates: Template[] }) {
  const [general, setGeneral] = useState('');
  const [r08, setR08] = useState('');
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        const binding = await loadGptBrowserBinding(orgId, templateOwner(templates));
        if (cancelled) return;
        setGeneral(binding?.defaultTemplateId ?? '');
        setR08(binding?.r08TemplateId ?? '');
      } catch (e) { if (!cancelled) setNotice(stringifyError(e)); }
      finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, [orgId, templates]);
  const save = async (reset = false) => {
    setReady(false);
    try {
      const key = gptBrowserBindingKey(orgId, templateOwner(templates));
      if (reset) {
        await chrome.storage.local.remove(key);
        setGeneral(''); setR08('');
      } else {
        if (!templates.some(t => t.id === general && !isR08Template(t))
          || !templates.some(t => t.id === r08 && isR08Template(t))) throw new Error('请分别选择常用和 R08 GPT。');
        await chrome.storage.local.set({ [key]: { defaultTemplateId: general, r08TemplateId: r08 } });
      }
      setNotice(reset ? '已恢复使用 CRM 默认设置，关闭窗口后生效。' : '已保存到本浏览器，关闭窗口后生效。');
    } catch (e) { setNotice(stringifyError(e)); }
    finally { setReady(true); }
  };
  return <div className="sgc-stack-card">
    <strong>本浏览器的 ChatGPT 入口</strong>
    <div className="sgc-muted">选择当前 ChatGPT 账号能打开的两个 GPT。仅保存在本浏览器，不影响其他浏览器。</div>
    <label className="sgc-field"><span>本浏览器常用 GPT</span>
      <select aria-label="本浏览器常用 GPT" value={general} disabled={!ready} onChange={e => setGeneral(e.target.value)}>
        <option value="">使用 CRM 默认设置</option>
        {templates.filter(t => !isR08Template(t)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
    <label className="sgc-field"><span>本浏览器 R08 GPT</span>
      <select aria-label="本浏览器 R08 GPT" value={r08} disabled={!ready} onChange={e => setR08(e.target.value)}>
        <option value="">请选择</option>
        {templates.filter(isR08Template).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
    <button type="button" className="sgc-btn-primary" disabled={!ready || !general || !r08} onClick={() => void save()}>保存本浏览器入口</button>
    <button type="button" className="sgc-btn-link" disabled={!ready} onClick={() => void save(true)}>恢复 CRM 默认设置</button>
    {notice && <div role="status">{notice}</div>}
  </div>;
}
