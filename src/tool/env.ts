// 界面和流程之间的共享环境：真实运行用 Tauri 的网络请求，预览页用假飞书和假大模型。
import { httpFetch } from '../kit/platform';
import type { Anchor, Wechat, LogLine } from './store';
import { FeishuClient, type FeishuConfig, type HttpFn } from './feishu';
import type { VisionFn } from './vision';

export const realHttp: HttpFn = (url, init) => httpFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });

export interface Env {
  preview: boolean;
  http: HttpFn;
  vision: VisionFn;
  cfg: FeishuConfig;
  /** 表格字段已补全过，写入时可以跳过检查 */
  schemaOk: boolean;
  saveCfg(c: FeishuConfig): Promise<void>;
  client(): FeishuClient;
  anchors: Anchor[];
  wechats: Wechat[];
  log(text: string, level?: LogLine['level']): void;
}
