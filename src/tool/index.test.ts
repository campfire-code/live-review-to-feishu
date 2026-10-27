import { describe, expect, it } from 'vitest';
import tool from './index';
import meta from '../../tool.json';

describe('工具声明', () => {
  it('与 tool.json 一致，自定义界面，需要大模型', () => {
    expect(tool.id).toBe(meta.id);
    expect(tool.name).toBe(meta.name);
    expect(tool.mode).toBe('custom');
    expect(tool.needsLLM).toBe(true);
    expect(tool.icon).toBeTruthy();
  });
});
