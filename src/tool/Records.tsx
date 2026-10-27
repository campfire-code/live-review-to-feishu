// 记录页：读取飞书表里的记录，搜索、编辑（含加群 / 加微补录）、删除。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { openLink } from '../kit/platform';
import { flatCell, msToDate, parseAllocation, type WechatFan } from './core';
import { diffEdit } from './flow';
import type { FieldInfo, RecordInfo } from './feishu';
import type { Env } from './env';

const SHOW: [string, string][] = [['主播', '主播'], ['日期', '日期'], ['加群数', '加群'], ['加微总数', '加微'], ['加微率', '加微率'], ['抖音-收获音浪', '抖音音浪'], ['抖音-曝光人数', '抖音曝光'], ['视频号-观看人数', '视频号观看'], ['快手-直播观众数', '快手观众'], ['识别方式', '识别方式']];
const DERIVED = new Set(['加群数', '加微总数', '加微率', '私域分配']);

const show = (v: unknown, type: number) => {
  if (type === 5 && typeof v === 'number') return msToDate(v);
  return flatCell(v) || '—';
};

export function Records({ env, reloadKey }: { env: Env; reloadKey: number }) {
  const [rows, setRows] = useState<RecordInfo[]>([]);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<RecordInfo | null>(null);
  const [delId, setDelId] = useState('');
  const ready = Boolean(env.cfg.appToken && env.cfg.tableId);

  const load = useCallback(async () => {
    if (!ready) { setRows([]); return; }
    setLoading(true); setErr('');
    try {
      const c = env.client();
      const [f, r] = await Promise.all([c.listFields(), c.listRecords()]);
      setFields(f);
      setRows(r.sort((a, b) => Number(b.fields['日期'] ?? 0) - Number(a.fields['日期'] ?? 0)));
      env.log(`已读取 ${r.length} 条记录`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [ready, env.cfg.appToken, env.cfg.tableId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, reloadKey]);

  const typeOf = (n: string) => fields.find((f) => f.field_name === n)?.type ?? 1;
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? rows.filter((r) => `${flatCell(r.fields['主播'])} ${show(r.fields['日期'], 5)} ${flatCell(r.fields['备注'])}`.toLowerCase().includes(k)) : rows;
  }, [rows, q]);

  const remove = async (id: string) => {
    try { await env.client().deleteRecord(id); env.log('已删除一条记录', 'ok'); setDelId(''); setRows((r) => r.filter((x) => x.record_id !== id)); }
    catch (e) { setErr(`删除失败：${e instanceof Error ? e.message : String(e)}`); }
  };

  if (!ready) return <div className="k-panel lr-empty"><p><b>还没有连接飞书多维表格</b></p><p className="k-muted">先在「录入」写入一条（会自动建表），或到「飞书设置」填写已有表格的链接。</p></div>;
  return (
    <div className="lr-records">
      <div className="lr-bar">
        <label className="lr-search"><Search size={14} className="k-muted" /><input className="k-input" placeholder="搜主播、日期、备注" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索记录" /></label>
        <span className="k-muted k-num">共 {rows.length} 条{q.trim() ? `，匹配 ${list.length}` : ''}</span>
        <span className="lr-grow" />
        <button className="k-btn" disabled={loading} onClick={() => void load()}>{loading ? <Loader2 size={14} className="k-spin" /> : <RefreshCw size={14} />}同步</button>
        {env.cfg.tableUrl && <button className="k-btn" onClick={() => void openLink(env.cfg.tableUrl)}><ExternalLink size={14} />打开飞书表格</button>}
      </div>
      {err && <div className="k-notice err" role="alert"><span>{err}</span></div>}
      <div className="k-panel k-table-wrap">
        <table className="k-table">
          <thead><tr>{SHOW.map(([, t]) => <th key={t}>{t}</th>)}<th>操作</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.record_id}>
                {SHOW.map(([k]) => <td key={k} className={k === '主播' ? '' : 'k-num'}>{show(r.fields[k], typeOf(k))}</td>)}
                <td>
                  {delId === r.record_id ? (
                    <span className="lr-inline"><span className="k-err-text">确认删除？</span><button className="k-btn" onClick={() => void remove(r.record_id)}>删除</button><button className="k-btn ghost" onClick={() => setDelId('')}>取消</button></span>
                  ) : (
                    <span className="lr-inline">
                      <button className="k-icon-btn" aria-label="编辑" title="编辑 / 补录加微" onClick={() => setEdit(r)}><Pencil size={14} /></button>
                      <button className="k-icon-btn" aria-label="删除" title="删除" onClick={() => setDelId(r.record_id)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={SHOW.length + 1} className="k-muted lr-none">{loading ? '读取中…' : rows.length ? '没有匹配的记录' : '表里还没有记录'}</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <EditDialog env={env} rec={edit} fields={fields} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

function EditDialog({ env, rec, fields, onClose, onSaved }: { env: Env; rec: RecordInfo; fields: FieldInfo[]; onClose: () => void; onSaved: () => void }) {
  const editable = fields.filter((f) => !DERIVED.has(f.field_name) && f.type !== 17 && f.type !== 18 && f.type !== 11);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((f) => [f.field_name, f.type === 5 && typeof rec.fields[f.field_name] === 'number' ? msToDate(rec.fields[f.field_name] as number) : flatCell(rec.fields[f.field_name])])));
  const [group, setGroup] = useState(flatCell(rec.fields['加群数']));
  const [fans, setFans] = useState<WechatFan[]>(() => parseAllocation(flatCell(rec.fields['私域分配'])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const patch = diffEdit(rec.fields, fields, { values, groupCount: group, fans });
  const total = fans.reduce((s, f) => s + (Number.isFinite(f.count) ? f.count : 0), 0);
  const save = async () => {
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true); setErr('');
    try { await env.client().updateRecord(rec.record_id, patch); env.log(`已更新记录：${Object.keys(patch).length} 个字段`, 'ok'); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const names = [...new Set([...env.wechats.map((w) => w.name), ...fans.map((f) => f.name)].filter(Boolean))];
  return (
    <div className="lr-mask" role="dialog" aria-modal="true" aria-label="编辑记录">
      <div className="k-panel lr-modal">
        <header><b>编辑记录</b><span className="k-muted">{flatCell(rec.fields['主播'])} · {show(rec.fields['日期'], 5)}</span><span className="lr-grow" /><button className="k-icon-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
        <div className="lr-modal-body k-scroll">
          <section className="lr-fans">
            <h4>加微补录 <span className="k-muted">（第二天填各微信号加粉数，自动算加微总数和加微率）</span></h4>
            <label className="lr-m"><span>加群数</span><input className="k-input" type="number" min={0} value={group} onChange={(e) => setGroup(e.target.value)} /></label>
            {fans.map((f, i) => (
              <div key={i} className="lr-inline">
                <input className="k-input" list="lr-wechats" placeholder="微信号" value={f.name} onChange={(e) => setFans((a) => a.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="k-input lr-num" type="number" min={0} aria-label="加粉数" value={Number.isFinite(f.count) ? f.count : ''} onChange={(e) => setFans((a) => a.map((x, j) => (j === i ? { ...x, count: e.target.value === '' ? NaN : Number(e.target.value) } : x)))} />
                <button className="k-icon-btn" aria-label="删除这行" onClick={() => setFans((a) => a.filter((_, j) => j !== i))}><X size={14} /></button>
              </div>
            ))}
            <datalist id="lr-wechats">{names.map((n) => <option key={n} value={n} />)}</datalist>
            <div className="lr-inline"><button className="k-btn" onClick={() => setFans((a) => [...a, { name: '', count: 0 }])}><Plus size={14} />添加微信号</button><span className="k-muted k-num">加微总数 {total}{Number(group) > 0 ? ` · 加微率 ${((total * 100) / Number(group)).toFixed(1)}%` : ''}</span></div>
          </section>
          <section className="lr-edit-grid">
            {editable.map((f) => (
              <label key={f.field_id} className="lr-m"><span>{f.field_name}</span>
                <input className="k-input" type={f.type === 5 ? 'date' : 'text'} inputMode={f.type === 2 ? 'decimal' : undefined} value={values[f.field_name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.field_name]: e.target.value }))} />
              </label>
            ))}
          </section>
        </div>
        {err && <p className="k-err-text lr-pad">{err}</p>}
        <footer><span className="k-muted">{Object.keys(patch).length ? `将更新 ${Object.keys(patch).length} 个字段` : '没有改动'}</span><button className="k-btn" onClick={onClose}>取消</button><button className="k-btn primary" disabled={busy} onClick={() => void save()}>{busy && <Loader2 size={14} className="k-spin" />}保存修改</button></footer>
      </div>
    </div>
  );
}
