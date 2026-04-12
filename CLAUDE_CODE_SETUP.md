# Claude Code 配置指南

本路由器完全兼容 Claude Code CLI 和 VSCode 扩展。

## 配置方法

### 方法 1: 使用自定义 API 端点（推荐）

在 Claude Code 配置中设置自定义 API 端点：

#### CLI 配置

编辑 `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "替换为您的API Key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev"
  },
  "permissions": {
    "allow": [],
    "deny": []
  }
}
```

注意：
- 使用 `ANTHROPIC_AUTH_TOKEN` 而不是 `apiKey`
- 使用 `ANTHROPIC_BASE_URL` 而不是 `apiUrl`
- 配置文件位置是 `~/.claude/settings.json`
- 默认配置使用自动路由，Worker 会从最低价层级（ultra）开始尝试，且默认不自动升级到更高等级端点

**高级配置**：你也可以指定特定端点作为基础 URL：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "替换为您的API Key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev/claude/ultra"
  }
}
```

这样配置后，所有请求都会优先使用 ultra 端点；默认只会在同层级内尝试（仅 ultra）。

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

## 端点配置模板（可直接复制）

### 1) 默认省钱模式（推荐）

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev"
  }
}
```

行为：`ultra`，不会自动升到 `super/claude`。

### 2) 固定从指定端点开始

把 `ANTHROPIC_BASE_URL` 改成以下之一：

- `https://your-worker.workers.dev/claude/ultra`（`ultra`）
- `https://your-worker.workers.dev/claude/super`（`super -> ultra`）
- `https://your-worker.workers.dev/claude`（`claude -> ultra -> super`）

### 3) 允许更高等级端点（按需开启）

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-ccr-tier: true"
  }
}
```

说明：开启后会允许继续尝试更高等级端点。  
`ANTHROPIC_CUSTOM_HEADERS` 格式：`"Header1: value1\nHeader2: value2"`。

### 4) 强制走 GPT（Codex）

如果希望 Claude Code 直接走 GPT/Codex 路由，可配置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-force-codex: true"
  }
}
```

行为：
- 优先走 Codex 路由（`/codex/v1/responses`）
- 成功时响应头会返回 `X-Route-Type: codex-fallback`
- 响应体仍保持 Claude Messages 兼容格式，便于 Claude Code 直接消费
- `tools/tool_choice` 会透传到 Codex，并将工具调用回转为 Claude `tool_use`

## 验证配置

测试连接：

```bash
# 使用 Claude Code CLI
claude chat "Hello, Claude"

# 或使用 curl（自动路由）
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 或指定优先端点（如 ultra）
curl https://your-worker.workers.dev/claude/ultra/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

查看响应头中的调试信息：
- `X-Used-Endpoint`: 实际使用的端点
- `X-Preferred-Endpoint`: 请求指定的优先端点（如果有）
- `X-Route-Type`: 路由类型（`claude` / `codex` / `codex-fallback` / `claude-fallback`）

如需验证“强制走 GPT（Codex）”，可使用：

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "Authorization: Bearer your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-force-codex: true" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "ping"}]
  }' -i
```

当响应头是 `X-Route-Type: codex-fallback`，且 `model` 为 Codex 模型（如 `gpt-5.3-codex`）时，说明配置成功。

## 使用指定端点路由（高级功能）

除了默认的自动路由，你还可以通过路径指定优先使用的端点。

### 在 Claude Code 中使用指定端点

虽然 Claude Code 默认会使用配置的 `ANTHROPIC_BASE_URL`，但你可以通过修改配置来使用特定端点：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev/claude/ultra"
  }
}
```

这样配置后，所有请求都会优先使用 ultra 端点；默认只会在 ultra 端点内重试主备源。

### 通过 ANTHROPIC_CUSTOM_HEADERS 控制是否允许更高等级降级

默认情况下，Worker 不会自动降级到更高等级端点（`ultra/super/claude`）。  
如需开启，请在 Claude Code 中设置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://your-worker.workers.dev",
    "ANTHROPIC_CUSTOM_HEADERS": "x-ccr-tier: true"
  }
}
```

该配置会注入 `x-ccr-tier: true`，Worker 才会继续尝试更高等级端点。
`ANTHROPIC_CUSTOM_HEADERS` 支持多行格式：`"Header1: value1\nHeader2: value2"`。

### 支持的端点路径

- `https://your-worker.workers.dev/claude/ultra` - 优先使用 ultra 端点（最便宜）
- `https://your-worker.workers.dev/claude/super` - 优先使用 super 端点
- `https://your-worker.workers.dev/claude` - 优先使用 claude 端点（最贵）
- `https://your-worker.workers.dev` - 自动路由（默认，推荐）

说明：`/claude/droid`、`/claude/aws` 当前仅做路径兼容，不再作为可用候选端点参与调度。

多数场景下建议直接使用默认自动路由。

## 监控和调试

### 查看使用的端点

响应头中包含：
- `X-Used-Endpoint`: 实际使用的端点路径
- `X-Endpoint-Index`: 端点索引（0=ultra, 1=super, 2=claude）
- `X-Preferred-Endpoint`: 请求指定的优先端点（如果有）
- `X-Allow-Higher-Tier-Fallback`: 是否允许向更高等级端点降级（`true/false`）

### 查看 Worker 日志

```bash
wrangler tail
```

端点健康状态在 Worker 内存中维护，可通过日志观察进入/退出冷却期。

## 高级配置

### 调整冷却时间

修改 [worker.js](worker.js) 中的配置：

```javascript
const HEALTH_CHECK_CONFIG = {
  COOLDOWN_TIME: 60,     // 秒，默认 1 分钟
  MAX_FAILURES: 3,       // 连续失败次数阈值
};
```

## 常见问题

### Q: 如何重置端点状态？

A: 重新部署 Worker 或等待 Worker 实例重启即可重置状态。健康状态存储在内存中，会在重启后自动清空。

### Q: 支持流式响应吗？

A: 完全支持！Worker 会透传 Server-Sent Events (SSE) 流式响应，Claude Code 的流式输出完全正常。

## 路由规则（简版）

1. 默认从低价层级（ultra）开始，且不自动升到更高层级
2. 设置 `x-ccr-tier: true` 后，才允许尝试 `super/claude`
3. 指定端点时先尝试该端点，再按规则继续
4. 每个端点先主源再备源，两个源都失败才换下一个端点

## 安全建议

1. **保护 API Key**: 不要将 API Key 提交到代码仓库
2. **限制访问**: 考虑添加 IP 白名单或请求签名验证
3. **监控使用**: 定期检查 Worker 的请求日志

## 支持

如遇问题，可以：
1. 查看 [README.md](README.md) 了解基本配置
2. 使用 `wrangler tail` 查看实时日志
3. 检查 Worker Dashboard 的指标和错误
