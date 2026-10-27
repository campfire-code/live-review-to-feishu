// 工具声明：主播复盘入表台（自定义界面：录入 / 记录 / 飞书设置）。
import { createElement } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'o27',
  name: '主播复盘入表台',
  tagline: '抖音、视频号、快手复盘截图各传一张，大模型看图识别关键指标，抽检核对后一键写进飞书多维表格，同一场三平台数据落在同一行。',
  icon: ClipboardCheck,
  category: '办公提效',
  type: 'data',
  mode: 'custom',
  mainLabel: '复盘入表',
  needsLLM: true,
  params: [],
  // 预览页（preview.html）里不联网，用虚构示例数据和假接口
  Main: ({ ctx }) => createElement(Main, { preview: location.pathname.endsWith('preview.html'), readFile: ctx.readFile }),
};

export default tool;
