/**
 * Cloudflare Worker - Claude API Smart Router
 *
 * 智能路由，在多个 Claude API 端点之间自动切换
 * - 按价格从低到高排序（droid = aws < ultra < super < claude）
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
  '/claude/droid',    // 最便宜
  '/claude/aws',
  '/claude/ultra',
  '/claude/super',
  '/claude'           // 最贵
];

// 端点价格层级（droid = aws < ultra < super < claude）
const ENDPOINT_TIERS = {
  '/claude/droid': 0,
  '/claude/aws': 0,
  '/claude/ultra': 1,
  '/claude/super': 2,
  '/claude': 3
};

// 通过 ANTHROPIC_CUSTOM_HEADERS 注入此 header 可允许向更高等级端点降级
const ALLOW_HIGHER_TIER_FALLBACK_HEADER = 'x-ccr-tier';

const CODEX_BASE_PATH = '/codex/v1';
const ROUTE_TYPES = {
  CLAUDE: 'claude',
  CODEX: 'codex'
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
    model: isValidValue(openaiRequest.model) ? openaiRequest.model : 'claude-3-5-sonnet-20241022',
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
                      model: originalModel || claudeEvent.message.model || 'claude-3-5-sonnet-20241022',
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
                        model: originalModel || 'claude-3-5-sonnet-20241022',
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
                        model: originalModel || 'claude-3-5-sonnet-20241022',
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
                        model: originalModel || 'claude-3-5-sonnet-20241022',
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
                        model: originalModel || 'claude-3-5-sonnet-20241022',
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
    model: model || 'claude-3-5-sonnet-20241022',
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
function getOpenAIModelsResponse() {
  const models = [
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-5-20251101'
  ];

  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'anthropic'
    }))
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

  // 没有匹配到特定端点，使用默认路由
  return {
    routeType: ROUTE_TYPES.CLAUDE,
    preferredEndpoint: null,
    apiPath: pathname,
    isOpenAI: false,
    isModels: false
  };
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
    model: 'claude-sonnet-4-5',  // 覆盖为 Claude Code 模型
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
function convertClaudeToCodexRequest(claudeRequest) {
  const codexRequest = {
    model: 'gpt-5.3-codex'  // 覆盖为 Codex 模型
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
  if (claudeRequest.max_tokens) codexRequest.max_tokens = claudeRequest.max_tokens;
  if (claudeRequest.temperature) codexRequest.temperature = claudeRequest.temperature;
  if (claudeRequest.stream !== undefined) codexRequest.stream = claudeRequest.stream;

  return codexRequest;
}

/**
 * 转换 Codex Responses API 响应为 Claude Messages API 格式
 */
function convertCodexResponseToClaude(codexResponse) {
  return {
    id: codexResponse.id || `msg-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: codexResponse.output || codexResponse.choices?.[0]?.message?.content || ''
    }],
    model: codexResponse.model,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: codexResponse.usage?.prompt_tokens || 0,
      output_tokens: codexResponse.usage?.completion_tokens || 0
    }
  };
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
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Content-Type', 'application/json');

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
          const codexResponse = await response.json();
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
        } catch (error) {
          // 继续尝试下一个源
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

      // Codex 透传逻辑：单端点主备源切换 + 4xx/5xx 重试
      if (routeType === ROUTE_TYPES.CODEX) {
        const manager = new EndpointHealthManager();

        // 检查是否强制使用 Claude（用于测试）
        const forceClaude = request.headers.get('x-force-claude') === 'true';

        if (forceClaude) {
          // 强制使用 Claude 作为备用
          const claudeResult = await tryClaudeAsFallback(request, manager);

          if (claudeResult.success) {
            const claudeHeaders = new Headers(claudeResult.response.headers);
            applyCorsHeaders(claudeHeaders);
            claudeHeaders.set('X-Route-Type', 'claude-fallback');
            claudeHeaders.set('X-Used-Endpoint', ENDPOINTS[claudeResult.endpointIndex]);
            claudeHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[claudeResult.baseUrlIndex]);
            claudeHeaders.set('X-Fallback-Reason', 'forced-by-header');

            return new Response(claudeResult.response.body, {
              status: claudeResult.response.status,
              statusText: claudeResult.response.statusText,
              headers: claudeHeaders
            });
          }
        }

        const codexResult = await tryCodexSources(request, manager, apiPath);

        if (!codexResult.success) {
          // Codex 全挂，尝试 Claude 作为备用
          const claudeResult = await tryClaudeAsFallback(request, manager);

          if (claudeResult.success) {
            const claudeHeaders = new Headers(claudeResult.response.headers);
            applyCorsHeaders(claudeHeaders);
            claudeHeaders.set('X-Route-Type', 'claude-fallback');
            claudeHeaders.set('X-Used-Endpoint', ENDPOINTS[claudeResult.endpointIndex]);
            claudeHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[claudeResult.baseUrlIndex]);
            claudeHeaders.set('X-Fallback-Reason', 'all-codex-sources-failed');

            return new Response(claudeResult.response.body, {
              status: claudeResult.response.status,
              statusText: claudeResult.response.statusText,
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

        const codexHeaders = new Headers(codexResult.response.headers);
        applyCorsHeaders(codexHeaders);
        codexHeaders.set('X-Route-Type', ROUTE_TYPES.CODEX);
        codexHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
        codexHeaders.set('X-Base-URL-Index', codexResult.baseUrlIndex.toString());

        return new Response(codexResult.response.body, {
          status: codexResult.response.status,
          statusText: codexResult.response.statusText,
          headers: codexHeaders
        });
      }

      // 如果是 OpenAI models 接口，直接返回模型列表
      if (isModels) {
        return new Response(JSON.stringify(getOpenAIModelsResponse()), {
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
