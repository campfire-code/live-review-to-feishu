// 流程：写入一条复盘、编辑时只提交改动的字段。依赖 FeishuClient，可用假接口测试。
import { buildRecordFields, dateToMs, fansFields, flatCell, msToDate, type RecordInput, type WechatFan } from './core';
import { FeishuClient, FeishuError, type FeishuConfig, type FieldInfo } from './feishu';

export interface SubmitResult { recordId: string; cfg: FeishuConfig; ensured: boolean; createdTable: boolean }

/** 写入一条记录。schemaOk=false 时先建表 / 补字段；写入报“字段不存在”时补全字段后重试一次。 */
export async function submitRecord(client: FeishuClient, input: RecordInput, schemaOk: boolean, log: (s: string) => void = () => undefined): Promise<SubmitResult> {
  const fields = buildRecordFields(input);
  let ensured = false;
  let createdTable = false;
  const ensure = async () => {
    log('正在检查飞书多维表格和字段…');
    const r = await client.ensureTable();
    ensured = true;
    createdTable = createdTable || r.created;
    log(r.created ? `已新建多维表格，创建 ${r.fieldsCreated} 个字段` : r.fieldsCreated ? `已补全 ${r.fieldsCreated} 个字段` : '字段齐全');
  };
  if (!schemaOk || !client.cfg.appToken || !client.cfg.tableId) await ensure();
  let recordId: string;
  try {
    recordId = await client.createRecord(fields);
  } catch (e) {
    if (!(e instanceof FeishuError && e.code === 1254045) || ensured) throw e;
    await ensure();
    recordId = await client.createRecord(fields);
  }
  return { recordId, cfg: client.cfg, ensured, createdTable };
}

/** 编辑表单里一个字段的取值（全部是文本框内容） */
export interface EditInput {
  values: Record<string, string>;
  groupCount: string;
  fans: WechatFan[];
}

/**
 * 对比原记录，只返回有改动的字段（飞书更新是增量的）。
 * 加群数 / 加微总数 / 加微率 / 私域分配由加群数和各微信号加粉重新计算。
 */
export function diffEdit(original: Record<string, unknown>, fieldInfos: FieldInfo[], edit: EditInput): Record<string, string | number> {
  const typeOf = new Map(fieldInfos.map((f) => [f.field_name, f.type]));
  const out: Record<string, string | number> = {};
  const derived = new Set(['加群数', '加微总数', '加微率', '私域分配']);
  const g = edit.groupCount.trim() === '' ? null : Number(edit.groupCount);
  const calc = fansFields(g != null && Number.isFinite(g) ? g : null, edit.fans);
  for (const [k, v] of Object.entries(calc)) {
    const old = flatCell(original[k]);
    if (String(v) !== old && !(old === '' && v === '')) out[k] = v;
  }
  for (const [name, raw] of Object.entries(edit.values)) {
    if (derived.has(name)) continue;
    const type = typeOf.get(name) ?? 1;
    const old = original[name];
    if (type === 5) {
      if (!raw) continue;
      const ms = dateToMs(raw);
      if (ms != null && (typeof old !== 'number' || msToDate(old) !== raw)) out[name] = ms;
    } else if (type === 2) {
      if (raw.trim() === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n !== Number(flatCell(old))) out[name] = n;
    } else if (raw !== flatCell(old)) {
      out[name] = raw;
    }
  }
  return out;
}

export type { RecordInput };
