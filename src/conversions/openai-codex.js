import { cleanObject, isValidValue } from '../utils.js';

export function convertOpenAIToCodexRequest(openaiRequest) {
  const codexRequest = {
    model: isValidValue(openaiRequest.model) ? openaiRequest.model : 'gpt-5.3-codex'
  };

  const normalizeTextContent = (content) => {
    if (!isValidValue(content)) return '';

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const chunks = [];
      for (const part of content) {
        if (!part) continue;
        if (typeof part === 'string') {
          chunks.push(part);
          continue;
        }
        if (typeof part.text === 'string') {
          chunks.push(part.text);
          continue;
        }
        if (part.type === 'text' && typeof part.content === 'string') {
          chunks.push(part.content);
        }
      }
      return chunks.join('');
    }

    if (typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }

    return '';
  };

  const instructions = [];
  const inputParts = [];

  if (Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      if (!msg || typeof msg !== 'object') continue;

      if (msg.role === 'system') {
        const systemText = normalizeTextContent(msg.content);
        if (systemText) instructions.push(systemText);
        continue;
      }

      if (msg.role === 'user' || msg.role === 'assistant') {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const text = normalizeTextContent(msg.content);
        if (text) {
          inputParts.push(`${role}: ${text}`);
        }

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const toolCall of msg.tool_calls) {
            const name = toolCall?.function?.name || 'unknown_tool';
            let args = '{}';
            if (typeof toolCall?.function?.arguments === 'string') {
              args = toolCall.function.arguments || '{}';
            } else if (toolCall?.function?.arguments && typeof toolCall.function.arguments === 'object') {
              args = JSON.stringify(toolCall.function.arguments);
            }
            inputParts.push(`Assistant called tool ${name} with arguments: ${args}`);
          }
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolOutput = normalizeTextContent(msg.content);
        const toolCallId = msg.tool_call_id || 'unknown_call';
        inputParts.push(`Tool ${toolCallId} result: ${toolOutput}`);
      }
    }
  }

  if (instructions.length > 0) {
    codexRequest.instructions = instructions.join('\n\n');
  }

  codexRequest.input = inputParts.join('\n\n');
  if (!codexRequest.input) {
    codexRequest.input = ' ';
  }

  if (Array.isArray(openaiRequest.tools)) {
    const mappedTools = [];
    for (const tool of openaiRequest.tools) {
      if (!tool || tool.type !== 'function' || !tool.function?.name) continue;
      const mapped = {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || { type: 'object', properties: {} }
      };
      if (typeof tool.function.strict === 'boolean') {
        mapped.strict = tool.function.strict;
      } else if (typeof tool.strict === 'boolean') {
        mapped.strict = tool.strict;
      }
      mappedTools.push(mapped);
    }
    if (mappedTools.length > 0) {
      codexRequest.tools = mappedTools;
    }
  }

  if (isValidValue(openaiRequest.tool_choice)) {
    if (typeof openaiRequest.tool_choice === 'string') {
      codexRequest.tool_choice = openaiRequest.tool_choice;
    } else if (typeof openaiRequest.tool_choice === 'object') {
      const toolName = openaiRequest.tool_choice?.function?.name || openaiRequest.tool_choice?.name;
      if (toolName) {
        codexRequest.tool_choice = {
          type: 'function',
          name: toolName
        };
      } else {
        codexRequest.tool_choice = openaiRequest.tool_choice;
      }
    }
  }

  if (typeof openaiRequest.parallel_tool_calls === 'boolean') {
    codexRequest.parallel_tool_calls = openaiRequest.parallel_tool_calls;
  }
  if (isValidValue(openaiRequest.max_tokens) && typeof openaiRequest.max_tokens === 'number') {
    codexRequest.max_output_tokens = openaiRequest.max_tokens;
  }
  if (isValidValue(openaiRequest.temperature) && typeof openaiRequest.temperature === 'number') {
    codexRequest.temperature = openaiRequest.temperature;
  }
  if (isValidValue(openaiRequest.top_p) && typeof openaiRequest.top_p === 'number') {
    codexRequest.top_p = openaiRequest.top_p;
  }
  if (isValidValue(openaiRequest.stream) && typeof openaiRequest.stream === 'boolean') {
    codexRequest.stream = openaiRequest.stream;
  } else {
    codexRequest.stream = false;
  }

  return cleanObject(codexRequest);
}

export function extractCodexOutputText(codexResponse) {
  if (!codexResponse) return '';

  if (typeof codexResponse.output === 'string') {
    return codexResponse.output;
  }

  if (typeof codexResponse.output_text === 'string') {
    return codexResponse.output_text;
  }

  if (Array.isArray(codexResponse.output)) {
    const chunks = [];

    for (const item of codexResponse.output) {
      if (!item) continue;

      if (typeof item === 'string') {
        chunks.push(item);
        continue;
      }

      if (typeof item.text === 'string') {
        chunks.push(item.text);
      }

      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (typeof part.text === 'string') {
            chunks.push(part.text);
          }
        }
      }
    }

    if (chunks.length > 0) {
      return chunks.join('');
    }
  }

  const choiceContent = codexResponse.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') {
    return choiceContent;
  }

  if (Array.isArray(choiceContent)) {
    return choiceContent.map(part => part?.text || '').join('');
  }

  return '';
}

export function extractCodexToolCalls(codexResponse) {
  const normalizedCalls = [];

  const choiceCalls = codexResponse?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(choiceCalls) && choiceCalls.length > 0) {
    for (const call of choiceCalls) {
      if (!call) continue;
      const name = call.function?.name;
      if (!name) continue;
      let args = call.function?.arguments;
      if (typeof args !== 'string') {
        args = JSON.stringify(args || {});
      }
      normalizedCalls.push({
        id: call.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name,
          arguments: args
        }
      });
    }
    if (normalizedCalls.length > 0) return normalizedCalls;
  }

  if (Array.isArray(codexResponse?.output)) {
    for (const item of codexResponse.output) {
      if (!item || item.type !== 'function_call' || !item.name) continue;
      let args = item.arguments;
      if (typeof args !== 'string') {
        args = JSON.stringify(args || {});
      }
      normalizedCalls.push({
        id: item.call_id || item.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: args
        }
      });
    }
  }

  return normalizedCalls;
}

export function convertCodexToOpenAI(codexResponse, model) {
  const usage = codexResponse?.usage || {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
  const toolCalls = extractCodexToolCalls(codexResponse);
  const hasToolCalls = toolCalls.length > 0;
  const textContent = extractCodexOutputText(codexResponse);
  const message = {
    role: 'assistant',
    content: textContent
  };

  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }

  return {
    id: codexResponse?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || codexResponse?.model || 'gpt-5.3-codex',
    choices: [{
      index: 0,
      message,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop'
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    }
  };
}

export async function parseCodexSSEToResponse(stream) {
  if (!stream) {
    throw new Error('Codex SSE stream body is empty');
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputText = '';
  let completedResponse = null;
  const outputItems = [];
  const outputItemIndexById = new Map();

  const ensureOutputItem = (itemId, fallback = {}) => {
    if (!itemId) return null;
    const existingIndex = outputItemIndexById.get(itemId);
    if (existingIndex !== undefined) {
      return outputItems[existingIndex];
    }

    const created = {
      id: itemId,
      type: 'function_call',
      arguments: '',
      ...fallback
    };
    outputItems.push(created);
    outputItemIndexById.set(itemId, outputItems.length - 1);
    return created;
  };

  const applyEventPayload = (eventType, rawPayload) => {
    if (!rawPayload || rawPayload === '[DONE]') return;

    try {
      const payload = JSON.parse(rawPayload);
      const type = payload.type || eventType;

      if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        outputText += payload.delta;
      } else if (type === 'response.output_text.done' && !outputText && typeof payload.text === 'string') {
        outputText = payload.text;
      } else if (type === 'response.output_item.added' && payload.item) {
        const item = payload.item;
        const normalized = {
          ...item,
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : (item.arguments ? JSON.stringify(item.arguments) : '')
        };

        outputItems.push(normalized);
        if (normalized.id) {
          outputItemIndexById.set(normalized.id, outputItems.length - 1);
        }
      } else if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
        const item = ensureOutputItem(payload.item_id, {
          name: payload.name || 'unknown_tool',
          call_id: payload.call_id || payload.item_id
        });
        if (item) {
          item.arguments = (typeof item.arguments === 'string' ? item.arguments : '') + payload.delta;
        }
      } else if (type === 'response.function_call_arguments.done') {
        const item = ensureOutputItem(payload.item_id, {
          name: payload.name || 'unknown_tool',
          call_id: payload.call_id || payload.item_id
        });
        if (item) {
          if (typeof payload.arguments === 'string') {
            item.arguments = payload.arguments;
          } else if (payload.arguments && typeof payload.arguments === 'object') {
            item.arguments = JSON.stringify(payload.arguments);
          }
        }
      } else if (type === 'response.output_item.done' && payload.item) {
        const item = payload.item;
        const target = ensureOutputItem(item.id, item);
        if (target) {
          Object.assign(target, item);
          if (target.arguments && typeof target.arguments !== 'string') {
            target.arguments = JSON.stringify(target.arguments);
          }
        }
      } else if (type === 'response.completed' && payload.response) {
        completedResponse = payload.response;
      }
    } catch (error) {
      // Ignore malformed events and keep consuming the stream.
    }
  };

  const processBuffer = (flush = false) => {
    const lines = buffer.split('\n');
    if (!flush) {
      buffer = lines.pop() || '';
    } else {
      buffer = '';
    }

    let eventType = '';
    let dataLines = [];

    const commitEvent = () => {
      if (dataLines.length === 0) return;
      applyEventPayload(eventType, dataLines.join('\n'));
      eventType = '';
      dataLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');

      if (line === '') {
        commitEvent();
        continue;
      }

      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (flush) {
      commitEvent();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processBuffer(false);
  }

  buffer += decoder.decode();
  processBuffer(true);

  if (!completedResponse) {
    throw new Error('Codex stream closed before response.completed');
  }

  const codexResponse = { ...completedResponse };
  if (!codexResponse.id) codexResponse.id = `resp-${Date.now()}`;
  if (!codexResponse.model) codexResponse.model = 'gpt-5.3-codex';
  if ((!Array.isArray(codexResponse.output) || codexResponse.output.length === 0) && outputItems.length > 0) {
    codexResponse.output = outputItems;
  }
  if (!extractCodexOutputText(codexResponse) && outputText) {
    codexResponse.output = outputText;
  }

  return codexResponse;
}

export function monitorCodexStreamFailure(stream, onStreamFailure) {
  if (!stream) return stream;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failureRecorded = false;
  let receivedCompletion = false;

  const recordFailure = async () => {
    if (failureRecorded) return;
    failureRecorded = true;
    await onStreamFailure();
  };

  const handlePayload = async (eventType, rawPayload) => {
    if (!rawPayload || rawPayload === '[DONE]') return;

    try {
      const payload = JSON.parse(rawPayload);
      const type = payload.type || eventType;
      if (type === 'response.completed') {
        receivedCompletion = true;
      } else if (type === 'response.failed' || type === 'error') {
        await recordFailure();
      }
    } catch (error) {
      // Malformed pass-through events should not break the client stream.
    }
  };

  const processBuffer = async (flush = false) => {
    const lines = buffer.split('\n');
    if (!flush) {
      buffer = lines.pop() || '';
    } else {
      buffer = '';
    }

    let eventType = '';
    let dataLines = [];

    const commitEvent = async () => {
      if (dataLines.length === 0) return;
      await handlePayload(eventType, dataLines.join('\n'));
      eventType = '';
      dataLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r')
        ? rawLine.slice(0, -1)
        : rawLine;

      if (line === '') {
        await commitEvent();
        continue;
      }

      if (line.startsWith(':')) continue;

      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (flush) {
      await commitEvent();
    }
  };

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            await processBuffer(true);

            if (!receivedCompletion) {
              await recordFailure();
            }

            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          controller.enqueue(value);
          await processBuffer(false);
        }
      } catch (error) {
        await recordFailure();
        controller.error(error);
      }
    },

    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}

export async function convertCodexStreamToOpenAI(codexStream, originalModel, options = {}) {
  if (!codexStream) {
    throw new Error('Codex stream body is empty');
  }

  const reader = codexStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let createdTs = Math.floor(Date.now() / 1000);
      let responseId = `chatcmpl-${Date.now()}`;
      let currentModel = originalModel || 'gpt-5.3-codex';
      let emittedRole = false;
      let emittedDone = false;
      let emittedTextDelta = false;
      let hasToolCalls = false;
      let nextToolCallIndex = 0;
      let receivedCompletion = false;
      const toolCallByItemId = new Map();
      const toolCallDeltaSent = new Set();

      const emitDone = () => {
        if (emittedDone) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        emittedDone = true;
      };

      const emitChunk = (delta, finishReason = null) => {
        const payload = {
          id: responseId,
          object: 'chat.completion.chunk',
          created: createdTs,
          model: currentModel,
          choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
          }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const recordStreamFailure = async () => {
        if (typeof options.onStreamFailure === 'function') {
          await options.onStreamFailure();
        }
      };

      const ensureRoleChunk = () => {
        if (emittedRole) return;
        emitChunk({ role: 'assistant' }, null);
        emittedRole = true;
      };

      const ensureToolCallMeta = (itemId, fallbackName = 'unknown_tool', fallbackCallId = null) => {
        if (!itemId) return null;
        if (toolCallByItemId.has(itemId)) {
          return toolCallByItemId.get(itemId);
        }

        const meta = {
          index: nextToolCallIndex++,
          id: fallbackCallId || itemId,
          name: fallbackName
        };
        toolCallByItemId.set(itemId, meta);
        return meta;
      };

      const handlePayload = async (eventType, rawPayload) => {
        if (!rawPayload || rawPayload === '[DONE]') {
          emitDone();
          return;
        }

        try {
          const payload = JSON.parse(rawPayload);
          const type = payload.type || eventType;

          if (type === 'response.created' && payload.response) {
            const created = payload.response.created;
            if (typeof created === 'number') {
              createdTs = created;
            }
            responseId = payload.response.id || responseId;
            currentModel = originalModel || payload.response.model || currentModel;
            ensureRoleChunk();
            return;
          }

          if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
            ensureRoleChunk();
            if (payload.delta) {
              emittedTextDelta = true;
              emitChunk({ content: payload.delta }, null);
            }
            return;
          }

          if (type === 'response.output_text.done' && typeof payload.text === 'string' && !emittedTextDelta) {
            ensureRoleChunk();
            if (payload.text) {
              emitChunk({ content: payload.text }, null);
            }
            return;
          }

          if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
            ensureRoleChunk();
            hasToolCalls = true;
            const item = payload.item;
            const meta = ensureToolCallMeta(item.id, item.name || 'unknown_tool', item.call_id || item.id);
            if (meta) {
              emitChunk({
                tool_calls: [{
                  index: meta.index,
                  id: meta.id,
                  type: 'function',
                  function: {
                    name: item.name || meta.name,
                    arguments: ''
                  }
                }]
              }, null);
            }
            return;
          }

          if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
            ensureRoleChunk();
            hasToolCalls = true;
            const meta = ensureToolCallMeta(payload.item_id, payload.name || 'unknown_tool', payload.call_id || payload.item_id);
            if (meta) {
              toolCallDeltaSent.add(payload.item_id);
              emitChunk({
                tool_calls: [{
                  index: meta.index,
                  function: {
                    arguments: payload.delta
                  }
                }]
              }, null);
            }
            return;
          }

          if (type === 'response.function_call_arguments.done' && typeof payload.arguments === 'string') {
            ensureRoleChunk();
            hasToolCalls = true;
            const meta = ensureToolCallMeta(payload.item_id, payload.name || 'unknown_tool', payload.call_id || payload.item_id);
            if (meta && !toolCallDeltaSent.has(payload.item_id) && payload.arguments) {
              emitChunk({
                tool_calls: [{
                  index: meta.index,
                  function: {
                    arguments: payload.arguments
                  }
                }]
              }, null);
            }
            return;
          }

          if (type === 'response.output_item.done' && payload.item?.type === 'function_call') {
            ensureRoleChunk();
            hasToolCalls = true;
            const item = payload.item;
            const meta = ensureToolCallMeta(item.id, item.name || 'unknown_tool', item.call_id || item.id);
            if (meta && !toolCallDeltaSent.has(item.id) && typeof item.arguments === 'string' && item.arguments) {
              emitChunk({
                tool_calls: [{
                  index: meta.index,
                  function: {
                    arguments: item.arguments
                  }
                }]
              }, null);
            }
            return;
          }

          if (type === 'response.completed') {
            receivedCompletion = true;
            ensureRoleChunk();
            if (!emittedTextDelta) {
              const finalText = extractCodexOutputText(payload.response || {});
              if (finalText) {
                emitChunk({ content: finalText }, null);
              }
            }
            emitChunk({}, hasToolCalls ? 'tool_calls' : 'stop');
            emitDone();
            return;
          }

          if (type === 'response.failed' || type === 'error') {
            const message = payload.error?.message || 'Codex stream failed';
            await recordStreamFailure();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              error: {
                message,
                type: payload.error?.type || 'api_error'
              }
            })}\n\n`));
            emitDone();
          }
        } catch (error) {
          console.error('Error parsing Codex stream event:', error, rawPayload);
        }
      };

      const processBuffer = async (flush = false) => {
        const lines = buffer.split('\n');
        if (!flush) {
          buffer = lines.pop() || '';
        } else {
          buffer = '';
        }

        let eventType = '';
        let dataLines = [];

        const commitEvent = async () => {
          if (dataLines.length === 0) return;
          await handlePayload(eventType, dataLines.join('\n'));
          eventType = '';
          dataLines = [];
        };

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r')
            ? rawLine.slice(0, -1)
            : rawLine;

          if (line === '') {
            await commitEvent();
            continue;
          }

          if (line.startsWith(':')) continue;

          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (flush) {
          await commitEvent();
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            await processBuffer(true);

            if (!receivedCompletion) {
              await recordStreamFailure();
              if (!emittedDone) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  error: {
                    message: 'Stream closed before response.completed',
                    type: 'api_error'
                  }
                })}\n\n`));
              }
            }

            emitDone();
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          await processBuffer(false);
        }
      } catch (error) {
        console.error('Codex->OpenAI stream conversion error:', error);
        await recordStreamFailure();
        if (!emittedDone) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            error: {
              message: error.message || 'Stream conversion failed',
              type: 'api_error'
            }
          })}\n\n`));
          emitDone();
        }
        controller.close();
      }
    }
  });
}

export async function convertCodexResponseToOpenAIResponse(response, originalModel, isStreamRequest, options = {}) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (isStreamRequest) {
    if (contentType.includes('text/event-stream')) {
      const openaiStream = await convertCodexStreamToOpenAI(response.body, originalModel, options);
      return new Response(openaiStream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    const codexJson = await response.json();
    return new Response(JSON.stringify(convertCodexToOpenAI(codexJson, originalModel)), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const codexResponse = contentType.includes('text/event-stream')
    ? await parseCodexSSEToResponse(response.body)
    : await response.json();

  return new Response(JSON.stringify(convertCodexToOpenAI(codexResponse, originalModel)), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'Content-Type': 'application/json' }
  });
}
