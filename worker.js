/**
 * Cloudflare Worker - Claude API Smart Router
 *
 * 智能路由，在多个 Claude API 端点之间自动切换
 * - 按价格从低到高排序（aws < droid < ultra < claude）
 * - 使用全局内存缓存记录端点健康状态（同一实例内共享）
 * - 自动故障转移，优先使用最便宜的可用端点
 * - 失败的端点会被临时标记，一段时间后重新尝试
 * - 支持指定端点路由，优先使用对应的实际端点
 * - 支持 OpenAI Completions API 格式兼容
 * - 双源互备：主源 (newcli) 和备源 (dm-fox) 相互备份，单个源失败时自动切换
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
  '/claude/super',    // 次贵
  '/claude'           // 最贵
];

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
   * @param {number} endpointIndex - 端点索引
   * @param {number} baseUrlIndex - 基础 URL 索引
   */
  getHealthKey(endpointIndex, baseUrlIndex) {
    return `${endpointIndex}-${baseUrlIndex}`;
  }

  /**
   * 获取端点健康状态
   */
  async getHealth(endpointIndex, baseUrlIndex) {
    const key = this.getHealthKey(endpointIndex, baseUrlIndex);
    const health = globalHealthCache.get(key);

    if (!health) {
      return { failures: 0, lastFailTime: 0, inCooldown: false };
    }

    return health;
  }

  /**
   * 保存端点健康状态
   */
  async saveHealth(endpointIndex, baseUrlIndex, health) {
    const key = this.getHealthKey(endpointIndex, baseUrlIndex);
    globalHealthCache.set(key, health);
  }

  /**
   * 检查端点是否可用
   */
  async isAvailable(endpointIndex, baseUrlIndex) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex);
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
  async recordFailure(endpointIndex, baseUrlIndex) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex);
    health.failures++;
    health.lastFailTime = Date.now();

    // 如果连续失败次数达到阈值，进入冷却期
    if (health.failures >= HEALTH_CHECK_CONFIG.MAX_FAILURES) {
      health.inCooldown = true;
    }

    await this.saveHealth(endpointIndex, baseUrlIndex, health);
  }

  /**
   * 记录端点成功
   */
  async recordSuccess(endpointIndex, baseUrlIndex) {
    const health = await this.getHealth(endpointIndex, baseUrlIndex);

    // 只有在端点之前有失败记录或在冷却期时才需要重置
    if (health.failures > 0 || health.inCooldown) {
      await this.saveHealth(endpointIndex, baseUrlIndex, {
        failures: 0,
        lastFailTime: 0,
        inCooldown: false
      });
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
      }
    }
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

                // 转换不同类型的 Claude 事件为 OpenAI 格式
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
                    // OpenAI 在第一个 chunk 中已经包含了 role，这里跳过
                    continue;

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
                    }
                    break;

                  case 'content_block_stop':
                    // 内容块结束，不需要发送事件
                    continue;

                  case 'message_delta':
                    // 处理 stop_reason
                    if (claudeEvent.delta?.stop_reason) {
                      const finishReason = claudeEvent.delta.stop_reason === 'end_turn' ? 'stop' :
                                         claudeEvent.delta.stop_reason === 'max_tokens' ? 'length' :
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
  return {
    id: claudeResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'claude-3-5-sonnet-20241022',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: claudeResponse.content?.[0]?.text || ''
        },
        finish_reason: claudeResponse.stop_reason === 'end_turn' ? 'stop' :
                      claudeResponse.stop_reason === 'max_tokens' ? 'length' :
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
 * 返回 { preferredEndpoint: string|null, apiPath: string, isOpenAI: boolean, isModels: boolean }
 */
function parseRequestPath(url) {
  const pathname = new URL(url).pathname;

  // 检查是否是 OpenAI Models 路径
  if (pathname === '/v1/models' || pathname.endsWith('/v1/models')) {
    return {
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
          preferredEndpoint: endpoint,
          apiPath: '/v1/messages',
          isOpenAI: true,
          isModels: false
        };
      }
    }
    return {
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
      return { preferredEndpoint: endpoint, apiPath, isOpenAI: false, isModels: false };
    }
  }

  // 没有匹配到特定端点，使用默认路由
  return { preferredEndpoint: null, apiPath: pathname, isOpenAI: false, isModels: false };
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

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow'
  });

  return await fetch(proxyRequest);
}

/**
 * 尝试所有端点，直到成功或全部失败
 * 如果指定了 preferredEndpoint，优先使用该端点，失败后从该位置往后尝试
 * 否则按价格从低到高尝试
 * 对于每个端点，会先尝试主源，失败后尝试备源，两个源都失败才切换到下一个端点
 */
async function tryEndpoints(request, manager, apiPath, preferredEndpoint = null) {
  const requestBody = await request.clone().arrayBuffer();
  const requestHeaders = new Headers(request.headers);  // 保存请求头
  const triedEndpoints = new Set();  // 记录已尝试的端点（不含源信息）

  // 如果指定了优先端点，确定起始位置
  let startIndex = 0;
  if (preferredEndpoint) {
    const preferredIndex = ENDPOINTS.indexOf(preferredEndpoint);
    if (preferredIndex !== -1) {
      startIndex = preferredIndex;
    }
  }

  // 按优先级顺序尝试所有端点
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    let currentIndex = -1;

    // 从起始位置开始，按顺序查找下一个可用端点（至少一个源可用）
    for (let i = startIndex; i < ENDPOINTS.length; i++) {
      if (triedEndpoints.has(i)) continue;

      // 检查该端点是否至少有一个源可用
      let hasAvailableSource = false;
      for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
        if (await manager.isAvailable(i, baseUrlIndex)) {
          hasAvailableSource = true;
          break;
        }
      }

      if (hasAvailableSource) {
        currentIndex = i;
        break;
      }
    }

    // 如果从起始位置往后没找到，尝试起始位置之前的端点
    if (currentIndex === -1 && startIndex > 0) {
      for (let i = 0; i < startIndex; i++) {
        if (triedEndpoints.has(i)) continue;

        let hasAvailableSource = false;
        for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
          if (await manager.isAvailable(i, baseUrlIndex)) {
            hasAvailableSource = true;
            break;
          }
        }

        if (hasAvailableSource) {
          currentIndex = i;
          break;
        }
      }
    }

    // 如果还是没有可用端点，尝试任何未尝试的端点（包括冷却期的）
    if (currentIndex === -1) {
      for (let i = startIndex; i < ENDPOINTS.length; i++) {
        if (!triedEndpoints.has(i)) {
          currentIndex = i;
          break;
        }
      }
      if (currentIndex === -1 && startIndex > 0) {
        for (let i = 0; i < startIndex; i++) {
          if (!triedEndpoints.has(i)) {
            currentIndex = i;
            break;
          }
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
          await manager.recordSuccess(currentIndex, baseUrlIndex);
          return {
            response,
            endpointIndex: currentIndex,
            baseUrlIndex,
            success: true
          };
        }

        // 如果是 4xx 或 5xx 错误，记录失败并尝试下一个源
        await manager.recordFailure(currentIndex, baseUrlIndex);
      } catch (error) {
        await manager.recordFailure(currentIndex, baseUrlIndex);
      }
    }

    // 所有源都失败了，继续尝试下一个端点
  }

  // 所有端点的所有源都失败了
  return { response: null, endpointIndex: -1, baseUrlIndex: -1, success: false };
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
      const { preferredEndpoint, apiPath, isOpenAI, isModels } = parseRequestPath(request.url);

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

      // 尝试所有端点（如果指定了优先端点，先尝试它）
      const result = await tryEndpoints(processedRequest, manager, apiPath, preferredEndpoint);

      if (!result.success) {
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
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');

      // 添加调试信息头
      responseHeaders.set('X-Used-Endpoint', ENDPOINTS[result.endpointIndex]);
      responseHeaders.set('X-Endpoint-Index', result.endpointIndex.toString());
      responseHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[result.baseUrlIndex]);
      responseHeaders.set('X-Base-URL-Index', result.baseUrlIndex.toString());
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
