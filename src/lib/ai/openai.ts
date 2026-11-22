import { getOpenAiConfig, isOpenAiConfigured } from "@/lib/env";

export class OpenAiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Minimal Chat Completions call. Server-only; returns the assistant text.
 * Throws OpenAiError on missing key / provider failures.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  if (!isOpenAiConfigured()) {
    throw new OpenAiError("OpenAI is not configured. Set OPENAI_API_KEY on the server.");
  }
  const { apiKey, model } = getOpenAiConfig();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
    }),
  });

  const raw = await res.text();
  let parsed: { error?: { message?: string }; choices?: { message?: { content?: string } }[] } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const msg = parsed.error?.message || `OpenAI request failed (${res.status})`;
    throw new OpenAiError(msg, res.status);
  }
  const text = parsed.choices?.[0]?.message?.content?.trim();
  if (!text) throw new OpenAiError("OpenAI returned an empty response");
  return text;
}
