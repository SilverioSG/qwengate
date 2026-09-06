import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { logStore } from '../services/logStore.ts';
import { reportRateLimitWall } from '../services/qwen.ts';
import { sessionPool } from '../services/sessionPool.ts';
import type { Message, OpenAIRequest } from '../types/openai.ts';
import { type AmplificationGuardState } from './chatHelpers.ts';
import { type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { cleanupImmediately } from './cleanupHelpers.ts';
import { getRetryablePreEmissionQuota, handlePostStreamCompletion, MAX_MIDSTREAM_QUOTA_HANDOFFS, runStreamLoop } from './streamLoop.ts';
import { buildChunkEvent, makeChoice, writeEvent } from './writeHelpers.ts';

export interface AcquiredStreamingSession {
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
  stream: ReadableStream;
  qwenAbortController: AbortController;
  qwenLogFile?: string;
}

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  qwenLogFile?: string;
  /**
   * Mid-stream pre-emission handoff factory (optional).
   * Called at most once per request with the failed account excluded.
   * Returns null when no alternative account is eligible — the caller then
   * surfaces a controlled terminal error instead of looping.
   */
  acquireNextSession?: (excludeEmail: string) => Promise<AcquiredStreamingSession | null>;
}

function buildPromptString(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : String(m.content ?? '');
      return `${m.role}: ${content}`;
    })
    .join('\n\n');
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, cleanOutput } = ctx;

  const finalPrompt = buildPromptString(body.messages);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (streamWriter: any) => {
    const _streamStartTime = Date.now();
    logStore.log('debug', 'stream', `[Stream] >>> Streaming started for ${logId}, model=${body.model}, tools=${body.tools?.length || 0}`);
    let streamReleased = false;
    let heartbeatInterval: any;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    // Active attempt — replaced on mid-stream pre-emission handoff (max 1).
    let current = {
      session: ctx.session,
      stream: ctx.stream,
      qwenAbortController: ctx.qwenAbortController,
      resolvedEmail: ctx.resolvedEmail,
      sessionHeaders: ctx.sessionHeaders,
      initialParentId: ctx.initialParentId,
      qwenLogFile: ctx.qwenLogFile,
    };
    let handoffsUsed = 0;

    try {
      heartbeatInterval = createHeartbeat(streamWriter);
      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));

      for (;;) {
        const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };
        activeReader = current.stream.getReader();
        const reader: ReadableStreamDefaultReader<Uint8Array> = activeReader;
        const enableContentFiltering = cleanOutput;
        const streamState = buildInitialStreamState(finalPrompt, current.initialParentId);

        const streamCtx: StreamProcessingCtx = {
          streamWriter,
          completionId,
          model: body.model,
          enableContentFiltering,
          cleanOutput,
          logId,
          resolvedEmail: current.resolvedEmail,
          ampState,
          qwenAbortController: current.qwenAbortController,
          qwenLogFile: current.qwenLogFile,
          emittedToolCallCount: 0,
        };

        const bufferRef = { text: '' };
        const loopResult = await runStreamLoop(c, reader, streamState, streamCtx, ampState, bufferRef);

        if (loopResult.error) {
          // Upstream went silent — silently terminate stream, log server-side only
          logStore.log('debug', 'stream', `[Chat] Stream timeout for ${logId}: ${loopResult.error}`);
          logStore.addError(logId, loopResult.error);
          await streamWriter.write('data: [DONE]\n\n');
          logStore.updateEntry(logId, (entry) => {
            if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
            if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
            entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
            entry.finalResponse.finishReason = 'error';
          });
          logStore.finalizeRequest(ctx.logId);
          // Release session and trigger deleteSession() — without this, the session
          // leaks in the pool and the chat persists on Qwen's servers indefinitely.
          cleanupImmediately(
            activeReader,
            heartbeatInterval,
            current.session.chatId,
            current.initialParentId,
            current.sessionHeaders,
            current.resolvedEmail,
            sessionPool,
            false,
          );
          streamReleased = true;
          return;
        }

        // ── Mid-stream pre-emission quota handoff (max 1 per request) ──
        // First chunk was healthy but quota_limit/RateLimited arrived in a later
        // chunk before anything was emitted. The client stream is still clean
        // (only the empty role prefix went out), so rotating to a fresh
        // account/session is safe. Post-emission failures never reach here.
        const retryable = getRetryablePreEmissionQuota({
          streamState,
          emittedToolCallCount: streamCtx.emittedToolCallCount,
          buffer: loopResult.buffer,
        });
        if (retryable && handoffsUsed < MAX_MIDSTREAM_QUOTA_HANDOFFS && ctx.acquireNextSession) {
          let next: AcquiredStreamingSession | null = null;
          try {
            next = await ctx.acquireNextSession(current.resolvedEmail);
          } catch {
            next = null;
          }
          if (next) {
            handoffsUsed++;
            if (retryable.code === 'RateLimited') {
              reportRateLimitWall(current.resolvedEmail, body.model, retryable.waitHours);
            }
            logStore.log(
              'warn',
              'chat',
              `[Chat] Mid-stream pre-emission ${retryable.code} on ${current.resolvedEmail} (${body.model}) — rotating account (${handoffsUsed}/${MAX_MIDSTREAM_QUOTA_HANDOFFS})`,
            );
            // Detach A without touching the client stream: cancel the consumed
            // reader, abort the dead upstream, release the session as failure.
            // Heartbeat and writer stay alive for B.
            try {
              reader.cancel();
            } catch {
              /* already consumed */
            }
            try {
              reader.releaseLock();
            } catch {
              /* already released */
            }
            try {
              current.qwenAbortController.abort();
            } catch {
              /* best-effort */
            }
            sessionPool.release(current.session.chatId, streamState.nextParentId, current.sessionHeaders, current.resolvedEmail, false);
            // A's upstream error must not poison B's outcome in monitor/store.
            logStore.updateEntry(logId, (entry: any) => {
              entry.errors = (entry.errors || []).filter((e: string) => !e.startsWith('Qwen upstream SSE error:'));
              if (entry.finalResponse) entry.finalResponse.finishReason = '';
            });
            current = {
              session: next.session,
              stream: next.stream,
              qwenAbortController: next.qwenAbortController,
              resolvedEmail: next.resolvedEmail,
              sessionHeaders: next.sessionHeaders,
              initialParentId: next.nextParentId,
              qwenLogFile: next.qwenLogFile,
            };
            activeReader = null;
            continue;
          }
          // No alternative eligible — fall through to the terminal error path.
        }

        await handlePostStreamCompletion(
          {
            streamWriter,
            completionId,
            model: body.model,
            streamState,
            ampState,
            logId,
            resolvedEmail: current.resolvedEmail,
            emittedToolCallCount: streamCtx.emittedToolCallCount,
            buffer: loopResult.buffer,
            enableContentFiltering,
            includeUsage: !!body.stream_options?.include_usage,
          },
          {
            reader,
            heartbeatInterval,
            chatId: current.session.chatId,
            sessionHeaders: current.sessionHeaders,
            email: current.resolvedEmail,
            sessionPool,
          },
        );

        streamReleased = true;
        logStore.log('debug', 'stream', `[Stream] <<< Streaming completed for ${logId} in ${Date.now() - _streamStartTime}ms`);
        return;
      }
    } finally {
      if (!streamReleased) {
        // Always write [DONE] so the SSE stream terminates cleanly, even on error
        try {
          await streamWriter.write('data: [DONE]\n\n');
        } catch {
          /* stream may already be closed */
        }
        logStore.updateEntry(logId, (entry) => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = entry.finalResponse.finishReason || 'error';
        });
        logStore.finalizeRequest(ctx.logId);
        cleanupImmediately(
          activeReader,
          heartbeatInterval,
          current.session.chatId,
          current.initialParentId,
          current.sessionHeaders,
          current.resolvedEmail,
          sessionPool,
          false,
        );
      }
    }
  });
}

function createHeartbeat(streamWriter: any): any {
  const hb = setInterval(async () => {
    try {
      await streamWriter.write(': keep-alive\n\n');
    } catch {
      clearInterval(hb);
    }
  }, 15000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  return hb;
}

function buildInitialStreamState(finalPrompt: string, initialParentId: string | null): StreamProcessingState {
  return {
    targetResponseId: null,
    nextParentId: initialParentId,
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    pendingChunk: '',
    hasEmittedContent: false,
    answerChunkCount: 0,
    nonEmptyAnswerCount: 0,
    reasoningChunkCount: 0,
  };
}
