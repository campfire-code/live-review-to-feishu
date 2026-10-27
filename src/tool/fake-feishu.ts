// 手写的飞书接口假服务：请求路径、方法与响应结构按飞书开放平台文档（bitable v1、auth v3）。
// 新建多维表格时默认带的示例列是按参考实现的观察写的，文档未列出。供测试和截图预览使用，不联网。
import type { HttpFn } from './feishu';

interface Field { field_id: string; field_name: string; type: number; is_primary: boolean }
interface Rec { record_id: string; fields: Record<string, unknown> }
interface Table { fields: Field[]; records: Rec[] }

export interface FakeOptions {
  appId?: string;
  appSecret?: string;
  /** 写入类接口返回“无权限” */
  readOnly?: boolean;
  /** 创建这些名字的字段时失败 */
  failFields?: string[];
}

export function createFakeFeishu(opts: FakeOptions = {}) {
  const bases = new Map<string, Table>();
  let seq = 0;
  const id = (p: string) => `${p}${(++seq).toString().padStart(4, '0')}`;
  const calls: string[] = [];
  const state = { tokenCalls: 0 };

  const ok = (data: unknown) => ({ code: 0, msg: 'success', data });
  const err = (code: number, msg: string) => ({ code, msg });
  const newTable = (): Table => ({
    fields: [
      { field_id: id('fld'), field_name: '文本', type: 1, is_primary: true },
      { field_id: id('fld'), field_name: '单选', type: 3, is_primary: false },
      { field_id: id('fld'), field_name: '日期', type: 5, is_primary: false },
      { field_id: id('fld'), field_name: '附件', type: 17, is_primary: false },
    ],
    records: [],
  });
  /** 预置一张已有的表（用户自己建的表） */
  const seedTable = (appToken: string, tableId: string, fields: { name: string; type: number; primary?: boolean }[]) => {
    bases.set(`${appToken}/${tableId}`, { fields: fields.map((f) => ({ field_id: id('fld'), field_name: f.name, type: f.type, is_primary: !!f.primary })), records: [] });
  };
  const tableOf = (appToken: string, tableId: string) => bases.get(`${appToken}/${tableId}`);

  const http: HttpFn = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    calls.push(`${init.method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = (json: unknown, status = 200) => ({ status, text: async () => JSON.stringify(json) });

    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      state.tokenCalls++;
      if ((opts.appId && body.app_id !== opts.appId) || (opts.appSecret && body.app_secret !== opts.appSecret)) return reply(err(10003, 'invalid param'));
      return reply({ code: 0, msg: 'ok', tenant_access_token: `t-fake-${state.tokenCalls}`, expire: 7200 });
    }
    if (!/^Bearer t-fake-/.test(init.headers.Authorization ?? '')) return reply(err(99991661, 'Missing access token for authorization'), 400);
    const write = init.method !== 'GET';
    if (opts.readOnly && write && path !== '/open-apis/bitable/v1/apps') return reply(err(1254302, 'Permission denied.'), 403);

    if (path === '/open-apis/bitable/v1/apps' && init.method === 'POST') {
      const app = id('bascn'); const tbl = id('tbl');
      bases.set(`${app}/${tbl}`, newTable());
      return reply(ok({ app: { app_token: app, name: body.name, default_table_id: tbl, url: `https://example.feishu.cn/base/${app}`, time_zone: body.time_zone } }));
    }
    const m = /^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables\/([^/]+)\/(fields|records)(?:\/([^/]+))?$/.exec(path);
    if (!m) return reply(err(404, 'not found'), 404);
    const [, appToken, tableId, kind, itemId] = m;
    if (![...bases.keys()].some((k) => k.startsWith(appToken + '/'))) return reply(err(1254040, 'AppTokenNotFound'));
    const t = tableOf(appToken, tableId);
    if (!t) return reply(err(1254041, 'TableIdNotFound'));
    const page = <T,>(all: T[]) => {
      const size = Number(u.searchParams.get('page_size') ?? 20);
      const start = Number(u.searchParams.get('page_token') ?? 0);
      const items = all.slice(start, start + size);
      const more = start + size < all.length;
      return { items, has_more: more, ...(more ? { page_token: String(start + size) } : {}), total: all.length };
    };

    if (kind === 'fields') {
      if (init.method === 'GET') return reply(ok(page(t.fields.map((f) => ({ ...f, property: null })))));
      if (init.method === 'POST') {
        if (!body.field_name) return reply(err(1254028, 'EmptyFieldName'), 400);
        if (opts.failFields?.includes(body.field_name)) return reply(err(1254290, 'Too many requests'));
        if (t.fields.some((f) => f.field_name === body.field_name)) return reply(err(1254014, 'FieldNameDuplicated'));
        const f = { field_id: id('fld'), field_name: body.field_name, type: body.type, is_primary: false };
        t.fields.push(f);
        return reply(ok({ field: f }));
      }
      const f = t.fields.find((x) => x.field_id === itemId);
      if (!f) return reply(err(1254044, 'FieldIdNotFound'));
      if (init.method === 'PUT') { f.field_name = body.field_name; f.type = body.type; return reply(ok({ field: f })); }
      if (init.method === 'DELETE') {
        if (f.is_primary) return reply(err(1254046, 'The Primary Field cannot be deleted.'));
        t.fields = t.fields.filter((x) => x !== f);
        return reply(ok({ field_id: f.field_id, deleted: true }));
      }
    }
    if (kind === 'records') {
      const check = (fields: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(fields)) {
          const f = t.fields.find((x) => x.field_name === k);
          if (!f) return err(1254045, `FieldNameNotFound: ${k}`);
          if ((f.type === 2 || f.type === 5) && typeof v !== 'number' && v !== null) return err(1254015, `FieldTypeValueNotMatch: ${k}`);
          if (f.type === 1 && typeof v !== 'string' && v !== null) return err(1254015, `FieldTypeValueNotMatch: ${k}`);
        }
        return null;
      };
      if (init.method === 'GET') return reply(ok(page(t.records)));
      if (init.method === 'POST') {
        const e = check(body.fields ?? {});
        if (e) return reply(e);
        const r = { record_id: id('rec'), fields: { ...body.fields } };
        t.records.push(r);
        return reply(ok({ record: { id: r.record_id, record_id: r.record_id, fields: r.fields } }));
      }
      const r = t.records.find((x) => x.record_id === itemId);
      if (!r) return reply(err(1254043, 'RecordIdNotFound'));
      if (init.method === 'PUT') {
        const e = check(body.fields ?? {});
        if (e) return reply(e);
        for (const [k, v] of Object.entries(body.fields ?? {})) { if (v === null) delete r.fields[k]; else r.fields[k] = v; }
        return reply(ok({ record: { id: r.record_id, record_id: r.record_id, fields: r.fields } }));
      }
      if (init.method === 'DELETE') { t.records = t.records.filter((x) => x !== r); return reply(ok({ deleted: true, record_id: r.record_id })); }
    }
    return reply(err(404, 'not found'), 404);
  };

  return { http, bases, calls, state, seedTable, tableOf };
}
