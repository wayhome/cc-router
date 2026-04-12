/**
 * Cloudflare Worker - Claude API Smart Router
 *
 * 智能路由，在多个 Claude API 端点之间自动切换
 * - 按价格从低到高排序（ultra < super < claude）
 * - 使用全局内存缓存记录端点健康状态（同一实例内共享）
 * - 自动故障转移，优先使用最便宜的可用端点
 * - 失败的端点会被临时标记，一段时间后重新尝试
 * - 支持指定端点路由，优先使用对应的实际端点
 * - 支持 OpenAI Completions API 格式兼容
 * - 双源互备：主源 (newcli) 和备源 (dm-fox) 相互备份，单个源失败时自动切换
 * - 支持 Codex 路由透传（/codex/v1），单端点主备源重试
 * - Claude 全挂时自动切换到 Codex 作为最终备用
 */

// 主源和备源配置
const TARGET_BASE_URLS = [
  'https://code.newcli.com',  // 主源
  'https://dm-fox.rjj.cc'     // 备源
];

// 可用的端点列表（按价格从低到高排序）
const ENDPOINTS = [
  '/claude/ultra',    // 最便宜（droid/aws 已暂时下线）
  '/claude/super',
  '/claude'           // 最贵
];

// 已下线的旧端点，保留路径兼容（不再作为候选端点）
const DISABLED_ENDPOINTS = [
  '/claude/droid',
  '/claude/aws'
];

// 端点价格层级（ultra < super < claude）
const ENDPOINT_TIERS = {
  '/claude/ultra': 0,
  '/claude/super': 1,
  '/claude': 2
};

// 通过 ANTHROPIC_CUSTOM_HEADERS 注入此 header 可允许向更高等级端点降级
const ALLOW_HIGHER_TIER_FALLBACK_HEADER = 'x-ccr-tier';

const CODEX_BASE_PATH = '/codex/v1';
const ROUTE_TYPES = {
  CLAUDE: 'claude',
  CODEX: 'codex'
};

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const SUPPORTED_CLAUDE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
];
const SUPPORTED_CODEX_MODELS = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5-codex'
];
const CODEX_MODEL_METADATA = {
  'gpt-5.4': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-5.3-codex': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-5-codex': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  }
};

// 全局健康状态缓存（跨请求共享，同一 Worker 实例内所有请求共享）
const globalHealthCache = new Map();

// 端点健康检查配置
const HEALTH_CHECK_CONFIG = {
  // 失败后的冷却时间（秒）
  COOLDOWN_TIME: 60,  // 1分钟
  // 连续失败多少次后进入冷却
  MAX_FAILURES: 3
};

/**
 * 端点健康状态管理类
 * 使用全局内存缓存存储健康状态（同一 Worker 实例内共享）
 * 为每个"端点+源"组合单独追踪健康状态
 */
class EndpointHealthManager {
  constructor() {
    // 不再需要构造参数，直接使用全局缓存
  }

  /**
   * 生成健康状态的唯一键
   * @param {string} routeType - 路由类型（claude/codex）
   * @param {number} endpointIndex - 端点索引
   * @param {number} baseUrlIndex - 基础 URL 索引
   */
  getHealthKey(routeType, endpointIndex, baseUrlIndex) {
    return `${routeType}-${endpointIndex}-${baseUrlIndex}`;
  }

  /**
   * 获取端点健康状态
   */
  async getHealth(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const key = this.getHealthKey(routeType, endpointIndex, baseUrlIndex);
    const health = globalHealthCache.get(key);

    if (!health) {
      return { failures: 0, lastFailTime: 0, inCooldown: false };
    }

    return health;
  }

  /**
   * 保存端点健康状态
   */
  async saveHealth(endpointIndex, baseUrlIndex, health, routeType = ROUTE_TYPES.CLAUDE) {
    const key = this.getHealthKey(routeType, endpointIndex, baseUrlIndex);
    globalHealthCache.set(key, health);
  }

  /**
   * 检查端点是否可用
   */
  async isAvailable(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);
    const now = Date.now();

    // 如果在冷却期，检查是否已过冷却时间
    if (health.inCooldown) {
      if (now - health.lastFailTime >= HEALTH_CHECK_CONFIG.COOLDOWN_TIME * 1000) {
        // 冷却期结束，允许使用（等成功时再重置状态）
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * 记录端点失败
   */
  async recordFailure(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);
    health.failures++;
    health.lastFailTime = Date.now();

    // 如果连续失败次数达到阈值，进入冷却期
    if (health.failures >= HEALTH_CHECK_CONFIG.MAX_FAILURES) {
      health.inCooldown = true;
    }

    await this.saveHealth(endpointIndex, baseUrlIndex, health, routeType);
  }

  /**
   * 记录端点成功
   */
  async recordSuccess(endpointIndex, baseUrlIndex, routeType = ROUTE_TYPES.CLAUDE) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex, routeType);

    // 只有在端点之前有失败记录或在冷却期时才需要重置
    if (health.failures > 0 || health.inCooldown) {
      await this.saveHealth(endpointIndex, baseUrlIndex, {
        failures: 0,
        lastFailTime: 0,
        inCooldown: false
      }, routeType);
    }
    // 如果端点一直健康，不需要写入缓存
  }
}

/**
 * 检查值是否有效（不是 undefined、null 或字符串 "[undefined]"）
 */
function isValidValue(value) {
  if (value === undefined || value === null || value === '[undefined]' || value === 'undefined') {
    return false;
  }
  // 如果是对象或数组，检查是否为空或只包含无效值
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    // 对于普通对象，检查是否有有效的属性
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * 清理对象中的无效值
 */
function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isValidValue(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * 转换 OpenAI Chat Completions 请求格式为 Claude Messages API 格式
 */
function convertOpenAIToClaude(openaiRequest) {
  const claudeRequest = {
    model: isValidValue(openaiRequest.model) ? openaiRequest.model : DEFAULT_CLAUDE_MODEL,
    max_tokens: isValidValue(openaiRequest.max_tokens) ? openaiRequest.max_tokens : 4096,
    messages: []
  };

  // 转换消息格式
  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      if (msg.role === 'system') {
        // Claude 的 system 消息单独处理
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
        // 处理 assistant 的 tool_calls
        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolUseContent = msg.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
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
        // 转换 tool 消息为 tool_result
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

  // 转换 tools 为 Claude 格式
  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    claudeRequest.tools = openaiRequest.tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    }));
  }

  // 可选参数转换 - 只添加有效的参数
  if (isValidValue(openaiRequest.temperature) && typeof openaiRequest.temperature === 'number') {
    claudeRequest.temperature = openaiRequest.temperature;
  }
  if (isValidValue(openaiRequest.top_p) && typeof openaiRequest.top_p === 'number') {
    claudeRequest.top_p = openaiRequest.top_p;
  }
  // Stream 参数：如果提供则使用，否则默认为 false
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

  // 清理请求对象，移除任何可能残留的无效值
  return cleanObject(claudeRequest);
}

/**
 * 转换 OpenAI Chat Completions 请求为 Codex Responses 请求
 */
function convertOpenAIToCodexRequest(openaiRequest) {
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

/**
 * 转换 Claude SSE 流为 OpenAI SSE 流
 */
async function convertClaudeStreamToOpenAI(claudeStream, originalModel) {
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
                    // 消息结束，发送 [DONE]
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    continue;

                  case 'ping':
                    // 心跳事件，跳过
                    continue;

                  case 'error':
                    // 错误事件
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
              } catch (e) {
                console.error('Error parsing SSE data:', e, data);
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

/**
 * 转换 Claude SSE 流为 Codex Responses SSE 流
 */
async function convertClaudeStreamToCodex(claudeStream, originalModel) {
  const reader = claudeStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let responseId = `resp-${Date.now()}`;
      let outputText = '';
      let createdSent = false;
      let completedSent = false;

      const buildBaseResponse = (status = 'in_progress') => ({
        id: responseId,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: originalModel || 'gpt-5.3-codex',
        status
      });

      const emitEvent = (eventType, payload) => {
        controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify({
          type: eventType,
          ...payload
        })}\n\n`));
      };

      const emitCreated = () => {
        if (createdSent) return;
        emitEvent('response.created', {
          response: buildBaseResponse('in_progress')
        });
        createdSent = true;
      };

      const emitCompleted = () => {
        if (completedSent) return;
        emitCreated();
        emitEvent('response.output_text.done', {
          response_id: responseId,
          output_index: 0,
          content_index: 0,
          text: outputText
        });
        emitEvent('response.completed', {
          response: {
            ...buildBaseResponse('completed'),
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'output_text',
                text: outputText
              }]
            }]
          }
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        completedSent = true;
      };

      const emitFailed = (message, errorType = 'api_error') => {
        if (completedSent) return;
        emitCreated();
        emitEvent('response.failed', {
          response: buildBaseResponse('failed'),
          error: {
            type: errorType,
            message
          }
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        completedSent = true;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            emitCompleted();
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || line.startsWith(':') || line.startsWith('event:')) continue;
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6);
            if (data === '[DONE]') {
              emitCompleted();
              continue;
            }

            try {
              const claudeEvent = JSON.parse(data);

              switch (claudeEvent.type) {
                case 'message_start':
                  if (claudeEvent.message?.id) {
                    responseId = claudeEvent.message.id;
                  }
                  emitCreated();
                  break;

                case 'content_block_delta':
                  if (claudeEvent.delta?.type === 'text_delta') {
                    emitCreated();
                    const delta = claudeEvent.delta.text || '';
                    if (delta.length > 0) {
                      outputText += delta;
                      emitEvent('response.output_text.delta', {
                        response_id: responseId,
                        output_index: 0,
                        content_index: 0,
                        delta
                      });
                    }
                  }
                  break;

                case 'message_stop':
                  emitCompleted();
                  break;

                case 'error':
                  emitFailed(
                    claudeEvent.error?.message || 'Claude fallback stream error',
                    claudeEvent.error?.type || 'api_error'
                  );
                  break;

                case 'ping':
                case 'content_block_start':
                case 'content_block_stop':
                case 'message_delta':
                  break;

                default:
                  break;
              }
            } catch (error) {
              console.error('Error parsing Claude stream event:', error, data);
            }
          }
        }
      } catch (error) {
        console.error('Codex stream conversion error:', error);
        emitFailed(error.message || 'Codex stream conversion error');
        controller.close();
      }
    }
  });
}

/**
 * 转换 Claude Messages API 响应格式为 OpenAI Chat Completions 格式
 */
function convertClaudeToOpenAI(claudeResponse, model) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];

  // 处理 content 数组
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

/**
 * 生成 OpenAI 模型列表响应
 */
function getOpenAIModelsResponse(models, ownedBy, metadataMap = {}) {
  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: ownedBy,
      ...(metadataMap[id] || {})
    }))
  };
}

function getOpenAIModelResponse(id, ownedBy, metadataMap = {}) {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy,
    ...(metadataMap[id] || {})
  };
}

/**
 * 解析请求路径，提取端点信息
 * 返回 { routeType: string, preferredEndpoint: string|null, apiPath: string, isOpenAI: boolean, isModels: boolean }
 */
function parseRequestPath(url) {
  const pathname = new URL(url).pathname;

  // Codex 路由优先，避免被 OpenAI 兼容分支误匹配
  if (pathname === CODEX_BASE_PATH || pathname.startsWith(`${CODEX_BASE_PATH}/`)) {
    return {
      routeType: ROUTE_TYPES.CODEX,
      preferredEndpoint: null,
      apiPath: pathname,
      isOpenAI: false,
      isModels: false
    };
  }

  // 检查是否是 OpenAI Models 路径
  if (pathname === '/v1/models' || pathname.endsWith('/v1/models')) {
    return {
      routeType: ROUTE_TYPES.CLAUDE,
      preferredEndpoint: null,
      apiPath: '/v1/models',
      isOpenAI: true,
      isModels: true
    };
  }

  // 检查是否是 OpenAI Chat Completions 路径
  if (pathname === '/v1/chat/completions' || pathname.endsWith('/v1/chat/completions')) {
    // 检查是否指定了端点
    for (const endpoint of ENDPOINTS) {
      if (pathname.startsWith(endpoint + '/')) {
        return {
          routeType: ROUTE_TYPES.CLAUDE,
          preferredEndpoint: endpoint,
          apiPath: '/v1/messages',
          isOpenAI: true,
          isModels: false
        };
      }
    }
    return {
      routeType: ROUTE_TYPES.CLAUDE,
      preferredEndpoint: null,
      apiPath: '/v1/messages',
      isOpenAI: true,
      isModels: false
    };
  }

  // 检查是否匹配端点路径
  for (const endpoint of ENDPOINTS) {
    if (pathname.startsWith(endpoint + '/') || pathname === endpoint) {
      // 提取端点后的 API 路径
      const apiPath = pathname.slice(endpoint.length) || '/';
      return {
        routeType: ROUTE_TYPES.CLAUDE,
        preferredEndpoint: endpoint,
        apiPath,
        isOpenAI: false,
        isModels: false
      };
    }
  }

  // 兼容已下线路径：/claude/droid/*、/claude/aws/* -> 走默认端点池
  for (const endpoint of DISABLED_ENDPOINTS) {
    if (pathname.startsWith(endpoint + '/') || pathname === endpoint) {
      const apiPath = pathname.slice(endpoint.length) || '/';
      return {
        routeType: ROUTE_TYPES.CLAUDE,
        preferredEndpoint: null,
        apiPath,
        isOpenAI: false,
        isModels: false
      };
    }
  }

  // 没有匹配到特定端点，使用默认路由
  return {
    routeType: ROUTE_TYPES.CLAUDE,
    preferredEndpoint: null,
    apiPath: pathname,
    isOpenAI: false,
    isModels: false
  };
}

function isCodexChatCompletionsPath(pathname) {
  return pathname === `${CODEX_BASE_PATH}/chat/completions` ||
         pathname === `${CODEX_BASE_PATH}/chat/completions/`;
}

function isCodexModelsPath(pathname) {
  return pathname === `${CODEX_BASE_PATH}/models` ||
         pathname === `${CODEX_BASE_PATH}/models/`;
}

function getCodexModelIdFromPath(pathname) {
  const prefix = `${CODEX_BASE_PATH}/models/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).trim();
  if (!raw) return null;
  return decodeURIComponent(raw);
}

/**
 * 代理请求到指定端点
 * @param {Request} request - 原始请求
 * @param {number} baseUrlIndex - 基础 URL 索引
 * @param {string} endpointPath - 端点路径
 * @param {string} apiPath - API 路径
 */
async function proxyRequest(request, baseUrlIndex, endpointPath, apiPath) {
  const url = new URL(request.url);
  const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}${endpointPath}${apiPath}${url.search}`;

  const headers = new Headers(request.headers);

  // 设置浏览器 User-Agent 避免被拦截
  if (!headers.has('user-agent') || headers.get('user-agent').includes('curl')) {
    headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.13 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36');
  }

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow'
  });

  return await fetch(proxyRequest);
}

/**
 * 代理请求到完整路径（用于 Codex 透传）
 * @param {Request} request - 原始请求
 * @param {number} baseUrlIndex - 基础 URL 索引
 * @param {string} path - 完整路径（例如 /codex/v1/responses）
 */
async function proxyDirectRequest(request, baseUrlIndex, path) {
  const url = new URL(request.url);
  const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}${path}${url.search}`;

  const headers = new Headers(request.headers);

  // 设置浏览器 User-Agent 避免被拦截
  if (!headers.has('user-agent') || headers.get('user-agent').includes('curl')) {
    headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.13 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36');
  }

  const proxiedRequest = new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'follow'
  });

  return await fetch(proxiedRequest);
}

/**
 * 尝试所有端点，直到成功或全部失败
 * 如果指定了 preferredEndpoint，优先使用该端点，失败后按顺序尝试
 * 默认不会自动升级到更高价格层级（可通过自定义 header 开启）
 * 对于每个端点，会先尝试主源，失败后尝试备源，两个源都失败才切换到下一个端点
 */
async function tryEndpoints(request, manager, apiPath, preferredEndpoint = null, allowHigherTierFallback = false) {
  const requestBody = await request.clone().arrayBuffer();
  const requestHeaders = new Headers(request.headers);  // 保存请求头
  const triedEndpoints = new Set();  // 记录已尝试的端点（不含源信息）
  const candidateEndpointIndices = buildEndpointAttemptOrder(preferredEndpoint, allowHigherTierFallback);

  if (candidateEndpointIndices.length === 0) {
    return { response: null, endpointIndex: -1, baseUrlIndex: -1, success: false };
  }

  // 按优先级顺序尝试所有候选端点
  for (let attempt = 0; attempt < candidateEndpointIndices.length; attempt++) {
    let currentIndex = -1;

    // 按候选顺序查找下一个可用端点（至少一个源可用）
    for (const endpointIndex of candidateEndpointIndices) {
      if (triedEndpoints.has(endpointIndex)) continue;

      // 检查该端点是否至少有一个源可用
      let hasAvailableSource = false;
      for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
        if (await manager.isAvailable(endpointIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE)) {
          hasAvailableSource = true;
          break;
        }
      }

      if (hasAvailableSource) {
        currentIndex = endpointIndex;
        break;
      }
    }

    // 如果都在冷却期，仍然尝试未试过的候选端点
    if (currentIndex === -1) {
      for (const endpointIndex of candidateEndpointIndices) {
        if (!triedEndpoints.has(endpointIndex)) {
          currentIndex = endpointIndex;
          break;
        }
      }
    }

    if (currentIndex === -1) break;

    triedEndpoints.add(currentIndex);
    const endpoint = ENDPOINTS[currentIndex];

    // 对于当前端点，依次尝试所有源（主源 -> 备源）
    for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
      try {
        // 重新创建请求（因为 body 只能读取一次）
        const clonedRequest = new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: requestBody.byteLength > 0 ? requestBody : null
        });

        const response = await proxyRequest(clonedRequest, baseUrlIndex, endpoint, apiPath);

        // 如果响应成功（2xx 或 3xx），记录成功并返回
        if (response.status < 400) {
          await manager.recordSuccess(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
          return {
            response,
            endpointIndex: currentIndex,
            baseUrlIndex,
            success: true
          };
        }

        // 如果是 4xx 或 5xx 错误，记录失败并尝试下一个源
        await manager.recordFailure(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
      } catch (error) {
        await manager.recordFailure(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
      }
    }

    // 所有源都失败了，继续尝试下一个端点
  }

  // 所有端点的所有源都失败了
  return { response: null, endpointIndex: -1, baseUrlIndex: -1, success: false };
}

/**
 * 转换 Codex Responses API 请求为 Claude Messages API 格式
 */
function convertCodexToClaude(codexRequest) {
  const claudeRequest = {
    model: DEFAULT_CLAUDE_MODEL,  // 覆盖为可用 Claude 模型
    max_tokens: codexRequest.max_tokens || 4096,
    messages: []
  };

  // 解析 input 为 messages
  if (codexRequest.input) {
    const input = codexRequest.input;
    const lines = input.split('\n\n');

    for (const line of lines) {
      if (line.startsWith('User: ')) {
        claudeRequest.messages.push({
          role: 'user',
          content: line.slice(6)
        });
      } else if (line.startsWith('Assistant: ')) {
        claudeRequest.messages.push({
          role: 'assistant',
          content: line.slice(11)
        });
      } else if (claudeRequest.messages.length === 0) {
        // 第一行作为 system 或 user
        claudeRequest.messages.push({
          role: 'user',
          content: line
        });
      }
    }
  }

  if (codexRequest.instructions) {
    claudeRequest.system = codexRequest.instructions;
  }

  if (codexRequest.temperature !== undefined) claudeRequest.temperature = codexRequest.temperature;
  if (codexRequest.stream !== undefined) claudeRequest.stream = codexRequest.stream;

  return claudeRequest;
}

/**
 * 转换 Claude Messages API 请求为 Codex Responses API 格式
 */
function convertClaudeToCodexRequest(claudeRequest, modelOverride) {
  const requestedModel = typeof modelOverride === 'string' && modelOverride.trim()
    ? modelOverride.trim()
    : null;
  const codexRequest = {
    model: requestedModel || 'gpt-5.3-codex'  // 默认覆盖为 Codex 模型
  };

  let inputParts = [];
  if (claudeRequest.system) inputParts.push(claudeRequest.system);

  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = typeof msg.content === 'string' ? msg.content :
                     (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
      inputParts.push(`${role}: ${content}`);
    }
  }

  codexRequest.input = inputParts.join('\n\n');
  if (claudeRequest.max_tokens !== undefined) codexRequest.max_output_tokens = claudeRequest.max_tokens;
  if (claudeRequest.temperature !== undefined) codexRequest.temperature = claudeRequest.temperature;
  if (claudeRequest.stream !== undefined) codexRequest.stream = claudeRequest.stream;

  return codexRequest;
}

function extractCodexOutputText(codexResponse) {
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

function extractCodexToolCalls(codexResponse) {
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

/**
 * 转换 Codex Responses API 响应为 Claude Messages API 格式
 */
function convertCodexResponseToClaude(codexResponse) {
  const usage = codexResponse.usage || {};

  return {
    id: codexResponse.id || `msg-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: extractCodexOutputText(codexResponse)
    }],
    model: codexResponse.model,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0
    }
  };
}

/**
 * 转换 Codex Responses API 响应为 OpenAI Chat Completions 格式
 */
function convertCodexToOpenAI(codexResponse, model) {
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

async function parseCodexSSEToResponse(stream) {
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
      // 忽略无法解析的事件，继续处理后续事件
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

  const codexResponse = completedResponse ? { ...completedResponse } : {};
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

/**
 * 转换 Codex Responses SSE 流为 OpenAI Chat Completions SSE 流
 */
async function convertCodexStreamToOpenAI(codexStream, originalModel) {
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
      let outputText = '';
      let hasToolCalls = false;
      let nextToolCallIndex = 0;
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

      const handlePayload = (eventType, rawPayload) => {
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
              outputText += payload.delta;
              emittedTextDelta = true;
              emitChunk({ content: payload.delta }, null);
            }
            return;
          }

          if (type === 'response.output_text.done' && typeof payload.text === 'string' && !emittedTextDelta) {
            ensureRoleChunk();
            if (payload.text) {
              outputText = payload.text;
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
            ensureRoleChunk();
            if (!emittedTextDelta) {
              const finalText = extractCodexOutputText(payload.response || {});
              if (finalText) {
                outputText = finalText;
                emitChunk({ content: finalText }, null);
              }
            }
            emitChunk({}, hasToolCalls ? 'tool_calls' : 'stop');
            emitDone();
            return;
          }

          if (type === 'response.failed' || type === 'error') {
            const message = payload.error?.message || 'Codex stream failed';
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
          handlePayload(eventType, dataLines.join('\n'));
          eventType = '';
          dataLines = [];
        };

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r')
            ? rawLine.slice(0, -1)
            : rawLine;

          if (line === '') {
            commitEvent();
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
          commitEvent();
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            processBuffer(true);
            emitDone();
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          processBuffer(false);
        }
      } catch (error) {
        console.error('Codex->OpenAI stream conversion error:', error);
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

/**
 * 将 Codex 响应（JSON/SSE）转换为 OpenAI Chat Completions 响应
 */
async function convertCodexResponseToOpenAIResponse(response, originalModel, isStreamRequest) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (isStreamRequest) {
    if (contentType.includes('text/event-stream')) {
      const openaiStream = await convertCodexStreamToOpenAI(response.body, originalModel);
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

/**
 * 转换 Claude Messages API 响应为 Codex Responses API 格式
 */
function convertClaudeResponseToCodex(claudeResponse) {
  const content = Array.isArray(claudeResponse.content)
    ? claudeResponse.content.map(c => c.text || '').join('')
    : claudeResponse.content;

  return {
    id: claudeResponse.id || `resp-${Date.now()}`,
    object: 'response',
    model: claudeResponse.model,
    output: content,
    usage: {
      prompt_tokens: claudeResponse.usage?.input_tokens || 0,
      completion_tokens: claudeResponse.usage?.output_tokens || 0,
      total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
    }
  };
}

/**
 * 尝试 Codex 主备源作为 Claude 的备用
 */
async function tryCodexAsFallback(request, manager) {
  try {
    const claudeBody = await request.clone().json();
    const codexBody = convertClaudeToCodexRequest(claudeBody);
    if (codexBody.stream === undefined) {
      // Claude 非流式请求默认转为 Codex 非流式，避免上游返回 SSE 导致 JSON 解析失败。
      codexBody.stream = false;
    }
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Content-Type', 'application/json');
    requestHeaders.set('Accept', 'application/json');

    for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
      try {
        const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}/codex/v1/responses`;
        const codexRequest = new Request(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(codexBody)
        });

        const response = await fetch(codexRequest);
        if (response.status < 400) {
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          const codexResponse = contentType.includes('text/event-stream')
            ? await parseCodexSSEToResponse(response.body)
            : await response.json();
          const claudeResponse = convertCodexResponseToClaude(codexResponse);

          return {
            response: new Response(JSON.stringify(claudeResponse), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }),
            baseUrlIndex,
            success: true
          };
        } else {
          console.error(`Codex fallback failed for source ${baseUrlIndex}: ${response.status}`);
        }
      } catch (error) {
        console.error(`Codex fallback error for source ${baseUrlIndex}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Codex fallback error:', error);
  }

  return { response: null, baseUrlIndex: -1, success: false };
}

/**
 * 尝试 Claude 端点作为 Codex 的备用
 */
async function tryClaudeAsFallback(request, manager) {
  try {
    const codexBody = await request.clone().json();
    const claudeBody = convertCodexToClaude(codexBody);
    const isStreamRequest = codexBody.stream === true;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Content-Type', 'application/json');

    for (let endpointIndex = 0; endpointIndex < ENDPOINTS.length; endpointIndex++) {
      for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
        try {
          const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}${ENDPOINTS[endpointIndex]}/v1/messages`;
          const claudeRequest = new Request(targetUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(claudeBody)
          });

          const response = await fetch(claudeRequest);
          if (response.status < 400) {
            if (isStreamRequest) {
              const claudeStream = response.body;
              if (!claudeStream) {
                throw new Error('Claude fallback stream body is empty');
              }
              const codexStream = await convertClaudeStreamToCodex(claudeStream, codexBody.model);

              return {
                response: new Response(codexStream, {
                  status: 200,
                  headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                  }
                }),
                endpointIndex,
                baseUrlIndex,
                success: true
              };
            }

            const claudeResponse = await response.json();
            const codexResponse = convertClaudeResponseToCodex(claudeResponse);

            return {
              response: new Response(JSON.stringify(codexResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }),
              endpointIndex,
              baseUrlIndex,
              success: true
            };
          }
          console.error(`Claude fallback failed for endpoint ${endpointIndex}, source ${baseUrlIndex}: ${response.status}`);
        } catch (error) {
          console.error(`Claude fallback error for endpoint ${endpointIndex}, source ${baseUrlIndex}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Claude fallback error:', error);
  }

  return { response: null, endpointIndex: -1, baseUrlIndex: -1, success: false };
}

/**
 * 尝试 Codex 主备源（单端点）
 * 对 4xx/5xx 也会重试到备源，保持请求/响应透传兼容
 */
async function tryCodexSources(request, manager, codexPath) {
  const requestBody = await request.clone().arrayBuffer();
  const requestHeaders = new Headers(request.headers);
  const triedSources = new Set();
  let lastResponse = null;
  let lastBaseUrlIndex = -1;

  for (let attempt = 0; attempt < TARGET_BASE_URLS.length; attempt++) {
    let currentBaseUrlIndex = -1;

    // 优先选择健康可用的源
    for (let i = 0; i < TARGET_BASE_URLS.length; i++) {
      if (triedSources.has(i)) continue;
      if (await manager.isAvailable(0, i, ROUTE_TYPES.CODEX)) {
        currentBaseUrlIndex = i;
        break;
      }
    }

    // 如果都在冷却期，仍然尝试未试过的源
    if (currentBaseUrlIndex === -1) {
      for (let i = 0; i < TARGET_BASE_URLS.length; i++) {
        if (!triedSources.has(i)) {
          currentBaseUrlIndex = i;
          break;
        }
      }
    }

    if (currentBaseUrlIndex === -1) {
      break;
    }

    triedSources.add(currentBaseUrlIndex);
    lastBaseUrlIndex = currentBaseUrlIndex;

    try {
      const clonedRequest = new Request(request.url, {
        method: request.method,
        headers: requestHeaders,
        body: requestBody.byteLength > 0 ? requestBody : null
      });

      const response = await proxyDirectRequest(clonedRequest, currentBaseUrlIndex, codexPath);
      if (response.status < 400) {
        await manager.recordSuccess(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
        return {
          response,
          baseUrlIndex: currentBaseUrlIndex,
          success: true
        };
      }

      lastResponse = response;
      await manager.recordFailure(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
    } catch (error) {
      await manager.recordFailure(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
    }
  }

  return {
    response: lastResponse,
    baseUrlIndex: lastBaseUrlIndex,
    success: false
  };
}

function applyCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
}

function getEndpointTier(endpoint) {
  if (Object.prototype.hasOwnProperty.call(ENDPOINT_TIERS, endpoint)) {
    return ENDPOINT_TIERS[endpoint];
  }
  return Number.MAX_SAFE_INTEGER;
}

function parseBooleanHeader(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseCustomHeaderLines(rawValue) {
  if (!rawValue) return new Map();

  const normalized = String(rawValue).replace(/\\n/g, '\n');
  const lines = normalized.split(/\r?\n/);
  const parsed = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!key) continue;

    parsed.set(key, value);
  }

  return parsed;
}

function shouldAllowHigherTierFallback(headers) {
  const explicit = headers.get(ALLOW_HIGHER_TIER_FALLBACK_HEADER);
  if (explicit !== null) {
    return parseBooleanHeader(explicit);
  }

  // 兼容客户端传递 anthropic-custom-headers 字符串:
  // "Header1: value1\nHeader2: value2"
  const customHeadersRaw = headers.get('anthropic-custom-headers');
  if (!customHeadersRaw) return false;

  const customHeaders = parseCustomHeaderLines(customHeadersRaw);
  if (customHeaders.has(ALLOW_HIGHER_TIER_FALLBACK_HEADER)) {
    return parseBooleanHeader(customHeaders.get(ALLOW_HIGHER_TIER_FALLBACK_HEADER));
  }

  return false;
}

function buildEndpointAttemptOrder(preferredEndpoint, allowHigherTierFallback) {
  let startIndex = 0;
  if (preferredEndpoint) {
    const preferredIndex = ENDPOINTS.indexOf(preferredEndpoint);
    if (preferredIndex !== -1) {
      startIndex = preferredIndex;
    }
  }

  const preferredTier = getEndpointTier(preferredEndpoint || ENDPOINTS[startIndex]);
  const maxAllowedTier = allowHigherTierFallback ? Number.POSITIVE_INFINITY : preferredTier;

  const orderedIndices = [];
  for (let i = startIndex; i < ENDPOINTS.length; i++) {
    orderedIndices.push(i);
  }
  for (let i = 0; i < startIndex; i++) {
    orderedIndices.push(i);
  }

  return orderedIndices.filter(index => getEndpointTier(ENDPOINTS[index]) <= maxAllowedTier);
}

export default {
  async fetch(request, env, ctx) {
    try {
      // 处理 OPTIONS 预检请求
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400'
          }
        });
      }

      // 解析请求路径，提取优先端点、API 路径和是否为 OpenAI 格式
      const { routeType, preferredEndpoint, apiPath, isOpenAI, isModels } = parseRequestPath(request.url);

      // 检查是否强制使用 Codex（用于测试）
      const forceCodex = request.headers.get('x-force-codex') === 'true';

      // Codex 路由：默认透传；对 /codex/v1/chat/completions 执行 OpenAI<->Codex 格式转换
      if (routeType === ROUTE_TYPES.CODEX) {
        const codexModelId = getCodexModelIdFromPath(apiPath);
        if (codexModelId) {
          if (!SUPPORTED_CODEX_MODELS.includes(codexModelId)) {
            return new Response(JSON.stringify({
              error: {
                message: `Model '${codexModelId}' not found`,
                type: 'invalid_request_error'
              }
            }), {
              status: 404,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Route-Type': ROUTE_TYPES.CODEX
              }
            });
          }

          return new Response(JSON.stringify(
            getOpenAIModelResponse(codexModelId, 'openai', CODEX_MODEL_METADATA)
          ), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'X-Route-Type': ROUTE_TYPES.CODEX
            }
          });
        }

        if (isCodexModelsPath(apiPath)) {
          return new Response(JSON.stringify(
            getOpenAIModelsResponse(SUPPORTED_CODEX_MODELS, 'openai', CODEX_MODEL_METADATA)
          ), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'X-Route-Type': ROUTE_TYPES.CODEX
            }
          });
        }

        const manager = new EndpointHealthManager();
        const isCodexOpenAIChat = isCodexChatCompletionsPath(apiPath);
        let processedCodexRequest = request;
        let codexTargetPath = apiPath;
        let codexOriginalModel = null;
        let codexStreamRequest = false;

        if (isCodexOpenAIChat) {
          if (request.method !== 'POST') {
            return new Response(JSON.stringify({
              error: {
                message: 'Method not allowed for chat completions on codex route',
                type: 'invalid_request_error'
              }
            }), {
              status: 405,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          try {
            const openaiBody = await request.clone().json();
            codexOriginalModel = openaiBody.model;

            const codexBody = convertOpenAIToCodexRequest(openaiBody);
            codexStreamRequest = codexBody.stream === true;

            const newHeaders = new Headers(request.headers);
            newHeaders.delete('Content-Length');
            newHeaders.set('Content-Type', 'application/json');
            newHeaders.set('Accept', codexStreamRequest ? 'text/event-stream' : 'application/json');

            processedCodexRequest = new Request(request.url, {
              method: request.method,
              headers: newHeaders,
              body: JSON.stringify(codexBody)
            });
            codexTargetPath = `${CODEX_BASE_PATH}/responses`;
          } catch (error) {
            return new Response(JSON.stringify({
              error: {
                message: `Invalid request body: ${error.message}`,
                type: 'invalid_request_error'
              }
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }

        const convertCodexSuccessIfNeeded = async (upstreamResponse) => {
          if (!isCodexOpenAIChat) {
            return upstreamResponse;
          }

          try {
            return await convertCodexResponseToOpenAIResponse(
              upstreamResponse,
              codexOriginalModel,
              codexStreamRequest
            );
          } catch (error) {
            console.error('Failed to convert codex response to OpenAI format:', error.message, error.stack);
            return new Response(JSON.stringify({
              error: {
                message: `Failed to convert codex response: ${error.message}`,
                type: 'api_error'
              }
            }), {
              status: 502,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        };

        // 检查是否强制使用 Claude（用于测试）
        const forceClaude = request.headers.get('x-force-claude') === 'true';

        if (forceClaude) {
          // 强制使用 Claude 作为备用
          const claudeResult = await tryClaudeAsFallback(processedCodexRequest, manager);

          if (claudeResult.success) {
            const convertedResponse = await convertCodexSuccessIfNeeded(claudeResult.response);
            const claudeHeaders = new Headers(convertedResponse.headers);
            applyCorsHeaders(claudeHeaders);
            claudeHeaders.set('X-Route-Type', 'claude-fallback');
            claudeHeaders.set('X-Used-Endpoint', ENDPOINTS[claudeResult.endpointIndex]);
            claudeHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[claudeResult.baseUrlIndex]);
            claudeHeaders.set('X-Fallback-Reason', 'forced-by-header');
            if (isCodexOpenAIChat) {
              claudeHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
            }

            return new Response(convertedResponse.body, {
              status: convertedResponse.status,
              statusText: convertedResponse.statusText,
              headers: claudeHeaders
            });
          }
        }

        const codexResult = await tryCodexSources(processedCodexRequest, manager, codexTargetPath);

        if (!codexResult.success) {
          // Codex 全挂，尝试 Claude 作为备用
          const claudeResult = await tryClaudeAsFallback(processedCodexRequest, manager);

          if (claudeResult.success) {
            const convertedResponse = await convertCodexSuccessIfNeeded(claudeResult.response);
            const claudeHeaders = new Headers(convertedResponse.headers);
            applyCorsHeaders(claudeHeaders);
            claudeHeaders.set('X-Route-Type', 'claude-fallback');
            claudeHeaders.set('X-Used-Endpoint', ENDPOINTS[claudeResult.endpointIndex]);
            claudeHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[claudeResult.baseUrlIndex]);
            claudeHeaders.set('X-Fallback-Reason', 'all-codex-sources-failed');
            if (isCodexOpenAIChat) {
              claudeHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
            }

            return new Response(convertedResponse.body, {
              status: convertedResponse.status,
              statusText: convertedResponse.statusText,
              headers: claudeHeaders
            });
          }

          // 若上游已返回错误响应，则优先透传该错误体，保证 Codex 兼容
          if (codexResult.response) {
            const failHeaders = new Headers(codexResult.response.headers);
            applyCorsHeaders(failHeaders);
            failHeaders.set('X-Route-Type', ROUTE_TYPES.CODEX);
            if (codexResult.baseUrlIndex >= 0) {
              failHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
              failHeaders.set('X-Base-URL-Index', codexResult.baseUrlIndex.toString());
            }
            if (isCodexOpenAIChat) {
              failHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
            }

            return new Response(codexResult.response.body, {
              status: codexResult.response.status,
              statusText: codexResult.response.statusText,
              headers: failHeaders
            });
          }

          return new Response(JSON.stringify({
            error: {
              message: 'All codex sources failed',
              type: 'api_error'
            }
          }), {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const finalResponse = await convertCodexSuccessIfNeeded(codexResult.response);
        const codexHeaders = new Headers(finalResponse.headers);
        applyCorsHeaders(codexHeaders);
        codexHeaders.set('X-Route-Type', ROUTE_TYPES.CODEX);
        codexHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
        codexHeaders.set('X-Base-URL-Index', codexResult.baseUrlIndex.toString());
        if (isCodexOpenAIChat) {
          codexHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
        }

        return new Response(finalResponse.body, {
          status: finalResponse.status,
          statusText: finalResponse.statusText,
          headers: codexHeaders
        });
      }

      // 如果是 OpenAI models 接口，直接返回模型列表
      if (isModels) {
        return new Response(JSON.stringify(
          getOpenAIModelsResponse(SUPPORTED_CLAUDE_MODELS, 'anthropic')
        ), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // 如果是 OpenAI 格式，需要转换请求体
      let processedRequest = request;
      let originalModel = null;

      if (isOpenAI && request.method === 'POST') {
        try {
          const openaiBody = await request.json();

          originalModel = openaiBody.model;
          const claudeBody = convertOpenAIToClaude(openaiBody);

          // 创建新的请求对象，使用转换后的 Claude 格式
          // 注意：需要移除 Content-Length 头，让浏览器/fetch 自动计算新的长度
          // 并且必须显式设置 Content-Type 为 application/json
          const newHeaders = new Headers(request.headers);
          newHeaders.delete('Content-Length');
          newHeaders.set('Content-Type', 'application/json');

          // 确保 anthropic-version 头存在（Claude API 要求）
          if (!newHeaders.has('anthropic-version')) {
            newHeaders.set('anthropic-version', '2023-06-01');
          }

          // 如果请求看起来像机器人（OpenAI Python SDK），修改 User-Agent 并添加必要的头部
          // 伪装成 CherryStudio 客户端以通过反机器人检测
          const userAgent = newHeaders.get('user-agent') || '';
          if (userAgent.includes('OpenAI') || userAgent.includes('Python') || userAgent.includes('curl')) {
            // 使用与成功请求相同的 User-Agent
            newHeaders.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.13 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36');

            // 添加 anthropic-beta 头
            if (!newHeaders.has('anthropic-beta')) {
              newHeaders.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
            }

            // 清理机器人相关的头部
            const botHeaders = ['x-stainless-arch', 'x-stainless-async', 'x-stainless-lang',
                               'x-stainless-os', 'x-stainless-package-version', 'x-stainless-read-timeout',
                               'x-stainless-retry-count', 'x-stainless-runtime', 'x-stainless-runtime-version'];
            botHeaders.forEach(header => newHeaders.delete(header));
          }

          processedRequest = new Request(request.url, {
            method: request.method,
            headers: newHeaders,
            body: JSON.stringify(claudeBody)
          });
        } catch (error) {
          console.error('Error converting OpenAI request:', error.message, error.stack);
          return new Response(JSON.stringify({
            error: {
              message: `Invalid request body: ${error.message}`,
              type: 'invalid_request_error'
            }
          }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }

      // 创建健康管理器
      const manager = new EndpointHealthManager();

      // 如果强制使用 Codex（用于测试）
      if (forceCodex) {
        const codexResult = await tryCodexAsFallback(processedRequest, manager);

        if (codexResult.success) {
          const codexHeaders = new Headers(codexResult.response.headers);
          applyCorsHeaders(codexHeaders);
          codexHeaders.set('X-Route-Type', 'codex-fallback');
          codexHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
          codexHeaders.set('X-Fallback-Reason', 'forced-by-header');

          return new Response(codexResult.response.body, {
            status: codexResult.response.status,
            statusText: codexResult.response.statusText,
            headers: codexHeaders
          });
        }
      }

      // 默认不升级到更高价格层级；可通过自定义 header 开启
      const allowHigherTierFallback = shouldAllowHigherTierFallback(processedRequest.headers);

      // 尝试所有端点（如果指定了优先端点，先尝试它）
      const result = await tryEndpoints(
        processedRequest,
        manager,
        apiPath,
        preferredEndpoint,
        allowHigherTierFallback
      );

      if (!result.success) {
        // Claude 全挂，尝试 Codex 作为最终备用
        const codexResult = await tryCodexAsFallback(processedRequest, manager);

        if (codexResult.success) {
          const codexHeaders = new Headers(codexResult.response.headers);
          applyCorsHeaders(codexHeaders);
          codexHeaders.set('X-Route-Type', 'codex-fallback');
          codexHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
          codexHeaders.set('X-Fallback-Reason', 'all-claude-endpoints-failed');

          return new Response(codexResult.response.body, {
            status: codexResult.response.status,
            statusText: codexResult.response.statusText,
            headers: codexHeaders
          });
        }

        const errorBody = isOpenAI
          ? JSON.stringify({
              error: {
                message: 'All endpoints failed',
                type: 'api_error'
              }
            })
          : 'All endpoints failed';

        return new Response(errorBody, {
          status: 503,
          headers: {
            'Content-Type': isOpenAI ? 'application/json' : 'text/plain',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // 如果是 OpenAI 格式，需要转换响应
      let responseBody = result.response.body;
      let responseStatus = result.response.status;
      let contentType = result.response.headers.get('content-type');

      // 先保存响应头，因为读取 body 后可能无法再访问
      const responseHeaders = new Headers(result.response.headers);

      // 处理流式响应和非流式响应
      if (isOpenAI && responseStatus === 200) {
        if (contentType?.includes('text/event-stream')) {
          // 流式响应：转换 Claude SSE 为 OpenAI SSE
          try {
            responseBody = await convertClaudeStreamToOpenAI(result.response.body, originalModel);
          } catch (error) {
            console.error('Failed to convert Claude stream to OpenAI format:', error.message, error.stack);
            // 如果转换失败，返回原始流
          }
        } else {
          // 非流式响应：转换 JSON 格式
          try {
            const claudeResponse = await result.response.json();
            const openaiResponse = convertClaudeToOpenAI(claudeResponse, originalModel);
            responseBody = JSON.stringify(openaiResponse);
          } catch (error) {
            console.error('Failed to convert Claude response to OpenAI format:', error.message, error.stack);
            // 如果转换失败，返回原始响应
          }
        }
      }

      // 添加 CORS 头
      applyCorsHeaders(responseHeaders);

      // 添加调试信息头
      responseHeaders.set('X-Route-Type', ROUTE_TYPES.CLAUDE);
      responseHeaders.set('X-Used-Endpoint', ENDPOINTS[result.endpointIndex]);
      responseHeaders.set('X-Endpoint-Index', result.endpointIndex.toString());
      responseHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[result.baseUrlIndex]);
      responseHeaders.set('X-Base-URL-Index', result.baseUrlIndex.toString());
      responseHeaders.set('X-Allow-Higher-Tier-Fallback', allowHigherTierFallback ? 'true' : 'false');
      if (preferredEndpoint) {
        responseHeaders.set('X-Preferred-Endpoint', preferredEndpoint);
      }
      if (isOpenAI) {
        responseHeaders.set('X-Format-Conversion', 'OpenAI');
      }

      return new Response(responseBody, {
        status: responseStatus,
        statusText: result.response.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      // 全局错误捕获
      console.error('Unexpected error in worker:', error.message, error.stack);

      return new Response(JSON.stringify({
        error: {
          message: `Internal server error: ${error.message}`,
          type: 'internal_error'
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
