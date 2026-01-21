/**
 * Cloudflare Worker - Claude API Smart Router
 *
 * 智能路由，在多个 Claude API 端点之间自动切换
 * - 按价格从低到高排序（aws < droid < ultra < claude）
 * - 使用全局内存缓存记录端点健康状态（同一实例内共享）
 * - 自动故障转移，优先使用最便宜的可用端点
 * - 失败的端点会被临时标记，一段时间后重新尝试
 */

const TARGET_BASE_URL = 'https://code.newcli.com';

// 可用的端点列表（按价格从低到高排序）
const ENDPOINTS = [
  '/claude/aws',      // 最便宜
  '/claude/droid',
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
 */
class EndpointHealthManager {
  constructor() {
    // 不再需要构造参数，直接使用全局缓存
  }

  /**
   * 获取端点健康状态
   */
  async getHealth(index) {
    const health = globalHealthCache.get(index);

    if (!health) {
      return { failures: 0, lastFailTime: 0, inCooldown: false };
    }

    return health;
  }

  /**
   * 保存端点健康状态
   */
  async saveHealth(index, health) {
    globalHealthCache.set(index, health);
  }

  /**
   * 检查端点是否可用
   */
  async isAvailable(index) {
    const health = await this.getHealth(index);
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
  async recordFailure(index) {
    const health = await this.getHealth(index);
    health.failures++;
    health.lastFailTime = Date.now();

    // 如果连续失败次数达到阈值，进入冷却期
    if (health.failures >= HEALTH_CHECK_CONFIG.MAX_FAILURES) {
      health.inCooldown = true;
      console.log(`Endpoint ${ENDPOINTS[index]} entered cooldown period`);
    }

    await this.saveHealth(index, health);
  }

  /**
   * 记录端点成功
   */
  async recordSuccess(index) {
    const health = await this.getHealth(index);

    // 只有在端点之前有失败记录或在冷却期时才需要重置
    if (health.failures > 0 || health.inCooldown) {
      await this.saveHealth(index, {
        failures: 0,
        lastFailTime: 0,
        inCooldown: false
      });
    }
    // 如果端点一直健康，不需要写入缓存
  }
}

/**
 * 代理请求到指定端点
 */
async function proxyRequest(request, endpointPath) {
  const url = new URL(request.url);
  const targetUrl = `${TARGET_BASE_URL}${endpointPath}${url.pathname}${url.search}`;

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
 * 优先使用价格最低的可用端点
 */
async function tryEndpoints(request, manager) {
  const requestBody = await request.clone().arrayBuffer();
  const triedIndices = new Set();

  // 按价格顺序尝试所有端点
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    // 获取下一个可用的端点（优先最便宜的）
    let currentIndex = -1;
    for (let i = 0; i < ENDPOINTS.length; i++) {
      if (!triedIndices.has(i) && await manager.isAvailable(i)) {
        currentIndex = i;
        break;
      }
    }

    // 如果没有可用端点，尝试任何未尝试的端点
    if (currentIndex === -1) {
      for (let i = 0; i < ENDPOINTS.length; i++) {
        if (!triedIndices.has(i)) {
          currentIndex = i;
          break;
        }
      }
    }

    if (currentIndex === -1) break;

    triedIndices.add(currentIndex);
    const endpoint = ENDPOINTS[currentIndex];

    try {
      // 重新创建请求（因为 body 只能读取一次）
      const clonedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: requestBody.byteLength > 0 ? requestBody : null
      });

      const response = await proxyRequest(clonedRequest, endpoint);

      // 如果响应成功（2xx 或 3xx），记录成功并返回
      if (response.status < 400) {
        await manager.recordSuccess(currentIndex);
        console.log(`Success with endpoint ${endpoint} (index ${currentIndex})`);
        return { response, endpointIndex: currentIndex, success: true };
      }

      // 如果是 4xx 或 5xx 错误，记录失败并尝试下一个
      await manager.recordFailure(currentIndex);
      console.log(`Endpoint ${endpoint} failed with status ${response.status}, trying next...`);
    } catch (error) {
      await manager.recordFailure(currentIndex);
      console.log(`Endpoint ${endpoint} error: ${error.message}, trying next...`);
    }
  }

  // 所有端点都失败了
  return { response: null, endpointIndex: -1, success: false };
}

export default {
  async fetch(request, env, ctx) {
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

    // 创建健康管理器
    const manager = new EndpointHealthManager();

    // 尝试所有端点（按价格从低到高）
    const result = await tryEndpoints(request, manager);

    if (!result.success) {
      return new Response('All endpoints failed', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 构建响应头
    const responseHeaders = new Headers(result.response.headers);

    // 添加 CORS 头
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    // 添加调试信息头
    responseHeaders.set('X-Used-Endpoint', ENDPOINTS[result.endpointIndex]);
    responseHeaders.set('X-Endpoint-Index', result.endpointIndex.toString());

    return new Response(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: responseHeaders
    });
  }
};
