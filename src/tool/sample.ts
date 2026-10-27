// 预览页（截图用）：虚构主播和数据，飞书用假接口。标明“示例”。
import { createFakeFeishu } from './fake-feishu';
import { FeishuClient, type FeishuConfig } from './feishu';
import { SAMPLE_ANCHOR, SAMPLE_DATE, SAMPLE_METRICS, fakeReply } from './fixtures';
import { submitRecord } from './flow';
import type { Anchor, Wechat } from './store';
import type { EntryState } from './Entry';
import type { PlatformMetrics } from './core';
import dy from '../../samples/示例-抖音复盘.png?url';
import vh from '../../samples/示例-视频号复盘.png?url';
import ks from '../../samples/示例-快手复盘.png?url';

export const SAMPLE_ANCHORS: Anchor[] = [{ id: 'a1', name: SAMPLE_ANCHOR }, { id: 'a2', name: '示例主播·阿北' }, { id: 'a3', name: '示例主播·七月' }];
export const SAMPLE_WECHATS: Wechat[] = [{ id: 'w1', name: '示例运营号1', note: '示例' }, { id: 'w2', name: '示例运营号2', note: '示例' }];
export const SAMPLE_CFG: FeishuConfig = { appId: 'cli_example', appSecret: 'example', baseName: '主播复盘数据台', tableName: '主播复盘记录', appToken: '', tableId: '', tableUrl: '' };

/** 带一处故意改错的数值，用来展示抽检提示 */
const metrics: PlatformMetrics = JSON.parse(JSON.stringify(SAMPLE_METRICS));
metrics.douyin!['进房率'] = '14.5%';
metrics.kuaishou!['在线人数峰值'] = '2,431';

export const sampleEntry = (): EntryState => ({
  anchorId: 'a1', date: SAMPLE_DATE, groupCount: '80', note: '示例：晚场，主推秋冬新品',
  images: { douyin: { name: '示例-抖音复盘.png', url: dy }, videohao: { name: '示例-视频号复盘.png', url: vh }, kuaishou: { name: '示例-快手复盘.png', url: ks } }, rec: metrics, engine: '大模型看图', errors: {},
});

/** 假飞书：预先建好表并写入几条示例记录 */
export async function sampleFeishu() {
  const fake = createFakeFeishu();
  let cfg = SAMPLE_CFG;
  const rows: [string, string, number, number][] = [[SAMPLE_ANCHOR, '2026-10-26', 80, 43], ['示例主播·阿北', '2026-10-25', 64, 31], ['示例主播·七月', '2026-10-24', 52, 0], [SAMPLE_ANCHOR, '2026-10-23', 71, 40]];
  for (const [i, [anchor, date, g, wx]] of rows.entries()) {
    const m: PlatformMetrics = JSON.parse(JSON.stringify(SAMPLE_METRICS));
    m.douyin!['曝光人数'] = String(48210 - i * 3100).replace(/\B(?=(\d{3})+$)/g, ',');
    m.douyin!['收获音浪'] = String(18640 - i * 2250).replace(/\B(?=(\d{3})+$)/g, ',');
    const r = await submitRecord(new FeishuClient(cfg, fake.http, async () => undefined), {
      anchor, date, note: '', groupCount: g, engine: '大模型看图', metrics: m,
      fans: wx ? [{ name: '示例运营号1', count: Math.ceil(wx / 2) }, { name: '示例运营号2', count: wx - Math.ceil(wx / 2) }] : [],
    }, i > 0);
    cfg = r.cfg;
  }
  return { fake, cfg };
}
export { fakeReply };
