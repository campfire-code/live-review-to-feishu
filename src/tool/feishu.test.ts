import { describe, expect, it } from 'vitest';
import { FeishuClient, type FeishuConfig } from './feishu';
import { createFakeFeishu } from './fake-feishu';
import { submitRecord, diffEdit } from './flow';
import { SAMPLE_METRICS } from './fixtures';
import { tableFieldSpecs, type RecordInput } from './core';

const cfg = (o: Partial<FeishuConfig> = {}): FeishuConfig => ({ appId: 'cli_demo', appSecret: 'secret_demo', baseName: '主播复盘数据台', tableName: '主播复盘记录', appToken: '', tableId: '', tableUrl: '', ...o });
const sleep = async () => undefined;
const input = (o: Partial<RecordInput> = {}): RecordInput => ({ anchor: '示例主播·小满', date: '2026-10-26', note: '', groupCount: 80, fans: [], engine: '大模型', metrics: SAMPLE_METRICS, ...o });

describe('飞书客户端（假接口）', () => {
  it('token 缓存：多次请求只取一次；Secret 错误给出明确错误', async () => {
    const fake = createFakeFeishu({ appId: 'cli_demo', appSecret: 'secret_demo' });
    const c = new FeishuClient(cfg(), fake.http, sleep);
    await c.getToken(); await c.getToken();
    expect(fake.state.tokenCalls).toBe(1);
    const bad = new FeishuClient(cfg({ appSecret: 'wrong' }), fake.http, sleep);
    await expect(bad.getToken()).rejects.toThrow(/invalid param/);
    await expect(new FeishuClient(cfg({ appId: '' }), fake.http, sleep).getToken()).rejects.toThrow('App ID');
  });

  it('token 过期后重新获取', async () => {
    const fake = createFakeFeishu();
    let t = 0;
    const c = new FeishuClient(cfg(), fake.http, sleep, () => t);
    await c.getToken();
    t = 7200 * 1000;
    await c.getToken();
    expect(fake.state.tokenCalls).toBe(2);
  });

  it('首次：建多维表格 → 索引列改名为主播 → 清掉默认示例列 → 建全部字段', async () => {
    const fake = createFakeFeishu();
    const c = new FeishuClient(cfg(), fake.http, sleep);
    const r = await c.ensureTable();
    expect(r.created).toBe(true);
    expect(r.cfg.appToken).toMatch(/^bascn/);
    expect(r.cfg.tableUrl).toContain('/base/');
    const fields = await c.listFields();
    const names = fields.map((f) => f.field_name).sort();
    expect(names).toEqual(['主播', ...tableFieldSpecs().map((s) => s.field_name)].sort());
    expect(fields.find((f) => f.is_primary)!.field_name).toBe('主播');
    expect(fields.find((f) => f.field_name === '日期')!.type).toBe(5);
    expect(fields.find((f) => f.field_name === '加群数')!.type).toBe(2);
    // 再次检查不会重复创建
    expect((await c.ensureTable()).fieldsCreated).toBe(0);
  });

  it('已有的表：不删除用户自己的列，只补缺的字段', async () => {
    const fake = createFakeFeishu();
    fake.seedTable('bascnMine', 'tblMine', [{ name: '主播', type: 1, primary: true }, { name: '我的备注列', type: 1 }, { name: '附件', type: 17 }]);
    const c = new FeishuClient(cfg({ appToken: 'bascnMine', tableId: 'tblMine' }), fake.http, sleep);
    const r = await c.ensureTable();
    expect(r.created).toBe(false);
    const names = (await c.listFields()).map((f) => f.field_name);
    expect(names).toContain('我的备注列');
    expect(names).toContain('附件');
    expect(names).toContain('抖音-曝光人数');
  });

  it('已有表里“主播”不是索引列时拒绝，避免改乱用户的表', async () => {
    const fake = createFakeFeishu();
    fake.seedTable('bascnMine', 'tblMine', [{ name: '名字', type: 1, primary: true }, { name: '主播', type: 1 }]);
    const c = new FeishuClient(cfg({ appToken: 'bascnMine', tableId: 'tblMine' }), fake.http, sleep);
    await expect(c.ensureTable()).rejects.toThrow('主播');
  });

  it('没有编辑权限时给出协作者提示；字段创建失败汇总报错', async () => {
    const ro = createFakeFeishu({ readOnly: true });
    ro.seedTable('b1', 't1', [{ name: '主播', type: 1, primary: true }]);
    await expect(new FeishuClient(cfg({ appToken: 'b1', tableId: 't1' }), ro.http, sleep).ensureTable()).rejects.toThrow('协作者');
    const bad = createFakeFeishu({ failFields: ['加群数'] });
    await expect(new FeishuClient(cfg(), bad.http, sleep).ensureTable()).rejects.toThrow(/1 个字段创建失败：加群数/);
  });

  it('记录增删改查，列表按 page_token 翻页', async () => {
    const fake = createFakeFeishu();
    const c = new FeishuClient(cfg(), fake.http, sleep);
    await c.ensureTable();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await c.createRecord({ 主播: `示例${i}`, 加群数: i }));
    expect((await c.listRecords()).map((r) => r.fields['主播'])).toEqual(['示例0', '示例1', '示例2']);
    await c.updateRecord(ids[1], { 加群数: 99 });
    expect((await c.listRecords())[1].fields['加群数']).toBe(99);
    await c.deleteRecord(ids[0]);
    expect((await c.listRecords()).length).toBe(2);
    await expect(c.deleteRecord('recNope')).rejects.toThrow('已被删除');
    await expect(c.createRecord({ 不存在的列: 'x' })).rejects.toThrow('缺少需要的字段');
    // 翻页：服务端每页 500，这里造 1100 条直接塞进假表
    const t = fake.tableOf(c.cfg.appToken, c.cfg.tableId)!;
    for (let i = 0; i < 1100; i++) t.records.push({ record_id: `recX${i}`, fields: { 主播: 'x' } });
    expect((await c.listRecords()).length).toBe(2 + 1100);
    expect(fake.calls.filter((x) => x.startsWith('GET') && x.endsWith('/records')).length).toBeGreaterThanOrEqual(3);
  });

  it('限流错误会等待后重试', async () => {
    const fake = createFakeFeishu();
    let n = 0;
    const waits: number[] = [];
    const flaky = async (...a: Parameters<typeof fake.http>) => {
      if (a[0].includes('/records?') && a[1].method === 'GET' && n++ < 1) return { status: 200, text: async () => JSON.stringify({ code: 1254290, msg: 'Too many request' }) };
      return fake.http(...a);
    };
    const c = new FeishuClient(cfg(), flaky, async (ms) => { waits.push(ms); });
    await c.ensureTable();
    await c.listRecords();
    expect(waits.length).toBe(1);
  });
});

describe('写入流程', () => {
  it('首次写入自动建表，三平台指标在同一行；第二次写入跳过检查', async () => {
    const fake = createFakeFeishu();
    const c = new FeishuClient(cfg(), fake.http, sleep);
    const logs: string[] = [];
    const r1 = await submitRecord(c, input(), false, (s) => logs.push(s));
    expect(r1.createdTable).toBe(true);
    expect(logs.join()).toContain('新建多维表格');
    const rows = await c.listRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0].fields['抖音-收获音浪']).toBe('18,640');
    expect(rows[0].fields['视频号-观看人数']).toBe('3,150');
    expect(rows[0].fields['快手-直播观众数']).toBe('1,806');
    const before = fake.calls.length;
    const r2 = await submitRecord(new FeishuClient(r1.cfg, fake.http, sleep), input({ anchor: '示例主播·阿北' }), true);
    expect(r2.ensured).toBe(false);
    expect(fake.calls.slice(before).filter((x) => x.includes('/fields')).length).toBe(0);
    expect((await c.listRecords()).length).toBe(2);
  });

  it('表被人删了列：写入报字段不存在时自动补全后重试', async () => {
    const fake = createFakeFeishu();
    const c = new FeishuClient(cfg(), fake.http, sleep);
    const r1 = await submitRecord(c, input(), false);
    const t = fake.tableOf(r1.cfg.appToken, r1.cfg.tableId)!;
    t.fields = t.fields.filter((f) => f.field_name !== '备注');
    const r2 = await submitRecord(new FeishuClient(r1.cfg, fake.http, sleep), input({ note: '补发' }), true);
    expect(r2.ensured).toBe(true);
    expect((await c.listRecords()).at(-1)!.fields['备注']).toBe('补发');
  });

  it('编辑：只提交改动的字段，加微数据重新计算', async () => {
    const fake = createFakeFeishu();
    const c = new FeishuClient(cfg(), fake.http, sleep);
    const r = await submitRecord(c, input(), false);
    const fields = await c.listFields();
    const rec = (await c.listRecords())[0];
    const values = (): Record<string, string> => ({ 主播: '示例主播·小满', 日期: '2026-10-26', '抖音-收获音浪': '18,640', '抖音-曝光人数': '50,000', 加群数: '80' });
    const diff = diffEdit(rec.fields, fields, { values: values(), groupCount: '80', fans: [{ name: '号A', count: 25 }, { name: '号B', count: 18 }] });
    expect(diff).toEqual({ '抖音-曝光人数': '50,000', 加微总数: 43, 加微率: '53.8%', 私域分配: '号A:25 / 号B:18' });
    await c.updateRecord(rec.record_id, diff);
    const after = (await c.listRecords())[0];
    expect(after.fields['抖音-收获音浪']).toBe('18,640');
    expect(after.fields['加微总数']).toBe(43);
    // 没改任何东西 → 空
    expect(diffEdit(after.fields, fields, { values: values(), groupCount: '80', fans: [{ name: '号A', count: 25 }, { name: '号B', count: 18 }] })['加微率']).toBeUndefined();
    expect(r.recordId).toBeTruthy();
  });
});
