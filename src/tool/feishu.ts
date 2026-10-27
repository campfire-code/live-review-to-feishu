// 飞书开放平台 OpenAPI 客户端（自建应用、tenant_access_token）。
// 接口地址与字段类型已对照飞书开放平台文档核实，见 README「核实记录」。
import { tableFieldSpecs } from './core';

export const FEISHU_HOST = 'https://open.feishu.cn';

export interface HttpResponse { status: number; text(): Promise<string> }
export type HttpFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseName: string;
  tableName: string;
  appToken: string;
  tableId: string;
  tableUrl: string;
}

export class FeishuError extends Error {
  constructor(message: string, public code: number | string, public help = '') { super(message); }
}

/** 常见错误码的中文提示；没收录的显示飞书返回的原文 */
export function explainError(code: number | string, msg: string): { message: string; help: string } {
  const help = (/https:\/\/open\.feishu\.cn\/[^\s"']+/.exec(msg) ?? [])[0] ?? '';
  const known: Record<string, string> = {
    '1254302': '没有该多维表格的编辑权限：请在飞书里把这个应用添加为多维表格的协作者（可编辑）',
    '1254304': '没有该多维表格的管理权限：请在飞书里把这个应用添加为协作者',
    '1254045': '表格里缺少需要的字段：请到「飞书设置」点「检查并补全字段」',
    '1254040': '找不到这个多维表格，检查 app_token 是否正确',
    '1254041': '找不到这个数据表，检查 table_id 是否正确',
    '1254043': '找不到这条记录，可能已被删除',
    '1254015': '写入的值与字段类型不匹配',
    '1254290': '请求太快了，稍后再试',
    '1254291': '同一张表不允许并发写入，稍后再试',
  };
  return { message: known[String(code)] ?? (msg || `飞书接口失败（${code}）`), help };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRY_CODES = new Set([1254290, 1254607]);
/** 新建多维表格时默认带的示例列（取自参考实现的观察，文档未列出）：只在刚建好的表里清理 */
const DEFAULT_JUNK = new Set(['单选', '附件', '多选', '文本', '日期']);

export interface FieldInfo { field_id: string; field_name: string; type: number; is_primary?: boolean }
export interface RecordInfo { record_id: string; fields: Record<string, unknown> }

export class FeishuClient {
  private token = '';
  private expireAt = 0;
  constructor(public cfg: FeishuConfig, private http: HttpFn, private sleep: (ms: number) => Promise<void> = defaultSleep, private now: () => number = Date.now) {}

  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<{ data: Record<string, unknown> }> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (auth) headers.Authorization = `Bearer ${await this.getToken()}`;
      const res = await this.http(FEISHU_HOST + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: { code?: number; msg?: string; data?: Record<string, unknown>; tenant_access_token?: string; expire?: number };
      try { json = text ? JSON.parse(text) : {}; } catch { throw new FeishuError(`飞书返回的不是 JSON（HTTP ${res.status}）`, res.status); }
      if (json.code !== undefined && json.code !== 0) {
        if (RETRY_CODES.has(json.code) && attempt < 2) { await this.sleep(700 * (attempt + 1)); continue; }
        const e = explainError(json.code, json.msg ?? '');
        throw new FeishuError(e.message, json.code, e.help);
      }
      if (res.status < 200 || res.status >= 300) throw new FeishuError(`飞书接口失败（HTTP ${res.status}）`, res.status);
      return { data: (json.data ?? json) as Record<string, unknown> };
    }
  }

  /** 获取并缓存 tenant_access_token（有效期以返回的 expire 为准，提前 60 秒刷新） */
  async getToken(): Promise<string> {
    if (this.token && this.now() < this.expireAt) return this.token;
    if (!this.cfg.appId.trim() || !this.cfg.appSecret.trim()) throw new FeishuError('请先在「飞书设置」里填写 App ID 和 App Secret', 'config');
    const res = await this.raw('POST', '/open-apis/auth/v3/tenant_access_token/internal', { app_id: this.cfg.appId.trim(), app_secret: this.cfg.appSecret.trim() }, false);
    const d = res.data as { tenant_access_token?: string; expire?: number };
    if (!d.tenant_access_token) throw new FeishuError('飞书没有返回 tenant_access_token，检查 App ID / Secret', 'token');
    this.token = d.tenant_access_token;
    this.expireAt = this.now() + Math.max(0, (d.expire ?? 7200) - 60) * 1000;
    return this.token;
  }

  private tbl() {
    if (!this.cfg.appToken || !this.cfg.tableId) throw new FeishuError('还没有可用的多维表格：先写入一次，或在「飞书设置」里填写已有表格', 'config');
    return `/open-apis/bitable/v1/apps/${this.cfg.appToken}/tables/${this.cfg.tableId}`;
  }

  async listFields(): Promise<FieldInfo[]> {
    const out: FieldInfo[] = [];
    let pageToken = '';
    for (let i = 0; i < 20; i++) {
      const r = await this.raw('GET', `${this.tbl()}/fields?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
      const d = r.data as { items?: FieldInfo[]; has_more?: boolean; page_token?: string };
      out.push(...(d.items ?? []));
      if (!d.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    return out;
  }

  /** 首次使用：建多维表格 → 整理索引列和字段。已有表格则只补缺的字段。返回创建了多少字段。 */
  async ensureTable(): Promise<{ created: boolean; fieldsCreated: number; cfg: FeishuConfig }> {
    let created = false;
    if (!this.cfg.appToken || !this.cfg.tableId) {
      const r = await this.raw('POST', '/open-apis/bitable/v1/apps', { name: this.cfg.baseName || '主播复盘数据台', time_zone: 'Asia/Shanghai' });
      const app = (r.data as { app?: { app_token?: string; default_table_id?: string; url?: string } }).app;
      if (!app?.app_token || !app.default_table_id) throw new FeishuError('创建多维表格失败：飞书没有返回 app_token', 'create');
      this.cfg = { ...this.cfg, appToken: app.app_token, tableId: app.default_table_id, tableUrl: app.url ?? '' };
      created = true;
    }
    const specs = tableFieldSpecs();
    let fields = await this.listFields();
    const primary = fields.find((f) => f.is_primary);
    const named = fields.find((f) => f.field_name === '主播');
    if (!named && primary) {
      await this.raw('PUT', `${this.tbl()}/fields/${primary.field_id}`, { field_name: '主播', type: primary.type });
    } else if (named && !named.is_primary) {
      throw new FeishuError('表里已有一个不是索引列的「主播」字段：请把它改名，或把索引列改名为「主播」', 'schema');
    }
    if (created) {
      const keep = new Set(['主播', ...specs.map((s) => s.field_name)]);
      for (const f of fields) {
        if (!f.is_primary && DEFAULT_JUNK.has(f.field_name) && !keep.has(f.field_name)) await this.raw('DELETE', `${this.tbl()}/fields/${f.field_id}`).catch(() => undefined);
      }
    }
    fields = await this.listFields();
    const have = new Set(fields.map((f) => f.field_name));
    let fieldsCreated = 0;
    const failed: string[] = [];
    for (const s of specs) {
      if (have.has(s.field_name)) continue;
      try {
        await this.raw('POST', `${this.tbl()}/fields`, s);
        fieldsCreated++;
      } catch (e) {
        if (e instanceof FeishuError && e.code === 1254014) continue; // 字段名重复：已存在
        if (e instanceof FeishuError && (e.code === 1254302 || e.code === 1254304)) throw e;
        failed.push(s.field_name);
      }
    }
    if (failed.length) throw new FeishuError(`有 ${failed.length} 个字段创建失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}`, 'schema');
    return { created, fieldsCreated, cfg: this.cfg };
  }

  async createRecord(fields: Record<string, unknown>): Promise<string> {
    const r = await this.raw('POST', `${this.tbl()}/records`, { fields });
    return ((r.data as { record?: { record_id?: string } }).record?.record_id) ?? '';
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.raw('PUT', `${this.tbl()}/records/${recordId}`, { fields });
  }

  async deleteRecord(recordId: string): Promise<void> {
    await this.raw('DELETE', `${this.tbl()}/records/${recordId}`);
  }

  /** 读取全部记录（每页最多 500 条，按 page_token 翻页；最多读 5000 条） */
  async listRecords(): Promise<RecordInfo[]> {
    const out: RecordInfo[] = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const r = await this.raw('GET', `${this.tbl()}/records?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
      const d = r.data as { items?: RecordInfo[]; has_more?: boolean; page_token?: string };
      out.push(...(d.items ?? []).map((x) => ({ record_id: x.record_id, fields: x.fields ?? {} })));
      if (!d.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    return out;
  }
}
