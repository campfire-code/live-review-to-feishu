// 主播复盘入表台：录入 / 记录 / 飞书设置三页，下方是运行日志。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, FilePlus2, ScrollText, Settings2 } from 'lucide-react';
import { FeishuClient, type FeishuConfig } from './feishu';
import { Entry, initialEntry, type EntryState } from './Entry';
import { Records } from './Records';
import { FeishuSettings } from './FeishuSettings';
import { realHttp, type Env } from './env';
import { realVision } from './vision';
import { EMPTY_CONFIG, loadAnchors, loadConfig, loadLog, loadSchemaOk, loadWechats, saveConfig, saveLog, type Anchor, type LogLine, type Wechat } from './store';
import './tool.css';

type Tab = 'entry' | 'records' | 'feishu';
const TABS: [Tab, string, typeof FilePlus2][] = [['entry', '录入', FilePlus2], ['records', '记录', ClipboardList], ['feishu', '飞书设置', Settings2]];
const hhmm = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

export function Main({ preview, readFile }: { preview?: boolean; readFile: (p: string) => Promise<Uint8Array> }) {
  const initTab = (preview ? new URLSearchParams(location.search).get('tab') : null) as Tab | null;
  const [tab, setTab] = useState<Tab>(initTab ?? 'entry');
  const [cfg, setCfg] = useState<FeishuConfig>(EMPTY_CONFIG);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [wechats, setWechats] = useState<Wechat[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [schemaKey, setSchemaKey] = useState('');
  const [entry, setEntry] = useState<EntryState>(initialEntry);
  const [reload, setReload] = useState(0);
  const [ready, setReady] = useState(false);
  const mock = useRef<{ http: Env['http']; vision: Env['vision'] } | null>(null);

  useEffect(() => {
    (async () => {
      if (preview) {
        const s = await import('./sample');
        const { fake, cfg: c } = await s.sampleFeishu();
        mock.current = { http: fake.http, vision: async (_i, p) => s.fakeReply(p) };
        setCfg(c); setAnchors(s.SAMPLE_ANCHORS); setWechats(s.SAMPLE_WECHATS); setSchemaKey(c.appToken + '/' + c.tableId);
        setEntry(s.sampleEntry());
        setLogs([
          { at: '20:41:03', text: '开始识别 抖音、视频号、快手', level: 'info' }, { at: '20:41:09', text: '抖音识别完成', level: 'ok' },
          { at: '20:41:11', text: '视频号识别完成', level: 'ok' }, { at: '20:41:12', text: '快手识别完成', level: 'ok' },
        ]);
      } else {
        const [c, a, w, l, k] = await Promise.all([loadConfig(), loadAnchors(), loadWechats(), loadLog(), loadSchemaOk()]);
        setCfg(c); setAnchors(a); setWechats(w); setLogs(l); setSchemaKey(k);
        setEntry((e) => ({ ...e, anchorId: a[0]?.id ?? '' }));
      }
      setReady(true);
    })();
  }, [preview]);

  const logsRef = useRef(logs);
  logsRef.current = logs;
  const log = useCallback((text: string, level: LogLine['level'] = 'info') => {
    const next = [...logsRef.current, { at: hhmm(), text, level }].slice(-200);
    logsRef.current = next; setLogs(next);
    if (!preview) void saveLog(next);
  }, [preview]);

  const http = mock.current?.http ?? realHttp;
  const env: Env = useMemo(() => ({
    preview: !!preview, http, vision: mock.current?.vision ?? realVision, cfg, anchors, wechats, log,
    schemaOk: cfg.appToken !== '' && schemaKey === cfg.appToken + '/' + cfg.tableId,
    saveCfg: async (c) => { setCfg(c); if (!preview) await saveConfig(c); },
    client: () => new FeishuClient(cfg, http),
  }), [preview, cfg, anchors, wechats, log, schemaKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  // 设置页保存了新的 schemaOk 后同步到内存
  useEffect(() => { if (!preview) void loadSchemaOk().then(setSchemaKey); }, [tab, preview]);

  if (!ready) return <div className="lr k-muted">正在读取设置…</div>;
  return (
    <div className="lr">
      <nav className="k-seg lr-tabs" role="tablist" aria-label="功能页">
        {TABS.map(([t, label, Icon]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}><Icon size={14} />{label}</button>)}
      </nav>
      {tab === 'entry' && <Entry env={env} st={entry} setSt={setEntry} setAnchors={setAnchors} readFile={readFile} afterWrite={() => setReload((n) => n + 1)} />}
      {tab === 'records' && <Records env={env} reloadKey={reload} />}
      {tab === 'feishu' && <FeishuSettings env={env} setWechats={setWechats} onCfg={setCfg} />}
      <section className="k-panel lr-log" aria-label="运行日志">
        <header><ScrollText size={14} /><b>运行日志</b><span className="k-muted">只保留最近 200 条，不记录密钥</span></header>
        <ol>{logs.slice(-6).map((l, i) => <li key={i} className={l.level}><time className="k-num">{l.at}</time>{l.text}</li>)}{!logs.length && <li className="k-muted">还没有操作</li>}</ol>
      </section>
    </div>
  );
}
