// 识别：把截图交给用户自己配置的多模态大模型（OpenAI 兼容接口），解析成指标。
// kit 的 chat() 只支持纯文本消息，所以这里直接按 OpenAI 的图片消息格式调 /chat/completions；接口地址、密钥、模型名仍读 kit 设置页里填的那一份。
import { buildVisionPrompt, parseModelReply, type Metrics, type Platform } from './core';
import { loadSettings, llmReady } from '../kit/settings';
import { httpFetch } from '../kit/platform';

/** 看图并返回模型回复文本 */
export type VisionFn = (imageDataUrl: string, prompt: string) => Promise<string>;

export const realVision: VisionFn = async (imageDataUrl, prompt) => {
  const { llm } = await loadSettings();
  if (!llmReady(llm)) throw new Error('还没有设置大模型：请到「设置」里填写接口地址、密钥和模型名（需要支持看图的多模态模型）');
  const res = await httpFetch(llm.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.1,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: prompt }] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? '密钥不对或已过期' : res.status === 404 ? '接口地址或模型名不对' : res.status === 429 ? '调用太频繁或额度用完' : res.status === 400 ? '这个模型可能不支持看图，请换多模态模型' : '接口返回错误';
    throw new Error(`大模型调用失败（${res.status}，${hint}）${body ? '：' + body.slice(0, 160) : ''}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const c = data.choices?.[0]?.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x?.text ?? '').join('') : '';
  if (!text) throw new Error('大模型没有返回内容');
  return text;
};

export interface Recognized { metrics: Metrics; raw: string; unknown: string[]; error?: string }

/** 识别一张截图。回复解析失败时重试一次（第二次强调只输出 JSON）；网络或接口错误直接抛出。 */
export async function recognize(platform: Platform, imageDataUrl: string, vision: VisionFn): Promise<Recognized> {
  const prompt = buildVisionPrompt(platform);
  let raw = await vision(imageDataUrl, prompt);
  let parsed = parseModelReply(raw, platform);
  if (!parsed.ok) {
    raw = await vision(imageDataUrl, prompt + '\n注意：只输出一个 JSON 对象，不要有任何其他文字。');
    parsed = parseModelReply(raw, platform);
  }
  return { metrics: parsed.metrics, raw, unknown: parsed.unknown, error: parsed.ok ? undefined : `${parsed.error}，请重试或手动填写` };
}

/** 图片字节 → data: 地址 */
export function toDataUrl(bytes: Uint8Array, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
