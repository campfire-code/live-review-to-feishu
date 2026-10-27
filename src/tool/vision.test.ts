import { describe, expect, it } from 'vitest';
import { recognize, toDataUrl, type VisionFn } from './vision';
import { SAMPLE_METRICS, fakeReply } from './fixtures';
import { qaCheck } from './core';

describe('识别（假大模型）', () => {
  it('三个平台都能解析，且抽检通过', async () => {
    const vision: VisionFn = async (_img, prompt) => fakeReply(prompt);
    const out = {} as Record<string, Record<string, string>>;
    for (const p of ['douyin', 'videohao', 'kuaishou'] as const) out[p] = (await recognize(p, 'data:image/png;base64,AAAA', vision)).metrics;
    expect(out.douyin['收获音浪']).toBe('18,640');
    expect(out.kuaishou['直播时长(分钟)']).toBe('148');
    expect(out).toEqual(SAMPLE_METRICS);
    expect(qaCheck(out)).toEqual([]);
  });
  it('第一次回复不是 JSON 时重试一次，提示词强调只输出 JSON', async () => {
    const prompts: string[] = [];
    const vision: VisionFn = async (_i, prompt) => { prompts.push(prompt); return prompts.length === 1 ? '图片太模糊了' : fakeReply(prompt); };
    const r = await recognize('douyin', 'data:x', vision);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('只输出一个 JSON');
    expect(r.error).toBeUndefined();
    expect(r.metrics['曝光人数']).toBe('48,210');
  });
  it('两次都不是 JSON：返回空字段和错误说明，不抛出', async () => {
    const r = await recognize('douyin', 'data:x', async () => '看不清');
    expect(r.error).toContain('请重试或手动填写');
    expect(Object.values(r.metrics).every((v) => v === '')).toBe(true);
  });
  it('网络错误向上抛出；图片转 data 地址', async () => {
    await expect(recognize('douyin', 'data:x', async () => { throw new Error('大模型调用失败（401，密钥不对或已过期）'); })).rejects.toThrow('401');
    expect(toDataUrl(new Uint8Array([137, 80, 78, 71]), 'a.PNG')).toBe('data:image/png;base64,iVBORw==');
    expect(toDataUrl(new Uint8Array([1]), 'a.jpg').startsWith('data:image/jpeg')).toBe(true);
  });
});
