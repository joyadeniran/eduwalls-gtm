import { GoogleGenAI } from '@google/genai';
import { config, assertConfigured } from './config.js';

let client: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  assertConfigured();
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Rate limits and transient 5xx are worth waiting out; bad keys are not.
      const retryable = /429|5\d\d|timeout|ECONNRESET|fetch failed|overloaded|UNAVAILABLE/i.test(msg);
      if (!retryable || i === attempts - 1) break;
      await sleep(2000 * 2 ** i);
    }
  }
  throw new Error(`${label} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Free-text generation with Google Search grounding. Used for live research. */
export async function groundedResearch(prompt: string): Promise<{ text: string; sources: string[] }> {
  const res = await withRetry('grounded research', () =>
    ai().models.generateContent({
      model: config.models.research,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }], temperature: 0.2 },
    }),
  );
  const text = res.text ?? '';
  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c) => c.web?.uri)
    .filter((u): u is string => Boolean(u))
    .slice(0, 12);
  return { text, sources };
}

/**
 * Structured generation. Gemini cannot combine Google Search with a response
 * schema, so grounded facts are passed in as text and shaped here.
 */
export async function generateJson<T>(opts: {
  model?: string;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<T> {
  const res = await withRetry('structured generation', () =>
    ai().models.generateContent({
      model: opts.model ?? config.models.writer,
      contents: opts.prompt,
      config: {
        systemInstruction: opts.system,
        responseMimeType: 'application/json',
        responseSchema: opts.schema as never,
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: opts.maxOutputTokens ?? 4096,
      },
    }),
  );
  const raw = (res.text ?? '').trim();
  if (!raw) throw new Error('Gemini returned an empty response');
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Salvage the outermost JSON value if the model wrapped it in prose.
    const start = raw.search(/[[{]/);
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
    throw new Error(`Gemini returned unparseable JSON: ${raw.slice(0, 200)}`);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await ai().models.generateContent({
      model: config.models.writer,
      contents: 'Reply with the single word: ok',
      config: { maxOutputTokens: 16 },
    });
    return Boolean(res.text);
  } catch {
    return false;
  }
}
