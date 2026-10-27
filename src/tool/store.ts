// 本机保存：飞书配置、主播和微信号清单、运行日志。放在 settings.json（键以 o27. 开头），不上传。
// 注意：App Secret 以明文存在本机设置文件里，与其他设置一样只在本机。
import { settingsStore } from '../kit/platform';
import type { FeishuConfig } from './feishu';

export const EMPTY_CONFIG: FeishuConfig = { appId: '', appSecret: '', baseName: '主播复盘数据台', tableName: '主播复盘记录', appToken: '', tableId: '', tableUrl: '' };
export interface Wechat { id: string; name: string; note: string }
export interface Anchor { id: string; name: string }
export interface LogLine { at: string; text: string; level: 'info' | 'ok' | 'err' }

async function get<T>(key: string, dflt: T): Promise<T> {
  try { return ((await (await settingsStore()).get<T>('o27.' + key)) ?? dflt); } catch { return dflt; }
}
async function put(key: string, v: unknown) {
  try { await (await settingsStore()).set('o27.' + key, v); } catch { /* 预览页没有设置文件 */ }
}

export const loadConfig = async (): Promise<FeishuConfig> => ({ ...EMPTY_CONFIG, ...(await get<Partial<FeishuConfig>>('feishu', {})) });
export const saveConfig = (c: FeishuConfig) => put('feishu', c);
export const loadAnchors = () => get<Anchor[]>('anchors', []);
export const saveAnchors = (a: Anchor[]) => put('anchors', a);
export const loadWechats = () => get<Wechat[]>('wechats', []);
export const saveWechats = (w: Wechat[]) => put('wechats', w);
export const loadLog = () => get<LogLine[]>('log', []);
export const saveLog = (l: LogLine[]) => put('log', l.slice(-200));
/** 表格字段已经补全过（避免每次写入都去查字段）：键是 appToken+tableId */
export const loadSchemaOk = () => get<string>('schemaOk', '');
export const saveSchemaOk = (k: string) => put('schemaOk', k);

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
