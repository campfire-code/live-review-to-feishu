import { describe, expect, it } from 'vitest';
import {
  METRICS, buildRecordFields, buildVisionPrompt, dateToMs, fansFields, flatCell, hasBlocking, msToDate, parseAllocation, parseBitableUrl,
  parseClock, parseDuration, parseModelReply, parseNumber, qaCheck, tableFieldSpecs, type PlatformMetrics,
} from './core';
import { SAMPLE_METRICS } from './fixtures';

const clone = (): PlatformMetrics => JSON.parse(JSON.stringify(SAMPLE_METRICS));

describe('数值解析', () => {
  it('数字、百分比、万、金额', () => {
    expect(parseNumber('1,914')).toBe(1914);
    expect(parseNumber('14.5%')).toBe(14.5);
    expect(parseNumber('1.2万')).toBe(12000);
    expect(parseNumber('¥3,200.50')).toBe(3200.5);
    expect(parseNumber('0元')).toBe(0);
    expect(parseNumber('１，２３４')).toBe(1234);
    expect(parseNumber('1O4')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('约100')).toBeNull();
  });
  it('时长', () => {
    expect(parseDuration('1小时2分钟58秒')).toBe(3778);
    expect(parseDuration('00小时24分15秒')).toBe(1455);
    expect(parseDuration('0.5分钟')).toBe(30);
    expect(parseDuration('36分钟')).toBe(2160);
    expect(parseDuration('01:02:58')).toBe(3778);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
  it('时间点', () => {
    expect(parseClock('2026-10-26 20:00:12')).toBe(Date.UTC(2026, 9, 26, 20, 0, 12));
    expect(parseClock('2026年10月26日 20:00')).toBe(Date.UTC(2026, 9, 26, 20, 0, 0));
    expect(parseClock('2026-13-26 20:00:12')).toBeNull();
    expect(parseClock('今天晚上')).toBeNull();
  });
  it('日期按北京时间零点', () => {
    expect(dateToMs('2026-10-26')).toBe(Date.UTC(2026, 9, 25, 16, 0, 0));
    expect(msToDate(dateToMs('2026-10-26')!)).toBe('2026-10-26');
    expect(dateToMs('2026/10/26')).toBeNull();
  });
});

describe('大模型回复解析', () => {
  it('提示词列出该平台全部字段，快手只取第一行', () => {
    const p = buildVisionPrompt('kuaishou');
    for (const m of METRICS.kuaishou) expect(p).toContain(`"${m.name}"`);
    expect(p).toContain('第一行');
  });
  it('容忍代码块、前后文字、结尾逗号、数值型取值', () => {
    const r = parseModelReply('好的，结果如下：\n```json\n{"观看人数": 3150, "观看次数": "4,320", "最高在线": null,}\n```\n以上。', 'videohao');
    expect(r.ok).toBe(true);
    expect(r.metrics['观看人数']).toBe('3150');
    expect(r.metrics['观看次数']).toBe('4,320');
    expect(r.metrics['最高在线']).toBe('');
    expect(r.metrics['开播时长']).toBe('');
    expect(Object.keys(r.metrics)).toHaveLength(METRICS.videohao.length);
  });
  it('字段名的全角括号和空格归一，多余字段记为未知', () => {
    const r = parseModelReply('{"直播时长（分钟）": "148", "直播 观众数": "1806", "乱写": "x"}', 'kuaishou');
    expect(r.metrics['直播时长(分钟)']).toBe('148');
    expect(r.metrics['直播观众数']).toBe('1806');
    expect(r.unknown).toEqual(['乱写']);
  });
  it('不是 JSON 时报错且字段全空', () => {
    expect(parseModelReply('抱歉我看不清', 'douyin').ok).toBe(false);
    expect(parseModelReply('{"a":', 'douyin').ok).toBe(false);
    expect(parseModelReply('[1,2]', 'douyin').ok).toBe(false);
  });
});

describe('抽检 qaCheck', () => {
  it('虚构的正常数据没有任何提示', () => {
    expect(qaCheck(SAMPLE_METRICS)).toEqual([]);
  });
  it('读不成数字、百分比超范围、负数是 error', () => {
    const m = clone();
    m.douyin!['曝光人数'] = '4821O';
    m.douyin!['进房率'] = '420%';
    m.videohao!['点赞次数'] = '-5';
    const issues = qaCheck(m);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.field).sort()).toEqual(['曝光人数', '点赞次数', '进房率'].sort());
    expect(hasBlocking(issues)).toBe(true);
  });
  it('缺核心指标是 error，缺非核心只是 warn', () => {
    const m = clone();
    m.douyin!['进房人数'] = '';
    m.douyin!['分享次数'] = '';
    const issues = qaCheck(m);
    expect(issues.find((i) => i.field === '进房人数')!.level).toBe('error');
    expect(issues.find((i) => i.level === 'warn' && i.message.includes('分享次数'))).toBeTruthy();
  });
  it('几乎没识别出东西时提示换图', () => {
    const m = clone();
    for (const k of Object.keys(m.kuaishou!)) m.kuaishou![k] = '';
    m.kuaishou!['点赞数'] = '12';
    const issues = qaCheck(m);
    expect(issues.some((i) => i.platform === 'kuaishou' && i.level === 'error' && i.message.includes('换图'))).toBe(true);
  });
  it('互相矛盾的数值是 warn', () => {
    const m = clone();
    m.douyin!['进房人数'] = '60,000';
    m.videohao!['最高在线'] = '9,999';
    m.kuaishou!['在线人数峰值'] = '5,000';
    m.douyin!['关播时间'] = '2026-10-26 19:00:00';
    const msgs = qaCheck(m).map((i) => i.message).join('\n');
    expect(msgs).toContain('进房人数');
    expect(msgs).toContain('最高在线');
    expect(msgs).toContain('在线人数峰值');
    expect(msgs).toContain('关播时间');
    expect(hasBlocking(qaCheck(m))).toBe(false);
  });
  it('进房率与进房人数/曝光人数不符时提示', () => {
    const m = clone();
    m.douyin!['进房率'] = '14.5%';
    expect(qaCheck(m).some((i) => i.field === '进房率' && i.message.includes('4.2%'))).toBe(true);
  });
  it('快手时长按分钟换算后参与比较，未上传的平台不检查', () => {
    const m: PlatformMetrics = { kuaishou: clone().kuaishou };
    expect(qaCheck(m)).toEqual([]);
    m.kuaishou!['直播时长(分钟)'] = '2000';
    expect(qaCheck(m).some((i) => i.message.includes('24 小时'))).toBe(true);
  });
});

describe('加粉计算与记录字段', () => {
  it('加微总数、加微率、私域分配', () => {
    const f = fansFields(80, [{ name: '号A', count: 25 }, { name: '号B', count: 18 }, { name: '', count: 9 }]);
    expect(f).toEqual({ 加群数: 80, 加微总数: 43, 加微率: '53.8%', 私域分配: '号A:25 / 号B:18' });
    expect(fansFields(null, [])['加微率']).toBe('');
    expect(fansFields(0, [{ name: '号A', count: 3 }])['加微率']).toBe('');
  });
  it('私域分配可读回', () => {
    expect(parseAllocation('号A:25 / 号B:18')).toEqual([{ name: '号A', count: 25 }, { name: '号B', count: 18 }]);
    expect(parseAllocation('')).toEqual([]);
    expect(parseAllocation('坏数据 / x:y')).toEqual([]);
  });
  it('组装整行：三平台指标写同一行，缺主播或日期报错', () => {
    const f = buildRecordFields({ anchor: ' 示例主播·小满 ', date: '2026-10-26', note: '午场', groupCount: 80, fans: [], engine: '大模型', metrics: SAMPLE_METRICS });
    expect(f['主播']).toBe('示例主播·小满');
    expect(f['日期']).toBe(dateToMs('2026-10-26'));
    expect(f['抖音-收获音浪']).toBe('18,640');
    expect(f['视频号-观看人数']).toBe('3,150');
    expect(f['快手-直播时长(分钟)']).toBe('148');
    const names = new Set(tableFieldSpecs().map((s) => s.field_name));
    for (const k of Object.keys(f)) if (k !== '主播') expect(names.has(k), k).toBe(true);
    expect(() => buildRecordFields({ anchor: '', date: '2026-10-26', note: '', groupCount: null, fans: [], engine: '', metrics: {} })).toThrow('主播');
    expect(() => buildRecordFields({ anchor: 'x', date: '', note: '', groupCount: null, fans: [], engine: '', metrics: {} })).toThrow('日期');
  });
  it('字段定义：类型只用文本 1、数字 2、日期 5，名称不重复', () => {
    const s = tableFieldSpecs();
    expect(new Set(s.map((x) => x.type))).toEqual(new Set([1, 2, 5]));
    expect(new Set(s.map((x) => x.field_name)).size).toBe(s.length);
    expect(s.length).toBe(7 + METRICS.douyin.length + METRICS.videohao.length + METRICS.kuaishou.length);
  });
  it('链接取 app_token / table_id，单元格取值', () => {
    expect(parseBitableUrl('https://abc.feishu.cn/base/bascnAbC123?table=tblXyz789&view=vewQ')).toEqual({ appToken: 'bascnAbC123', tableId: 'tblXyz789' });
    expect(parseBitableUrl('https://abc.feishu.cn/wiki/xxx')).toBeNull();
    expect(flatCell([{ text: '张', type: 'text' }, { text: '三' }])).toBe('张三');
    expect(flatCell(12)).toBe('12');
    expect(flatCell(null)).toBe('');
  });
});

describe('按文件名猜平台', () => {
  it('中英文文件名', async () => {
    const { guessPlatform } = await import('./core');
    expect(guessPlatform('抖音-复盘.png')).toBe('douyin');
    expect(guessPlatform('示例-视频号.jpg')).toBe('videohao');
    expect(guessPlatform('KuaiShou_1026.png')).toBe('kuaishou');
    expect(guessPlatform('截图 2026-10-26.png')).toBeNull();
  });
});
