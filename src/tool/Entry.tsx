// 录入页：选主播和日期 → 三个平台各放一张截图 → 识别 → 抽检提示 → 核对后写入飞书。
import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, PencilLine, ScanSearch, Send, Trash2, UserPlus, X } from 'lucide-react';
import { pickFiles } from '../kit/platform';
import { useDroppedFiles } from '../kit/parts';
import { llmReady, useSettings } from '../kit/settings';
import { METRICS, PLATFORMS, PLATFORM_NAME, emptyMetrics, guessPlatform, hasBlocking, qaCheck, type Metrics, type Platform, type PlatformMetrics } from './core';
import { recognize, toDataUrl } from './vision';
import { submitRecord } from './flow';
import { newId, saveAnchors, saveSchemaOk } from './store';
import type { Env } from './env';
import { openLink } from '../kit/platform';

export interface EntryState {
  anchorId: string; date: string; groupCount: string; note: string;
  images: Partial<Record<Platform, { name: string; url: string }>>;
  rec: PlatformMetrics;
  engine: string;
  errors: Partial<Record<Platform, string>>;
}
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp'];

/** 过大的图片缩到最长边 2200 像素再发给模型，减小请求体 */
async function prepareImage(bytes: Uint8Array, name: string): Promise<string> {
  const raw = toDataUrl(bytes, name);
  if (bytes.length < 3_000_000) return raw;
  try {
    const img = new Image();
    img.src = raw;
    await img.decode();
    const k = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  } catch { return raw; }
}

const nowDate = () => { const d = new Date(Date.now() + 8 * 3600_000); return d.toISOString().slice(0, 10); };
export const initialEntry = (): EntryState => ({ anchorId: '', date: nowDate(), groupCount: '', note: '', images: {}, rec: {}, engine: '', errors: {} });

type Msg = { kind: 'ok' | 'err'; text: string; link?: string } | null;

export function Entry({ env, st, setSt, setAnchors, afterWrite, readFile }: {
  env: Env; st: EntryState; setSt: (f: (s: EntryState) => EntryState) => void; setAnchors: (a: Env['anchors']) => void; afterWrite: () => void;
  readFile: (p: string) => Promise<Uint8Array>;
}) {
  const settings = useSettings();
  const [busy, setBusy] = useState<'' | 'ocr' | 'send'>('');
  const [msg, setMsg] = useState<Msg>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const targetRef = useRef<Platform | null>(null);
  const anchor = env.anchors.find((a) => a.id === st.anchorId);

  const issues = useMemo(() => qaCheck(st.rec), [st.rec]);
  const blocking = hasBlocking(issues);
  const hasRec = PLATFORMS.some((p) => st.rec[p]);
  const anyValue = PLATFORMS.some((p) => Object.values(st.rec[p] ?? {}).some((v) => v.trim()));
  const set = (p: Partial<EntryState>) => setSt((s) => ({ ...s, ...p }));

  const loadFiles = async (paths: string[], into?: Platform | null) => {
    const files = paths.filter((p) => IMG_EXT.includes(p.split('.').pop()?.toLowerCase() ?? ''));
    if (!files.length) { setMsg({ kind: 'err', text: '只支持 png / jpg / webp 截图' }); return; }
    const imgs: EntryState['images'] = {};
    const free = [...PLATFORMS];
    const take = (p: Platform) => { free.splice(free.indexOf(p), 1); return p; };
    for (const f of files) {
      const name = f.split(/[\\/]/).pop()!;
      const guess = into ?? guessPlatform(name);
      const p = guess && (into || free.includes(guess)) ? (into ? into : take(guess)) : free.length ? take(free[0]) : null;
      if (!p) break;
      imgs[p] = { name, url: await prepareImage(await readFile(f), name) };
      if (into) break;
    }
    setSt((s) => ({ ...s, images: { ...s.images, ...imgs }, rec: Object.fromEntries(Object.entries(s.rec).filter(([k]) => !(k in imgs))), errors: {} }));
    setConfirmed(false);
    setMsg(null);
  };
  const hover = useDroppedFiles((paths) => { void loadFiles(paths); });
  const pick = async (p: Platform) => { targetRef.current = p; const f = await pickFiles(IMG_EXT, '截图'); if (f.length) await loadFiles(f.slice(0, 1), p); };

  const run = async () => {
    const todo = PLATFORMS.filter((p) => st.images[p]);
    if (!todo.length) { setMsg({ kind: 'err', text: '请先放入至少一张截图' }); return; }
    setBusy('ocr'); setMsg(null); setConfirmed(false);
    env.log(`开始识别 ${todo.map((p) => PLATFORM_NAME[p]).join('、')}`);
    const rec: PlatformMetrics = {}; const errors: EntryState['errors'] = {};
    await Promise.all(todo.map(async (p) => {
      try {
        const r = await recognize(p, st.images[p]!.url, env.vision);
        rec[p] = r.metrics;
        if (r.error) { errors[p] = r.error; env.log(`${PLATFORM_NAME[p]}：${r.error}`, 'err'); } else env.log(`${PLATFORM_NAME[p]}识别完成`, 'ok');
      } catch (e) {
        errors[p] = e instanceof Error ? e.message : String(e);
        env.log(`${PLATFORM_NAME[p]}识别失败：${errors[p]}`, 'err');
      }
    }));
    setSt((s) => ({ ...s, rec: { ...s.rec, ...rec }, errors, engine: '大模型看图' }));
    setBusy('');
  };

  const send = async () => {
    setBusy('send'); setMsg(null);
    try {
      const g = st.groupCount.trim() === '' ? null : Number(st.groupCount);
      env.log(`写入飞书：${anchor?.name ?? ''} ${st.date}`);
      const r = await submitRecord(env.client(), { anchor: anchor?.name ?? '', date: st.date, note: st.note, groupCount: g != null && Number.isFinite(g) ? g : null, fans: [], engine: st.engine || '手动填写', metrics: st.rec }, env.schemaOk, (s) => env.log(s));
      await env.saveCfg(r.cfg);
      await saveSchemaOk(r.cfg.appToken + '/' + r.cfg.tableId);
      env.log(`已写入，记录 ${r.recordId}`, 'ok');
      setMsg({ kind: 'ok', text: r.createdTable ? '已写入，并新建了多维表格' : '已写入飞书多维表格', link: r.cfg.tableUrl });
      setSt((s) => ({ ...s, images: {}, rec: {}, errors: {}, engine: '', groupCount: '', note: '' }));
      setConfirmed(false);
      afterWrite();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      env.log(`写入失败：${text}`, 'err');
      setMsg({ kind: 'err', text: `写入失败：${text}` });
    }
    setBusy('');
  };

  const addAnchor = async () => {
    const name = newName.trim();
    if (!name) return;
    const ex = env.anchors.find((a) => a.name === name);
    const list = ex ? env.anchors : [...env.anchors, { id: newId(), name }];
    await saveAnchors(list);
    setAnchors(list);
    set({ anchorId: (ex ?? list[list.length - 1]).id });
    setNewName(''); setAdding(false);
  };
  const delAnchor = async () => {
    if (!anchor) return;
    const list = env.anchors.filter((a) => a.id !== anchor.id);
    await saveAnchors(list); setAnchors(list); set({ anchorId: '' });
  };

  const canSend = !busy && !!anchor && hasRec && anyValue && (!blocking || confirmed) && env.cfg.appId !== '';
  const why = !env.cfg.appId ? '先到「飞书设置」填写 App ID 和 Secret' : !anchor ? '请先选择主播' : !hasRec || !anyValue ? '还没有可写入的指标' : blocking && !confirmed ? '有需要核对的问题，请勾选确认后再写入' : '';

  return (
    <div className="lr-entry">
      {!env.preview && !llmReady(settings.llm) && (
        <div className="k-notice err" role="status"><AlertTriangle size={16} /><span>识别需要支持看图的多模态大模型：请到左侧「设置」填写接口地址、密钥和模型名。也可以不识别，直接手动填写指标。</span></div>
      )}
      <section className="k-panel lr-card">
        <div className="lr-row">
          <label className="k-field lr-grow"><span className="k-label">主播</span>
            <span className="lr-inline">
              {adding ? (
                <>
                  <input className="k-input" autoFocus placeholder="输入主播名，回车添加" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addAnchor(); if (e.key === 'Escape') setAdding(false); }} />
                  <button className="k-btn" onClick={() => void addAnchor()}>添加</button>
                  <button className="k-icon-btn" aria-label="取消" onClick={() => setAdding(false)}><X size={14} /></button>
                </>
              ) : (
                <>
                  <select className="k-input" value={st.anchorId} onChange={(e) => set({ anchorId: e.target.value })}>
                    <option value="">{env.anchors.length ? '选择主播' : '还没有主播，先新增'}</option>
                    {env.anchors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button className="k-btn" onClick={() => setAdding(true)}><UserPlus size={14} />新增</button>
                  <button className="k-icon-btn" aria-label="删除当前主播" title="删除当前主播（不影响飞书里的记录）" disabled={!anchor} onClick={() => void delAnchor()}><Trash2 size={14} /></button>
                </>
              )}
            </span>
          </label>
          <label className="k-field"><span className="k-label">复盘日期</span><input className="k-input" type="date" value={st.date} onChange={(e) => set({ date: e.target.value })} /></label>
          <label className="k-field"><span className="k-label">加群数（选填）</span><input className="k-input" type="number" min={0} placeholder="本场加群人数" value={st.groupCount} onChange={(e) => set({ groupCount: e.target.value })} /></label>
        </div>
        <label className="k-field"><span className="k-label">备注（选填）</span><input className="k-input" placeholder="例如：午场、临时换品、流量异常" value={st.note} onChange={(e) => set({ note: e.target.value })} /></label>
      </section>

      <div className={`lr-shots${hover ? ' hover' : ''}`}>
        {PLATFORMS.map((p) => {
          const img = st.images[p]; const r = st.rec[p];
          return (
            <section key={p} className="k-panel lr-shot" aria-label={`${PLATFORM_NAME[p]}截图`}>
              <header><b>{PLATFORM_NAME[p]}</b>
                {r ? <span className={`k-st ${st.errors[p] ? 'err' : 'ok'}`}>{st.errors[p] ? '需手动补全' : `已识别 ${Object.values(r).filter((v) => v.trim()).length}/${METRICS[p].length}`}</span> : img ? <span className="k-st wait">待识别</span> : null}
              </header>
              <button className="lr-drop" onClick={() => void pick(p)} aria-label={`选择${PLATFORM_NAME[p]}截图`}>
                {img ? <img src={img.url} alt={`${PLATFORM_NAME[p]}截图`} /> : <span><ImagePlus size={22} /><i>选择或拖入截图</i></span>}
              </button>
              <div className="lr-shot-foot k-muted"><span className="k-ellipsis">{img?.name ?? (p === 'kuaishou' ? '快手：截历史列表，只取第一行' : '未选择')}</span>
                {!r && <button className="k-btn ghost" onClick={() => setSt((s) => ({ ...s, rec: { ...s.rec, [p]: emptyMetrics(p) } }))}><PencilLine size={13} />手动填写</button>}
                {img && <button className="k-icon-btn" aria-label="移除截图" onClick={() => setSt((s) => { const images = { ...s.images }; delete images[p]; const rec = { ...s.rec }; delete rec[p]; return { ...s, images, rec }; })}><X size={14} /></button>}
              </div>
              {st.errors[p] && <p className="k-err-text lr-pad">{st.errors[p]}</p>}
              {r && <MetricGrid p={p} m={r} onChange={(m) => setSt((s) => ({ ...s, rec: { ...s.rec, [p]: m } }))} issues={issues} />}
            </section>
          );
        })}
      </div>

      {hasRec && (
        <section className="k-panel lr-card lr-qa" aria-label="抽检结果">
          <div className="lr-qa-head">
            {issues.length === 0 ? <><CheckCircle2 size={16} className="lr-ok" /><b>抽检通过</b><span className="k-muted">没有发现缺项或数值矛盾，仍建议对照截图扫一眼</span></>
              : <><AlertTriangle size={16} className={blocking ? 'lr-err' : 'lr-warn'} /><b>抽检发现 {issues.length} 条提示</b><span className="k-muted">{blocking ? '含必须处理的问题：改正后消失，或勾选确认后写入' : '仅供核对，不影响写入'}</span></>}
          </div>
          {issues.length > 0 && <ul className="lr-issues">{issues.map((i, k) => <li key={k} className={i.level}><span className={`k-st ${i.level === 'error' ? 'err' : 'warn'}`}>{i.level === 'error' ? '需处理' : '核对'}</span>{i.message}</li>)}</ul>}
        </section>
      )}

      <div className="lr-actions">
        <button className="k-btn big" disabled={!!busy || !Object.keys(st.images).length} onClick={() => void run()}>{busy === 'ocr' ? <Loader2 size={16} className="k-spin" /> : <ScanSearch size={16} />}{busy === 'ocr' ? '识别中…' : '识别截图'}</button>
        <button className="k-btn primary big" disabled={!canSend} onClick={() => void send()} title={why}>{busy === 'send' ? <Loader2 size={16} className="k-spin" /> : <Send size={16} />}写入飞书</button>
        {blocking && <label className="k-toggle"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对，仍然写入</label>}
        {why && !busy && <span className="k-muted">{why}</span>}
      </div>
      {msg && <div className={`k-notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}><span>{msg.text}</span>{msg.link && <button className="k-btn" onClick={() => void openLink(msg.link!)}>打开飞书表格</button>}</div>}
    </div>
  );
}

function MetricGrid({ p, m, onChange, issues }: { p: Platform; m: Metrics; onChange: (m: Metrics) => void; issues: ReturnType<typeof qaCheck> }) {
  return (
    <div className="lr-grid">
      {METRICS[p].map((d) => {
        const bad = issues.find((i) => i.platform === p && i.field === d.name);
        return (
          <label key={d.name} className={`lr-m${bad ? ` ${bad.level}` : ''}${d.core ? ' core' : ''}${d.kind === 'time' ? ' wide' : ''}`} title={bad?.message}>
            <span>{d.name}</span>
            <input className="k-input" value={m[d.name] ?? ''} aria-invalid={bad?.level === 'error'} onChange={(e) => onChange({ ...m, [d.name]: e.target.value })} />
          </label>
        );
      })}
    </div>
  );
}

