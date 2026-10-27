// 飞书设置页：应用凭证、表格连接、微信号清单。
import { useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Plug, Table2, Trash2, Unlink } from 'lucide-react';
import { openLink } from '../kit/platform';
import { parseBitableUrl } from './core';
import { FeishuClient, type FeishuConfig } from './feishu';
import { newId, saveSchemaOk, saveWechats, type Wechat } from './store';
import type { Env } from './env';

type Msg = { kind: 'ok' | 'err'; text: string } | null;

export function FeishuSettings({ env, setWechats, onCfg }: { env: Env; setWechats: (w: Wechat[]) => void; onCfg: (c: FeishuConfig) => void }) {
  const [draft, setDraft] = useState(env.cfg);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [wn, setWn] = useState('');
  const [wnote, setWnote] = useState('');
  const set = (p: Partial<FeishuConfig>) => setDraft((d) => ({ ...d, ...p }));

  const withCfg = async <T,>(label: string, fn: (c: FeishuClient, cfg: FeishuConfig) => Promise<T>, done: (r: T) => string) => {
    setBusy(label); setMsg(null);
    try {
      let cfg = { ...draft };
      if (url.trim()) {
        const p = parseBitableUrl(url.trim());
        if (!p) throw new Error('链接里找不到 /base/ 开头的多维表格地址（知识库 /wiki/ 链接暂不支持，请打开多维表格本体后复制地址栏）');
        if (!p.tableId) throw new Error('链接里没有 table= 参数：请先在多维表格里点到要用的数据表，再复制地址栏');
        cfg = { ...cfg, appToken: p.appToken, tableId: p.tableId, tableUrl: url.trim() };
        await saveSchemaOk('');
      }
      await env.saveCfg(cfg); onCfg(cfg); setDraft(cfg); setUrl('');
      const c = new FeishuClient(cfg, env.http);
      const r = await fn(c, cfg);
      const text = done(r);
      env.log(text, 'ok'); setMsg({ kind: 'ok', text });
      return r;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      env.log(`${label}失败：${text}`, 'err'); setMsg({ kind: 'err', text: `${label}失败：${text}` });
    } finally { setBusy(''); }
  };

  const save = () => withCfg('保存', async () => undefined, () => '已保存');
  const test = () => withCfg('测试连接', (c) => c.getToken(), () => '连接成功：App ID 和 Secret 有效');
  const ensure = async () => {
    const r = await withCfg('检查表格', (c) => c.ensureTable(), (x) => (x.created ? `已新建多维表格，创建 ${x.fieldsCreated} 个字段` : x.fieldsCreated ? `已补全 ${x.fieldsCreated} 个字段` : '表格字段齐全'));
    if (r) { await env.saveCfg(r.cfg); await saveSchemaOk(r.cfg.appToken + '/' + r.cfg.tableId); onCfg(r.cfg); setDraft(r.cfg); }
  };
  const unlink = async () => {
    const c = { ...draft, appToken: '', tableId: '', tableUrl: '' };
    await env.saveCfg(c); await saveSchemaOk(''); onCfg(c); setDraft(c);
    setMsg({ kind: 'ok', text: '已断开表格，下次写入会新建（飞书里的原表格不会被删除）' });
  };
  const addWechat = async () => {
    const name = wn.trim();
    if (!name || env.wechats.some((w) => w.name === name)) return;
    const l = [...env.wechats, { id: newId(), name, note: wnote.trim() }];
    await saveWechats(l); setWechats(l); setWn(''); setWnote('');
  };
  const connected = Boolean(draft.appToken && draft.tableId);

  return (
    <div className="lr-settings">
      <section className="k-panel lr-card">
        <h3>飞书自建应用</h3>
        <p className="k-help">到 <button className="k-link" onClick={() => void openLink('https://open.feishu.cn/app')}>飞书开放平台<ExternalLink size={11} /></button> 创建「企业自建应用」，在权限管理里开通多维表格权限（文档写明 <code>bitable:app</code> 即可管理多维表格；仅建表可用 <code>base:app:create</code>），发布应用。App Secret 只保存在本机。</p>
        <div className="lr-form">
          <label className="k-field"><span className="k-label">App ID</span><input className="k-input" value={draft.appId} onChange={(e) => set({ appId: e.target.value })} placeholder="cli_ 开头" autoComplete="off" /></label>
          <label className="k-field"><span className="k-label">App Secret</span><input className="k-input" type="password" value={draft.appSecret} onChange={(e) => set({ appSecret: e.target.value })} autoComplete="off" /></label>
        </div>
        <div className="lr-inline"><button className="k-btn" disabled={!!busy || !draft.appId || !draft.appSecret} onClick={() => void test()}>{busy === '测试连接' ? <Loader2 size={14} className="k-spin" /> : <Plug size={14} />}测试连接</button><button className="k-btn" disabled={!!busy} onClick={() => void save()}>保存</button></div>
      </section>

      <section className="k-panel lr-card">
        <h3>多维表格</h3>
        {connected ? (
          <div className="lr-linked">
            <span className="k-st ok"><CheckCircle2 size={12} />已连接</span>
            <span className="k-muted k-num">app_token {draft.appToken.slice(0, 6)}…　table_id {draft.tableId}</span>
            {draft.tableUrl && <button className="k-btn" onClick={() => void openLink(draft.tableUrl)}><ExternalLink size={14} />打开</button>}
            <button className="k-btn ghost" onClick={() => void unlink()}><Unlink size={14} />断开</button>
          </div>
        ) : <p className="k-muted">还没有连接表格：直接去「录入」写入一条，会自动新建；或粘贴已有多维表格的链接。</p>}
        <label className="k-field"><span className="k-label">使用已有的多维表格（选填，粘贴地址栏链接）</span><input className="k-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxx.feishu.cn/base/…?table=tbl…" /></label>
        <label className="k-field"><span className="k-label">自动新建时的名称</span><input className="k-input" value={draft.baseName} onChange={(e) => set({ baseName: e.target.value })} /></label>
        <p className="k-help">未核实：应用身份新建的多维表格，你本人的飞书账号默认可能打不开。更稳妥的做法是在飞书里自己新建一个多维表格，把这个应用添加为协作者（可编辑），再把链接粘贴到上面。</p>
        <div className="lr-inline"><button className="k-btn primary" disabled={!!busy || !draft.appId || !draft.appSecret} onClick={() => void ensure()}>{busy === '检查表格' ? <Loader2 size={14} className="k-spin" /> : <Table2 size={14} />}{connected || url.trim() ? '检查并补全字段' : '现在新建表格'}</button></div>
      </section>

      <section className="k-panel lr-card">
        <h3>我的微信号</h3>
        <p className="k-help">维护私域微信号清单，补录加微数据时可以直接选。</p>
        <div className="lr-inline"><input className="k-input" placeholder="微信号名称（如：运营号1）" value={wn} onChange={(e) => setWn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addWechat(); }} /><input className="k-input" placeholder="备注（选填）" value={wnote} onChange={(e) => setWnote(e.target.value)} /><button className="k-btn" onClick={() => void addWechat()}>添加</button></div>
        <ul className="lr-wlist">{env.wechats.map((w) => <li key={w.id}><b>{w.name}</b><span className="k-muted">{w.note}</span><button className="k-icon-btn" aria-label={`删除${w.name}`} onClick={async () => { const l = env.wechats.filter((x) => x.id !== w.id); await saveWechats(l); setWechats(l); }}><Trash2 size={14} /></button></li>)}{!env.wechats.length && <li className="k-muted">还没有微信号</li>}</ul>
      </section>
      {msg && <div className={`k-notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}><span>{msg.text}</span></div>}
    </div>
  );
}
