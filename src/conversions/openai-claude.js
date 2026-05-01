import { DEFAULT_CLAUDE_MODEL } from '../config.js';
import { cleanObject, isValidValue } from '../utils.js';

export function convertOpenAIToClaude(openaiRequest) {
  const claudeRequest = {
    model: isValidValue(openaiRequest.model) ? openaiRequest.model : DEFAULT_CLAUDE_MODEL,
    max_tokens: isValidValue(openaiRequest.max_tokens) ? openaiRequest.max_tokens : 4096,
    messages: []
  };

  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      if (msg.role === 'system') {
        if (isValidValue(msg.content)) {
          claudeRequest.system = msg.content;
        }
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        if (isValidValue(msg.content)) {
          claudeRequest.messages.push({
            role: msg.role,
            content: msg.content
          });
        }

        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolUseContent = msg.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments
          }));
          if (claudeRequest.messages.length > 0) {
            const lastMsg = claudeRequest.messages[claudeRequest.messages.length - 1];
            if (Array.isArray(lastMsg.content)) {
              lastMsg.content.push(...toolUseContent);
            } else {
              lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...toolUseContent];
            }
          }
        }
      } else if (msg.role === 'tool') {
        claudeRequest.messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }]
        });
      }
    }
  }

  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    claudeRequest.tools = openaiRequest.tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    }));
  }

  if (isValidValue(openaiRequest.temperature) && typeof openaiRequest.temperature === 'number') {
    claudeRequest.temperature = openaiRequest.temperature;
  }
  if (isValidValue(openaiRequest.top_p) && typeof openaiRequest.top_p === 'number') {
    claudeRequest.top_p = openaiRequest.top_p;
  }
  if (isValidValue(openaiRequest.stream) && typeof openaiRequest.stream === 'boolean') {
    claudeRequest.stream = openaiRequest.stream;
  } else {
    claudeRequest.stream = false;
  }
  if (isValidValue(openaiRequest.stop)) {
    if (Array.isArray(openaiRequest.stop)) {
      const validStops = openaiRequest.stop.filter(s => isValidValue(s));
      if (validStops.length > 0) {
        claudeRequest.stop_sequences = validStops;
      }
    } else if (typeof openaiRequest.stop === 'string') {
      claudeRequest.stop_sequences = [openaiRequest.stop];
    }
  }

  return cleanObject(claudeRequest);
}

export async function convertClaudeStreamToOpenAI(claudeStream, originalModel) {
  const reader = claudeStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let toolCallIndex = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || line.startsWith(':')) continue;

            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (data === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              try {
                const claudeEvent = JSON.parse(data);
                let openaiEvent = null;

                switch (claudeEvent.type) {
                  case 'message_start':
                    openaiEvent = {
                      id: claudeEvent.message.id || `chatcmpl-${Date.now()}`,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: originalModel || claudeEvent.message.model || DEFAULT_CLAUDE_MODEL,
                      choices: [{
                        index: 0,
                        delta: { role: 'assistant', content: '' },
                        finish_reason: null
                      }]
                    };
                    break;

                  case 'content_block_start':
                    if (claudeEvent.content_block?.type === 'tool_use') {
                      openaiEvent = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: originalModel || DEFAULT_CLAUDE_MODEL,
                        choices: [{
                          index: 0,
                          delta: {
                            tool_calls: [{
                              index: toolCallIndex++,
                              id: claudeEvent.content_block.id,
                              type: 'function',
                              function: { name: claudeEvent.content_block.name, arguments: '' }
                            }]
                          },
                          finish_reason: null
                        }]
                      };
                    } else {
                      continue;
                    }
                    break;

                  case 'content_block_delta':
                    if (claudeEvent.delta?.type === 'text_delta') {
                      openaiEvent = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: originalModel || DEFAULT_CLAUDE_MODEL,
                        choices: [{
                          index: 0,
                          delta: { content: claudeEvent.delta.text },
                          finish_reason: null
                        }]
                      };
                    } else if (claudeEvent.delta?.type === 'input_json_delta') {
                      openaiEvent = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: originalModel || DEFAULT_CLAUDE_MODEL,
                        choices: [{
                          index: 0,
                          delta: {
                            tool_calls: [{
                              index: toolCallIndex - 1,
                              function: { arguments: claudeEvent.delta.partial_json }
                            }]
                          },
                          finish_reason: null
                        }]
                      };
                    }
                    break;

                  case 'content_block_stop':
                    continue;

                  case 'message_delta':
                    if (claudeEvent.delta?.stop_reason) {
                      const finishReason = claudeEvent.delta.stop_reason === 'end_turn' ? 'stop' :
                                         claudeEvent.delta.stop_reason === 'max_tokens' ? 'length' :
                                         claudeEvent.delta.stop_reason === 'tool_use' ? 'tool_calls' :
                                         claudeEvent.delta.stop_reason;
                      openaiEvent = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: originalModel || DEFAULT_CLAUDE_MODEL,
                        choices: [{
                          index: 0,
                          delta: {},
                          finish_reason: finishReason
                        }]
                      };
                    }
                    break;

                  case 'message_stop':
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    continue;

                  case 'ping':
                    continue;

                  case 'error':
                    openaiEvent = {
                      error: {
                        message: claudeEvent.error?.message || 'Unknown error',
                        type: claudeEvent.error?.type || 'api_error'
                      }
                    };
                    break;

                  default:
                    console.log('Unknown Claude event type:', claudeEvent.type);
                    continue;
                }

                if (openaiEvent) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiEvent)}\n\n`));
                }
              } catch (error) {
                console.error('Error parsing SSE data:', error, data);
              }
            }
          }
        }
      } catch (error) {
        console.error('Stream conversion error:', error);
        controller.error(error);
      }
    }
  });
}

export function convertClaudeToOpenAI(claudeResponse, model) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];

  if (claudeResponse.content && Array.isArray(claudeResponse.content)) {
    for (const block of claudeResponse.content) {
      if (block.type === 'text') {
        message.content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      }
    }
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: claudeResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_CLAUDE_MODEL,
    choices: [
      {
        index: 0,
        message,
        finish_reason: claudeResponse.stop_reason === 'end_turn' ? 'stop' :
                      claudeResponse.stop_reason === 'max_tokens' ? 'length' :
                      claudeResponse.stop_reason === 'tool_use' ? 'tool_calls' :
                      claudeResponse.stop_reason || 'stop'
      }
    ],
    usage: {
      prompt_tokens: claudeResponse.usage?.input_tokens || 0,
      completion_tokens: claudeResponse.usage?.output_tokens || 0,
      total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
    }
  };
}
