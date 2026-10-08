/**
 * SSE stream-to-non-streaming assembly for the playground tools. Mirrors the
 * dashboard Playground's JSON panel: chat-completions delta events, Anthropic
 * content blocks, Responses API `response.completed`. Best-effort — every
 * event's `id`/`usage` is captured when present, malformed frames are
 * skipped, and the assembled shape is the same regardless of streaming.
 *
 * The three branches are independent: each dialect's terminal shape is what
 * the dashboard JSON panel shows, with `usage` populated when the final
 * chunk carries it.
 */

/**
 * Parse one SSE payload into JSON frames.
 *
 * Only `data: ...` lines are consumed (event names like `message_start` are
 * redundant with the parsed frame's own `type` field for the dialects we
 * handle). Empty lines and `[DONE]` sentinels are dropped; malformed JSON
 * lines are skipped without aborting the rest of the stream.
 */
function parseFrames(sse: string): Record<string, unknown>[] {
  const dataLines = sse
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const frames: Record<string, unknown>[] = [];
  for (const line of dataLines) {
    if (!line || line === "[DONE]") continue;
    try {
      frames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore malformed frames
    }
  }
  return frames;
}

/**
 * Assemble a chat-completions SSE stream. Concatenates the `delta.content`
 * from every chunk into one assistant message; takes `id`/`model` from the
 * first chunk that carries them and `usage` from the chunk that carries it.
 */
function assembleChatCompletionsStream(frames: Record<string, unknown>[]): unknown {
  let content = "";
  let usage: unknown;
  let id: unknown;
  let model: unknown;
  let finishReason: unknown = "stop";
  for (const frame of frames) {
    id = id ?? frame.id;
    model = model ?? frame.model;
    if (frame.usage) usage = frame.usage;
    const choices = frame.choices as Record<string, unknown>[] | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }
  return {
    id,
    object: "chat.completion",
    model,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: finishReason },
    ],
    usage,
  };
}

/**
 * Assemble an Anthropic messages SSE stream. `message_start` seeds the
 * response header and usage; `content_block_delta` accumulates text;
 * `message_delta` overrides usage (the authoritative final usage arrives
 * there, not on the last content delta).
 */
function assembleMessagesStream(frames: Record<string, unknown>[]): unknown {
  let text = "";
  let usage: Record<string, unknown> = {};
  let header: Record<string, unknown> = {};
  for (const frame of frames) {
    if (frame.type === "message_start") {
      const message = frame.message as Record<string, unknown> | undefined;
      if (message) {
        header = message;
        usage = (message.usage as Record<string, unknown>) ?? {};
      }
    } else if (frame.type === "content_block_delta") {
      const delta = frame.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === "string") text += delta.text;
    } else if (frame.type === "message_delta") {
      const deltaUsage = frame.usage as Record<string, unknown> | undefined;
      if (deltaUsage) usage = { ...usage, ...deltaUsage };
    }
  }
  return {
    id: header.id,
    type: "message",
    role: "assistant",
    model: header.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage,
  };
}

/**
 * Assemble a Responses-API SSE stream. Prefers the terminal
 * `response.completed` frame (carries the full final response); otherwise
 * falls back to concatenating `response.output_text.delta` frames into a
 * single assistant message.
 */
function assembleResponsesStream(frames: Record<string, unknown>[]): unknown {
  for (const frame of frames) {
    if (frame.type === "response.completed") {
      const response = frame.response as Record<string, unknown> | undefined;
      if (response) return response;
    }
  }
  let text = "";
  let id: unknown;
  let model: unknown;
  for (const frame of frames) {
    id = id ?? frame.id;
    model = model ?? frame.model;
    if (frame.type === "response.output_text.delta" && typeof frame.delta === "string") {
      text += frame.delta;
    }
  }
  return {
    id,
    object: "response",
    model,
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
  };
}

/**
 * Dispatch SSE assembly to the dialect-specific helper.
 *
 * Exported separately so callers can unit-test the per-dialect branches
 * without going through the full playground send flow.
 */
export function assembleStream(endpoint: string, sse: string): unknown {
  const frames = parseFrames(sse);
  switch (endpoint) {
    case "chat_completions":
      return assembleChatCompletionsStream(frames);
    case "messages":
      return assembleMessagesStream(frames);
    default:
      return assembleResponsesStream(frames);
  }
}