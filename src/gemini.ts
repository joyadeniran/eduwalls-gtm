import { GoogleGenAI } from '@google/genai';
import { getSettings } from './settings.js';

const clients = new Map<string, GoogleGenAI>();

async function ai(): Promise<{ client: GoogleGenAI; research: string; writer: string }> {
  const s = await getSettings();
  if (!s.geminiApiKey) {
    throw new Error('No Gemini API key configured. Add one in Settings, or set GEMINI_API_KEY.');
  }
  let client = clients.get(s.geminiApiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey: s.geminiApiKey });
    clients.set(s.geminiApiKey, client);
  }
  return { client, research: s.researchModel, writer: s.writerModel };
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
      // Rate limits and transient 5xx are worth waiting out; a bad key is not.
      const retryable = /429|5\d\d|timeout|ECONNRESET|fetch failed|overloaded|UNAVAILABLE/i.test(msg);
      if (!retryable || i === attempts - 1) break;
      await sleep(2000 * 2 ** i);
    }
  }
  throw new Error(`${label} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Free-text generation with Google Search grounding. Used for live research. */
export async function groundedResearch(prompt: string): Promise<{ text: string; sources: string[] }> {
  const { client, research } = await ai();
  const res = await withRetry('grounded research', () =>
    client.models.generateContent({
      model: research,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }], temperature: 0.2 },
    }),
  );
  const text = res.text ?? '';
  const sources = (res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
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
  useResearchModel?: boolean;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<T> {
  const { client, research, writer } = await ai();
  const res = await withRetry('structured generation', () =>
    client.models.generateContent({
      model: opts.useResearchModel ? research : writer,
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

export async function healthCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { client, writer } = await ai();
    const res = await client.models.generateContent({
      model: writer,
      contents: 'Reply with the single word: ok',
      config: { maxOutputTokens: 16 },
    });
    return { ok: Boolean(res.text), detail: res.text ? `${writer} responded` : 'empty response' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
