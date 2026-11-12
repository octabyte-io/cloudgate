import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

/**
 * Tokens one call spent, each count flagged reported (the runtime said, in
 * `usage`) or estimated (the Gateway counted them with a tokenizer).
 */
export interface Tokens {
  prompt: number;
  promptEstimated: boolean;
  completion: number;
  completionEstimated: boolean;
}

export const NO_TOKENS: Tokens = {
  prompt: 0,
  promptEstimated: false,
  completion: 0,
  completionEstimated: false,
};

/** The two endpoints whose streams carry a `usage` chunk on request. */
const STREAMS_USAGE = new Set(['/v1/chat/completions', '/v1/completions']);

/**
 * The body the runtime is sent for a streamed call, and whether the caller
 * asked for the usage chunk itself: `stream_options.include_usage`
 * is always forced on, so every stream can be metered from what the runtime
 * reports, and the chunk is handed on only to a caller who asked for it.
 */
export function withStreamedUsage(
  endpoint: string,
  body: Record<string, unknown>,
): { upstreamBody: Record<string, unknown>; callerAskedForUsage: boolean } {
  if (!STREAMS_USAGE.has(endpoint)) {
    return { upstreamBody: body, callerAskedForUsage: true };
  }
  const options = isRecord(body.stream_options) ? body.stream_options : {};
  return {
    upstreamBody: {
      ...body,
      stream_options: { ...options, include_usage: true },
    },
    callerAskedForUsage: options.include_usage === true,
  };
}

/**
 * The tokens of a whole, non-streamed answer: its `usage`, reported; or, when
 * the runtime left it out, both counts estimated from the request and the
 * answer's text. `/v1/models` lists models and spends none.
 */
export function tokensOfWhole(
  endpoint: string,
  request: Record<string, unknown>,
  whole: Buffer,
): Tokens {
  if (endpoint === '/v1/models') return NO_TOKENS;
  let answer: unknown;
  try {
    answer = JSON.parse(whole.toString('utf8'));
  } catch {
    answer = undefined;
  }
  const reported = isRecord(answer) ? reportedTokens(answer.usage) : null;
  if (reported) return reported;
  return estimate(
    request,
    isRecord(answer) ? textOfChoices(answer.choices, 'message') : '',
  );
}

/**
 * The meter on a streamed answer: a pass-through for the runtime's
 * server-sent events that reads each one as it goes by. It keeps the `usage`
 * the runtime reports, which it drops from the stream unless the caller asked
 * for it, and the completion text streamed so far, so a stream whose usage
 * never arrives (cut, abandoned, or a runtime that ignores `include_usage`)
 * is still counted, estimated.
 *
 * Each event is handed on whole as soon as its blank line arrives, so the
 * caller sees the answer as it is produced. Never stores a body beyond the
 * text it counts, and that only for the life of the call.
 */
export class StreamMeter extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private completionText = '';
  private reported: Tokens | null = null;

  constructor(
    private readonly request: Record<string, unknown>,
    private readonly callerAskedForUsage: boolean,
  ) {
    super();
  }

  /** What the call has spent so far: reported if the runtime said, else estimated. */
  tokens(): Tokens {
    return this.reported ?? estimate(this.request, this.completionText);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.pending += this.decoder.write(chunk);
    let out = '';
    for (;;) {
      const end = /\r?\n\r?\n/.exec(this.pending);
      if (!end) break;
      const event = this.pending.slice(0, end.index + end[0].length);
      this.pending = this.pending.slice(end.index + end[0].length);
      out += this.read1(event);
    }
    done(null, out.length > 0 ? out : undefined);
  }

  override _flush(done: TransformCallback): void {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    done(null, rest.length > 0 ? this.read1(rest) : undefined);
  }

  /** One event: counted, and handed on as it came, without its usage, or not at all. */
  private read1(event: string): string {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (data === '' || data === '[DONE]') return event;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return event;
    }
    if (!isRecord(chunk)) return event;
    this.completionText += textOfChoices(chunk.choices, 'delta');
    const usage = reportedTokens(chunk.usage);
    if (!usage) return event;
    this.reported = usage;
    if (this.callerAskedForUsage) return event;
    // The usage chunk OpenAI defines has no choices; a runtime that puts
    // `usage` on a content chunk keeps the content and loses the `usage`.
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return '';
    const withoutUsage = { ...chunk };
    delete withoutUsage.usage;
    return `data: ${JSON.stringify(withoutUsage)}\n\n`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportedTokens(usage: unknown): Tokens | null {
  if (!isRecord(usage)) return null;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : 0;
  return {
    prompt: count(usage.prompt_tokens),
    promptEstimated: false,
    completion: count(usage.completion_tokens),
    completionEstimated: false,
  };
}

/** Both counts by tokenizer: the prompt from the request, the completion from `completionText`. */
function estimate(
  request: Record<string, unknown>,
  completionText: string,
): Tokens {
  return {
    prompt: countTokens(promptTextOf(request)),
    promptEstimated: true,
    completion: countTokens(completionText),
    completionEstimated: true,
  };
}

/**
 * The text a request sends the model: chat `messages` (string content, or the
 * text parts of an array), a completion's `prompt`, or an embedding's `input`.
 */
function promptTextOf(request: Record<string, unknown>): string {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (isRecord(value) && typeof value.text === 'string') {
      texts.push(value.text);
    }
  };
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message)) collect(message.content);
    }
  }
  collect(request.prompt);
  collect(request.input);
  return texts.join('\n');
}

/**
 * The completion text in an answer's `choices`: each choice's `message` (or a
 * stream chunk's `delta`) content, or a completion's `text`.
 */
function textOfChoices(choices: unknown, part: 'message' | 'delta'): string {
  if (!Array.isArray(choices)) return '';
  let text = '';
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const said = choice[part];
    if (isRecord(said) && typeof said.content === 'string') {
      text += said.content;
    }
    if (typeof choice.text === 'string') text += choice.text;
  }
  return text;
}
