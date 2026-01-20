# Claude API Smart Router

智能 Claude API 路由器，在多个 API 端点之间自动切换，优先使用最便宜且可用的端点。

**📘 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)** - 查看如何在 Claude Code CLI 和 VSCode 扩展中使用

## 功能特性

- **价格优先**: 按价格从低到高尝试端点（aws < droid < ultra < claude）
- **智能故障转移**: 遇到 4xx/5xx 错误自动切换到下一个端点
- **全局状态管理**: 使用 Cloudflare KV 在不同实例和地区之间共享端点健康状态
- **自动冷却**: 连续失败 3 次的端点会被标记为不可用 1 分钟
- **自动恢复**: 冷却期结束后端点自动恢复可用

## 快速开始（Claude Code 用户）

1. 部署 Worker（见下方部署步骤）
2. 获取你的 Worker URL：`https://your-worker.workers.dev`
3. 配置 Claude Code：

```bash
# CLI 配置
claude config set apiUrl https://your-worker.workers.dev

# 或设置环境变量
export ANTHROPIC_BASE_URL=https://your-worker.workers.dev
```

4. 开始使用！Worker 会自动选择最便宜的可用端点

详细配置请查看 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)。

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 KV 命名空间

```bash
wrangler kv namespace create ENDPOINT_HEALTH
```

这会输出类似以下内容：
```
🌀 Creating namespace with title "claude-api-router-ENDPOINT_HEALTH"
✨ Success!
Add the following to your wrangler.toml:
[[kv_namespaces]]
binding = "ENDPOINT_HEALTH"
id = "abc123def456..."
```

### 4. 更新 wrangler.toml

将上一步输出的 `id` 复制到 [wrangler.toml](wrangler.toml) 中：

```toml
[[kv_namespaces]]
binding = "ENDPOINT_HEALTH"
id = "abc123def456..."  # 替换为你的 KV namespace ID
```

### 5. 部署 Worker

```bash
wrangler deploy
```

部署成功后会得到一个 URL，类似：`https://claude-api-router.your-subdomain.workers.dev`

## 使用方法

将所有 Claude API 请求发送到你的 Worker URL：

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'
```

Worker 会自动：
1. 优先尝试最便宜的 `/claude/aws` 端点
2. 如果失败，自动切换到 `/claude/droid`
3. 继续尝试 `/claude/ultra` 和 `/claude`
4. 记录失败状态，连续失败 3 次后暂时跳过该端点

## 调试

响应头中包含调试信息：
- `X-Used-Endpoint`: 实际使用的端点路径
- `X-Endpoint-Index`: 端点索引（0=aws, 1=droid, 2=ultra, 3=claude）

查看日志：
```bash
wrangler tail
```

## 配置调整

修改 [worker.js:22-29](worker.js#L22-L29) 中的配置：

```javascript
const HEALTH_CHECK_CONFIG = {
  COOLDOWN_TIME: 60,     // 冷却时间（秒），默认 1 分钟
  MAX_FAILURES: 3,       // 触发冷却的连续失败次数
  KV_PREFIX: 'endpoint_health_'  // KV key 前缀
};
```

## KV 存储说明

- **免费额度**: 每天 100,000 次读取 + 1,000 次写入
- **延迟**: 最终一致性，全局同步约 60 秒
- **自动过期**: 健康状态会在 2 分钟后自动过期（冷却时间的 2 倍）

对于大多数场景，免费额度足够使用。如果没有绑定 KV，Worker 仍然可以工作，但不会跨实例共享状态。

## 架构说明

```
用户请求
  ↓
Cloudflare Worker
  ↓
检查 KV 中的端点健康状态
  ↓
按价格顺序尝试可用端点:
  1. /claude/aws (最便宜)
  2. /claude/droid
  3. /claude/ultra
  4. /claude (最贵)
  ↓
记录成功/失败到 KV
  ↓
返回响应
```

## License

MIT
