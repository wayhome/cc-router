# Claude Code 配置指南

本路由器完全兼容 Claude Code CLI 和 VSCode 扩展。

## 配置方法

### 方法 1: 使用自定义 API 端点（推荐）

在 Claude Code 配置中设置自定义 API 端点：

#### CLI 配置

编辑 `~/.config/claude-code/config.json`:

```json
{
  "apiKey": "your-api-key",
  "apiUrl": "https://your-worker.workers.dev"
}
```

或使用命令行设置：

```bash
claude config set apiUrl https://your-worker.workers.dev
```

#### VSCode 扩展配置

1. 打开 VSCode 设置（`Cmd/Ctrl + ,`）
2. 搜索 "Claude Code"
3. 找到 "API URL" 设置
4. 填入你的 Worker URL: `https://your-worker.workers.dev`

或者在 `settings.json` 中添加：

```json
{
  "claude-code.apiUrl": "https://your-worker.workers.dev",
  "claude-code.apiKey": "your-api-key"
}
```

### 方法 2: 使用环境变量

```bash
export ANTHROPIC_BASE_URL=https://your-worker.workers.dev
export ANTHROPIC_API_KEY=your-api-key
```

## 验证配置

测试连接：

```bash
# 使用 Claude Code CLI
claude chat "Hello, Claude"

# 或使用 curl
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

查看响应头中的 `X-Used-Endpoint` 可以确认使用了哪个后端端点。

## 工作原理

```
Claude Code CLI/VSCode
        ↓
  Your Cloudflare Worker
        ↓
智能路由（按价格优先）:
  1. code.newcli.com/claude/aws
  2. code.newcli.com/claude/droid
  3. code.newcli.com/claude/ultra
  4. code.newcli.com/claude
```

Worker 会：
1. 接收来自 Claude Code 的请求
2. 自动选择最便宜且可用的端点
3. 透明转发请求和响应
4. 遇到错误时自动切换到下一个端点

## 监控和调试

### 查看使用的端点

响应头中包含：
- `X-Used-Endpoint`: 实际使用的端点路径
- `X-Endpoint-Index`: 端点索引（0-3）

### 查看 Worker 日志

```bash
wrangler tail
```

### 查看端点健康状态

使用 Wrangler 查看 KV 存储：

```bash
# 列出所有健康状态
wrangler kv key list --namespace-id=your-namespace-id

# 查看特定端点的状态
wrangler kv key get endpoint_health_0 --namespace-id=your-namespace-id
```

## 高级配置

### 调整冷却时间

修改 [worker.js](worker.js) 中的配置：

```javascript
const HEALTH_CHECK_CONFIG = {
  COOLDOWN_TIME: 60,     // 秒，默认 1 分钟
  MAX_FAILURES: 3,       // 连续失败次数阈值
};
```

### 调整端点优先级

修改 ENDPOINTS 数组的顺序：

```javascript
const ENDPOINTS = [
  '/claude/aws',      // 最优先
  '/claude/droid',
  '/claude/ultra',
  '/claude'           // 最后尝试
];
```

## 常见问题

### Q: 为什么有时候会使用较贵的端点？

A: 如果便宜的端点连续失败 3 次，会进入 1 分钟冷却期，期间会自动使用下一个可用端点。

### Q: 如何重置端点状态？

A: 可以手动清空 KV 存储：

```bash
# 获取 KV namespace ID（从 wrangler.toml 中查看）
wrangler kv key delete endpoint_health_0 --namespace-id=your-namespace-id
wrangler kv key delete endpoint_health_1 --namespace-id=your-namespace-id
wrangler kv key delete endpoint_health_2 --namespace-id=your-namespace-id
wrangler kv key delete endpoint_health_3 --namespace-id=your-namespace-id
```

或等待 2 分钟自动过期。

### Q: 如果不配置 KV 会怎样？

A: Worker 仍然可以正常工作，但健康状态不会在不同实例间共享，每个 Worker 实例会独立管理状态。

### Q: 支持流式响应吗？

A: 完全支持！Worker 会透传 Server-Sent Events (SSE) 流式响应，Claude Code 的流式输出完全正常。

## 性能优化

### 使用自定义域名

为 Worker 配置自定义域名可以提升性能：

1. 在 Cloudflare Dashboard 中添加自定义域名
2. 更新 Claude Code 配置使用自定义域名

### 启用缓存

对于不变的请求（如模型列表），可以添加缓存：

```javascript
// 在 worker.js 的 fetch 函数中添加
if (url.pathname === '/v1/models') {
  // 缓存模型列表 1 小时
  ctx.waitUntil(cacheResponse(request, response));
}
```

## 费用估算

Cloudflare Workers 免费额度：
- 100,000 次请求/天
- KV: 100,000 次读取 + 1,000 次写入/天

对于个人使用，免费额度通常足够。如果超出：
- Workers: $5/月，包含 1000 万次请求
- KV: $0.50/GB 存储 + 按使用付费

## 安全建议

1. **保护 API Key**: 不要将 API Key 提交到代码仓库
2. **限制访问**: 考虑添加 IP 白名单或请求签名验证
3. **监控使用**: 定期检查 Worker 的请求日志

## 支持

如遇问题，可以：
1. 查看 [README.md](README.md) 了解基本配置
2. 使用 `wrangler tail` 查看实时日志
3. 检查 Worker Dashboard 的指标和错误
