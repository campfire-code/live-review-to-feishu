// 纯函数：指标定义、大模型回复解析、数值抽检、写入飞书的字段组装。不依赖界面和网络。

export type Platform = 'douyin' | 'videohao' | 'kuaishou';
export const PLATFORMS: Platform[] = ['douyin', 'videohao', 'kuaishou'];
export const PLATFORM_NAME: Record<Platform, string> = { douyin: '抖音', videohao: '视频号', kuaishou: '快手' };

/** count 个数、money 金额、percent 百分比、time 时刻、duration 时长、minutes 以分钟计的时长 */
export type Kind = 'count' | 'money' | 'percent' | 'time' | 'duration' | 'minutes';
export interface MetricDef { name: string; kind: Kind; core?: boolean }

export const METRICS: Record<Platform, MetricDef[]> = {
  douyin: [
    { name: '开播时间', kind: 'time' }, { name: '关播时间', kind: 'time' }, { name: '直播时长', kind: 'duration', core: true },
    { name: '收获音浪', kind: 'count', core: true }, { name: '送礼人数', kind: 'count' }, { name: '送礼率', kind: 'percent' },
    { name: '会员收入', kind: 'money' }, { name: '星守护收入', kind: 'money' }, { name: '预计本场收入', kind: 'money' },
    { name: '曝光人数', kind: 'count', core: true }, { name: '进房人数', kind: 'count', core: true }, { name: '进房率', kind: 'percent' },
    { name: '平均在线人数', kind: 'count' }, { name: '最高在线人数', kind: 'count' }, { name: '人均停留时长', kind: 'duration' },
    { name: '评论人数', kind: 'count' }, { name: '点赞次数', kind: 'count' }, { name: '新增粉丝', kind: 'count' },
    { name: '分享次数', kind: 'count' }, { name: '加粉丝团人数', kind: 'count' },
  ],
  videohao: [
    { name: '开播时间', kind: 'time' }, { name: '开播时长', kind: 'duration', core: true },
    { name: '观看人数', kind: 'count', core: true }, { name: '观看次数', kind: 'count', core: true }, { name: '最高在线', kind: 'count' },
    { name: '平均观看时长', kind: 'duration' }, { name: '点赞次数', kind: 'count' }, { name: '评论次数', kind: 'count' },
    { name: '分享次数', kind: 'count' }, { name: '新增关注人数', kind: 'count' },
  ],
  kuaishou: [
    { name: '开播时间', kind: 'time' }, { name: '直播时长(分钟)', kind: 'minutes', core: true }, { name: '直播观众数', kind: 'count', core: true },
    { name: '在线人数峰值', kind: 'count' }, { name: '点赞数', kind: 'count' }, { name: '评论人数', kind: 'count' },
    { name: '分享人数', kind: 'count' }, { name: '送礼人数', kind: 'count' },
  ],
};

export type Metrics = Record<string, string>;
export type PlatformMetrics = Partial<Record<Platform, Metrics>>;

export const emptyMetrics = (p: Platform): Metrics => Object.fromEntries(METRICS[p].map((m) => [m.name, '']));

// ---------- 数值解析 ----------

const FULL = /[０-９．，％：－]/g;
const toHalf = (s: string) => s.replace(FULL, (c) => ({ '．': '.', '，': ',', '％': '%', '：': ':', '－': '-' } as Record<string, string>)[c] ?? String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** "1,914" → 1914，"14.5%" → 14.5，"1.2万" → 12000，"¥3,200.50" → 3200.5，"0元" → 0；读不成数字返回 null */
export function parseNumber(raw: string): number | null {
  const s = toHalf(raw).replace(/[\s,¥￥]/g, '');
  const m = /^([-+]?\d+(?:\.\d+)?)(万|亿|w|W)?(元|人|次|个|%|音浪)?$/.exec(s);
  if (!m) return null;
  const mult = m[2] === '亿' ? 1e8 : m[2] ? 1e4 : 1;
  return Math.round(Number(m[1]) * mult * 1e6) / 1e6;
}

/** "1小时2分钟58秒"、"00小时24分15秒"、"36分钟"、"01:02:58" → 秒；读不出返回 null */
export function parseDuration(raw: string): number | null {
  const s = toHalf(raw).replace(/\s/g, '');
  if (!s) return null;
  const colon = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (colon) return colon[3] != null ? +colon[1] * 3600 + +colon[2] * 60 + +colon[3] : +colon[1] * 60 + +colon[2];
  const m = /^(?:(\d+(?:\.\d+)?)(?:小时|时|h))?(?:(\d+(?:\.\d+)?)(?:分钟|分|min|m))?(?:(\d+(?:\.\d+)?)(?:秒|s))?$/i.exec(s);
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

/** "2026-10-26 20:01:23" → 毫秒（按墙上时间算，只用于求时间差）；读不出返回 null */
export function parseClock(raw: string): number | null {
  const m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?[\sT]*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(toHalf(raw));
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

// ---------- 大模型识别：提示词与回复解析 ----------

const HINT: Record<Platform, string> = {
  douyin: '这是抖音直播复盘后台截图。营收、流量、互动三组指标卡里，指标名和数值通常分行排列。指标显示为 0、0元、0% 时如实填写。',
  videohao: '这是视频号直播复盘后台截图。基础数据和互动数据里，指标名和数值通常分行排列；开播时长格式如“00小时24分15秒”。',
  kuaishou: '这是快手直播历史列表的截图，可能包含多行。只提取第一行（最近一场直播）的数据。',
};

export function buildVisionPrompt(p: Platform): string {
  const schema = METRICS[p].map((m) => `  "${m.name}": "..."`).join(',\n');
  return [
    `你是数据提取助手。${HINT[p]}`,
    '请从图中提取下列字段，严格按 JSON 输出，不要解释，不要 markdown 代码块标记：',
    '{', schema, '}',
    '所有值都用字符串。图中找不到的字段填空字符串 ""，不要猜测，不要根据其他数值推算。',
    '时间保留原格式（如 "2026-10-26 20:01:23"）；数值带单位的保留单位（如 "1,914"、"14.5%"、"1小时2分钟58秒"）。',
  ].join('\n');
}

const normKey = (k: string) => k.replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');

export interface ParsedReply { ok: boolean; metrics: Metrics; unknown: string[]; error?: string }

/** 解析大模型回复：容忍代码块、前后多余文字、结尾多余逗号、数值型取值；字段名按全角括号、空格归一 */
export function parseModelReply(text: string, p: Platform): ParsedReply {
  const metrics = emptyMetrics(p);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, metrics, unknown: [], error: '回复里没有 JSON' };
  const body = text.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1');
  let obj: unknown;
  try { obj = JSON.parse(body); } catch { return { ok: false, metrics, unknown: [], error: '回复不是合法的 JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, metrics, unknown: [], error: '回复不是 JSON 对象' };
  const byNorm = new Map(Object.keys(metrics).map((k) => [normKey(k), k]));
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const target = byNorm.get(normKey(k));
    if (!target) { unknown.push(k); continue; }
    if (v == null || typeof v === 'object') continue;
    metrics[target] = String(v).trim();
  }
  return { ok: true, metrics, unknown };
}

// ---------- 抽检 ----------

export type Level = 'error' | 'warn';
export interface Issue { platform: Platform; field?: string; level: Level; message: string }

const fmtDur = (sec: number) => `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${sec % 60}秒`;

/**
 * 对识别结果做合理性检查，返回待用户核对的提示。
 * error：读不出数值、百分比超范围、核心指标缺失、几乎没识别出东西；warn：互相矛盾或可疑，由用户判断。
 * 只检查必然成立的关系（如进房人数不可能超过曝光人数），不拿“经验范围”武断判断。
 */
export function qaCheck(all: PlatformMetrics): Issue[] {
  const out: Issue[] = [];
  for (const p of PLATFORMS) {
    const m = all[p];
    if (!m) continue;
    const name = PLATFORM_NAME[p];
    const defs = METRICS[p];
    const filled = defs.filter((d) => (m[d.name] ?? '').trim() !== '');
    if (filled.length < Math.ceil(defs.length * 0.3)) {
      out.push({ platform: p, level: 'error', message: `${name}只识别出 ${filled.length}/${defs.length} 项，可能不是复盘截图或图片不清晰，建议换图重识别` });
    }
    const missing = defs.filter((d) => !(m[d.name] ?? '').trim());
    for (const d of missing.filter((x) => x.core)) out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」没有识别到（核心指标）` });
    const rest = missing.filter((x) => !x.core).map((x) => x.name);
    if (rest.length && filled.length >= Math.ceil(defs.length * 0.3)) out.push({ platform: p, level: 'warn', message: `${name}有 ${rest.length} 项为空：${rest.join('、')}` });

    // 数值化
    const num: Record<string, number> = {};
    const sec: Record<string, number> = {};
    const clock: Record<string, number> = {};
    for (const d of filled) {
      const v = m[d.name].trim();
      if (d.kind === 'time') { const t = parseClock(v); if (t == null) out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」读不成时间：“${v}”` }); else clock[d.name] = t; continue; }
      if (d.kind === 'duration' || d.kind === 'minutes') {
        let s = parseDuration(v);
        if (s == null && d.kind === 'minutes') { const n = parseNumber(v); if (n != null) s = Math.round(n * 60); }
        if (s == null) out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」读不成时长：“${v}”` });
        else { sec[d.name] = s; if (s > 86400) out.push({ platform: p, field: d.name, level: 'warn', message: `${name}「${d.name}」超过 24 小时（${fmtDur(s)}），请核对` }); }
        continue;
      }
      const n = parseNumber(v);
      if (n == null) { out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」读不成数字：“${v}”` }); continue; }
      if (n < 0) out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」是负数：“${v}”` });
      else if (d.kind === 'percent' && n > 100) out.push({ platform: p, field: d.name, level: 'error', message: `${name}「${d.name}」超过 100%：“${v}”` });
      else num[d.name] = n;
    }
    const le = (a: string, b: string, why: string) => {
      if (num[a] != null && num[b] != null && num[a] > num[b]) out.push({ platform: p, field: a, level: 'warn', message: `${name}「${a}」(${num[a]}) 大于「${b}」(${num[b]})：${why}` });
    };
    if (p === 'douyin') {
      le('进房人数', '曝光人数', '进房人数不应超过曝光人数');
      le('平均在线人数', '最高在线人数', '平均在线不应超过最高在线');
      for (const f of ['送礼人数', '评论人数', '新增粉丝', '加粉丝团人数']) le(f, '进房人数', '互动人数一般不应超过进房人数');
      if (num['进房率'] != null && num['进房人数'] != null && num['曝光人数'] > 0) {
        const calc = (num['进房人数'] / num['曝光人数']) * 100;
        if (Math.abs(calc - num['进房率']) > 2) out.push({ platform: p, field: '进房率', level: 'warn', message: `${name}「进房率」${num['进房率']}% 与进房人数/曝光人数算出的 ${calc.toFixed(1)}% 差距较大` });
      }
      if (sec['人均停留时长'] != null && sec['直播时长'] != null && sec['人均停留时长'] > sec['直播时长']) out.push({ platform: p, field: '人均停留时长', level: 'warn', message: `${name}「人均停留时长」比「直播时长」还长` });
      if (clock['开播时间'] != null && clock['关播时间'] != null) {
        const d = (clock['关播时间'] - clock['开播时间']) / 1000;
        if (d <= 0) out.push({ platform: p, field: '关播时间', level: 'warn', message: `${name}「关播时间」不晚于「开播时间」` });
        else if (sec['直播时长'] != null && Math.abs(d - sec['直播时长']) > 300) out.push({ platform: p, field: '直播时长', level: 'warn', message: `${name}开关播时间相差 ${fmtDur(d)}，与「直播时长」${fmtDur(sec['直播时长'])} 不一致` });
      }
    } else if (p === 'videohao') {
      le('观看人数', '观看次数', '观看人数不应超过观看次数');
      le('最高在线', '观看人数', '最高在线不应超过观看人数');
      if (sec['平均观看时长'] != null && sec['开播时长'] != null && sec['平均观看时长'] > sec['开播时长']) out.push({ platform: p, field: '平均观看时长', level: 'warn', message: `${name}「平均观看时长」比「开播时长」还长` });
    } else {
      le('在线人数峰值', '直播观众数', '在线峰值不应超过观众数');
      for (const f of ['评论人数', '分享人数', '送礼人数']) le(f, '直播观众数', '互动人数一般不应超过观众数');
    }
  }
  return out;
}

export const hasBlocking = (issues: Issue[]) => issues.some((i) => i.level === 'error');

// ---------- 写入飞书的字段 ----------

export interface WechatFan { name: string; count: number }

/** 加群数、加微总数、加微率、私域分配 */
export function fansFields(groupCount: number | null, fans: WechatFan[]): Record<string, string | number> {
  const valid = fans.filter((f) => f.name.trim() && Number.isFinite(f.count) && f.count >= 0);
  const total = valid.reduce((s, f) => s + f.count, 0);
  const f: Record<string, string | number> = {
    加微总数: total,
    私域分配: valid.map((x) => `${x.name.trim()}:${x.count}`).join(' / '),
    加微率: groupCount && groupCount > 0 ? `${((total * 100) / groupCount).toFixed(1)}%` : '',
  };
  if (groupCount != null && Number.isFinite(groupCount) && groupCount >= 0) f['加群数'] = groupCount;
  return f;
}

/** "号A:25 / 号B:18" → 列表 */
export function parseAllocation(s: string): WechatFan[] {
  return s.split('/').map((x) => x.trim()).filter(Boolean).flatMap((x) => {
    const i = x.lastIndexOf(':');
    const count = Number(x.slice(i + 1));
    return i > 0 && x.slice(i + 1).trim() !== '' && Number.isFinite(count) ? [{ name: x.slice(0, i).trim(), count }] : [];
  });
}

/** "YYYY-MM-DD" → 按北京时间零点的毫秒时间戳（飞书日期字段取值）；格式不对返回 null */
export function dateToMs(d: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600_000;
  return Number.isNaN(ms) ? null : ms;
}
export const msToDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

export interface RecordInput {
  anchor: string;
  date: string;
  note: string;
  groupCount: number | null;
  fans: WechatFan[];
  engine: string;
  metrics: PlatformMetrics;
}

export const PREFIX: Record<Platform, string> = { douyin: '抖音-', videohao: '视频号-', kuaishou: '快手-' };

export function buildRecordFields(r: RecordInput): Record<string, string | number> {
  const ms = dateToMs(r.date);
  if (!r.anchor.trim()) throw new Error('请选择主播');
  if (ms == null) throw new Error('请填写复盘日期');
  const f: Record<string, string | number> = { 主播: r.anchor.trim(), 日期: ms, 识别方式: r.engine, 备注: r.note.trim(), ...fansFields(r.groupCount, r.fans) };
  for (const p of PLATFORMS) for (const d of METRICS[p]) f[PREFIX[p] + d.name] = r.metrics[p]?.[d.name]?.trim() ?? '';
  return f;
}

/** 表格字段定义（主播为索引列，另行处理）。1 文本、2 数字、5 日期，取自飞书文档“新增字段”。 */
export function tableFieldSpecs(): { field_name: string; type: number }[] {
  return [
    { field_name: '日期', type: 5 }, { field_name: '识别方式', type: 1 }, { field_name: '备注', type: 1 },
    { field_name: '加群数', type: 2 }, { field_name: '加微总数', type: 2 }, { field_name: '加微率', type: 1 }, { field_name: '私域分配', type: 1 },
    ...PLATFORMS.flatMap((p) => METRICS[p].map((d) => ({ field_name: PREFIX[p] + d.name, type: 1 }))),
  ];
}

/** 从多维表格链接取 app_token 与 table_id：形如 https://xxx.feishu.cn/base/<app_token>?table=<tbl…>。知识库（/wiki/）链接不适用。 */
export function parseBitableUrl(u: string): { appToken: string; tableId: string } | null {
  const m = /\/base\/([A-Za-z0-9]+)/.exec(u);
  if (!m) return null;
  const t = /[?&]table=([A-Za-z0-9]+)/.exec(u);
  return { appToken: m[1], tableId: t ? t[1] : '' };
}

/** 飞书单元格取值转成可显示文本：文本字段可能是字符串或 [{text}] 数组 */
export function flatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? ((x as { text?: string; name?: string }).text ?? (x as { name?: string }).name ?? '') : String(x))).join('');
  if (typeof v === 'object') return String((v as { text?: string; name?: string }).text ?? (v as { name?: string }).name ?? '');
  return String(v);
}

/** 按文件名猜是哪个平台的截图；猜不出返回 null */
export function guessPlatform(name: string): Platform | null {
  const n = name.toLowerCase();
  if (/抖音|douyin|dy/.test(n)) return 'douyin';
  if (/视频号|shipinhao|videohao|wechat|wx/.test(n)) return 'videohao';
  if (/快手|kuaishou|ks/.test(n)) return 'kuaishou';
  return null;
}
