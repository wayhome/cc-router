# Claude/Codex API Smart Router

统一代理 Claude 与 Codex 请求的 Cloudflare Worker：
- Claude 路由支持多端点按优先级切换（`/v1/messages`、`/v1/chat/completions` 等）
- Codex 路由支持单端点主备源重试（`/codex/v1`）
- 对 4xx/5xx 与网络异常自动故障转移，并保持上游接口兼容

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-username/cc-router)

**🎁 [获取 API Key](https://foxcode.rjj.cc/auth/register?aff=UI2TST)** - 注册获取 Claude/Codex API 访问权限

**📘 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)** - 查看如何在 Claude Code CLI 和 VSCode 扩展中使用

## 功能特性

- **价格优先**: 按价格从低到高尝试端点（droid < aws < ultra < super < claude）
- **指定端点路由**: 支持通过路径指定优先使用的端点（如 `/claude/aws/v1/messages`）
- **OpenAI 兼容接口**: 支持 OpenAI Chat Completions API 格式，自动转换为 Claude API
- **智能故障转移**: 遇到 4xx/5xx 错误自动切换到下一个端点
- **双源互备**: 主源 (newcli) 和备源 (dm-fox) 相互备份，单个端点失败时先尝试备源的相同端点
- **Codex 兼容代理**: 支持 `/codex/v1` 路由透传，单端点下自动主备源切换并对 4xx/5xx 重试
- **内存状态管理**: 使用全局内存缓存记录端点健康状态（同一实例内共享）
- **自动冷却**: 连续失败 3 次的端点会被标记为不可用 1 分钟
- **自动恢复**: 冷却期结束后端点自动恢复可用
- **零成本**: 完全免费运行

## 快速开始

1. 部署 Worker（见下方部署步骤）
2. 获取你的 Worker URL：`https://your-worker.workers.dev`（建议绑定自定义域名）
3. 配置 Claude Code，编辑 `~/.claude/settings.json`：

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

4. 开始使用！Claude 请求会自动选择可用端点，Codex 请求走 `/codex/v1` 主备源重试

**提示**：
- Claude 默认使用自动路由，从最便宜的 droid 端点开始尝试
- Codex 统一使用 `https://your-worker.workers.dev/codex/v1/...` 路径
- 你也可以指定 Claude 特定端点，如 `https://your-worker.workers.dev/claude/droid`
- Claude Code 详细配置请查看 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 部署 Worker

```bash
wrangler deploy
```

部署成功后会得到一个 URL，类似：`https://claude-api-router.your-subdomain.workers.dev`

### 4. 绑定自定义域名（推荐）

**⚠️ 重要**: `workers.dev` 域名在中国大陆无法访问，强烈建议绑定自定义域名。

1. 在 Cloudflare Dashboard 中打开你的 Worker
2. 进入 **Triggers** 标签页
3. 点击 **Add Custom Domain**
4. 输入你的域名（如 `api.yourdomain.com`）
5. Cloudflare 会自动配置 DNS 和 SSL 证书

绑定后使用自定义域名：`https://api.yourdomain.com`

## 使用方法

按路由类型使用：
- Claude：`/v1/messages`、`/v1/chat/completions`、`/claude/*`
- Codex：`/codex/v1/*`

### Claude 路由：自动路由（默认）

将所有 Claude API 请求发送到你的 Worker URL，Worker 会自动选择最便宜的可用端点：

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
1. 优先尝试最便宜的 `/claude/droid` 端点
2. 如果失败，自动切换到 `/claude/aws`
3. 继续尝试 `/claude/ultra`、`/claude/super` 和 `/claude`
4. 记录失败状态，连续失败 3 次后暂时跳过该端点

### Claude 路由：指定端点

通过在路径中指定端点名称，可以优先使用特定端点：

```bash
# 优先使用 aws 端点
curl https://your-worker.workers.dev/claude/aws/v1/messages \
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

# 优先使用 super 端点
curl https://your-worker.workers.dev/claude/super/v1/messages \
  -H "x-api-key: your-api-key" \
  ...
```

**工作原理**：
- 首先尝试指定的端点（如 `/claude/aws`）
- 如果指定端点失败，从该端点位置往后尝试更贵的端点（aws → ultra → super → claude）
- 如果后面的端点都失败，再尝试前面更便宜的端点（droid）
- 保持完整的故障转移和健康检查机制

**支持的端点路径**：
- `/claude/aws/v1/messages` - 优先使用 aws 端点
- `/claude/droid/v1/messages` - 优先使用 droid 端点
- `/claude/ultra/v1/messages` - 优先使用 ultra 端点
- `/claude/super/v1/messages` - 优先使用 super 端点
- `/claude/v1/messages` - 优先使用 claude 端点
- `/v1/messages` - 自动路由（默认行为）

### Claude 路由：OpenAI 兼容接口

使用 OpenAI Chat Completions API 格式调用 Claude API，Worker 会自动进行格式转换：

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "max_tokens": 1024,
    "temperature": 0.7
  }'
```

**OpenAI 接口支持的功能**：
- ✅ 自动将 OpenAI 请求格式转换为 Claude Messages API 格式
- ✅ 自动将 Claude 响应格式转换为 OpenAI Chat Completions 格式
- ✅ 支持 `system`、`user`、`assistant` 角色
- ✅ 支持 `temperature`、`top_p`、`max_tokens`、`stop` 等参数
- ✅ 支持流式响应（`stream: true`），实时转换 SSE 格式
- ✅ 支持 `/v1/models` 接口获取可用模型列表
- ✅ 完整的端点路由和故障转移支持
- ✅ 自动过滤无效参数（如字符串 `"[undefined]"`）

**指定端点的 OpenAI 格式调用**：
```bash
# 优先使用 aws 端点的 OpenAI 格式调用
curl https://your-worker.workers.dev/claude/aws/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

**获取可用模型列表**：
```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer your-api-key"
```

响应示例：
```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet-4-5-20250929",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-haiku-4-5-20251001",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-opus-4-5-20251101",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    }
  ]
}
```

**响应格式对比**：

OpenAI 格式响应：
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "claude-3-5-sonnet-20241022",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I assist you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}
```

Claude 原生格式响应（使用 `/v1/messages`）：
```json
{
  "id": "msg_123",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hello! How can I assist you today?"}],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 20, "output_tokens": 10}
}
```

**流式响应说明**：

Worker 会自动将 Claude 的 Server-Sent Events (SSE) 格式转换为 OpenAI 的 SSE 格式：

Claude SSE 事件：
```
data: {"type":"message_start","message":{"id":"msg_123","role":"assistant"}}
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
data: {"type":"message_stop"}
```

转换为 OpenAI SSE 格式：
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
data: [DONE]
```

这使得任何支持 OpenAI API 的客户端都可以无缝使用 Claude API，包括：
- 官方 OpenAI SDK
- LangChain
- LlamaIndex
- 各种 OpenAI 兼容的聊天界面

### Codex 路由：透传代理

Codex 默认上游路由是 `https://code.newcli.com/codex/v1`。通过本 Worker 时，请使用相同路径前缀：

```bash
curl https://your-worker.workers.dev/codex/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-codex",
    "input": "Write a haiku about retries."
  }'
```

**行为说明**：
- 请求和响应都会原样透传，不做 Claude/OpenAI 格式转换
- 先尝试主源 `https://code.newcli.com`，失败（4xx/5xx 或网络错误）后自动尝试备源 `https://dm-fox.rjj.cc`
- 当两个源都失败时，优先返回最后一个上游错误响应体，保持 Codex 错误格式兼容

## 调试

响应头中包含调试信息：
- `X-Route-Type`: 路由类型（`claude` 或 `codex`）
- `X-Used-Endpoint`: 实际使用的端点路径
- `X-Endpoint-Index`: 端点索引（0=droid, 1=aws, 2=ultra, 3=super, 4=claude）
- `X-Used-Base-URL`: 实际使用的基础 URL（主源或备源）
- `X-Base-URL-Index`: 基础 URL 索引（0=主源 newcli, 1=备源 dm-fox）
- `X-Preferred-Endpoint`: 请求指定的优先端点（如果有）
- `X-Format-Conversion`: 如果使用了 OpenAI 格式转换，显示 "OpenAI"

说明：`X-Used-Endpoint`、`X-Endpoint-Index`、`X-Preferred-Endpoint`、`X-Format-Conversion` 主要用于 Claude/OpenAI 路由；Codex 路由重点查看 `X-Route-Type`、`X-Used-Base-URL`、`X-Base-URL-Index`。

查看日志：
```bash
wrangler tail
```

## 配置调整

修改 [worker.js:24-32](worker.js#L24-L32) 中的配置：

```javascript
const HEALTH_CHECK_CONFIG = {
  COOLDOWN_TIME: 60,     // 冷却时间（秒），默认 1 分钟
  MAX_FAILURES: 3,       // 触发冷却的连续失败次数
};
```

## 状态管理说明

- **存储方式**: 使用全局内存缓存（Map）存储端点健康状态
- **共享范围**: 同一 Worker 实例内的所有请求共享状态
- **成本**: 完全免费，无任何限制
- **性能**: 内存访问，零延迟
- **持久性**: Worker 重启后状态重置，会自动重新学习端点健康状况

## 架构说明

路由按路径分流：
- **Claude/OpenAI 路由**: `/v1/messages`、`/v1/chat/completions`、`/claude/*`，使用多端点策略
- **Codex 路由**: `/codex/v1/*`，使用单端点主备源重试并透传请求/响应

### Claude/OpenAI 流程

```
用户请求
  ↓
Cloudflare Worker
  ↓
解析请求路径，提取优先端点
  ↓
检查内存缓存中的端点健康状态
  ↓
按优先级顺序尝试端点:
  - 如果指定了优先端点，从该位置开始往后尝试
    例如指定 ultra: ultra → super → claude → droid → aws
  - 否则按价格顺序尝试:
    1. /claude/droid (最便宜)
    2. /claude/aws
    3. /claude/ultra
    4. /claude/super
    5. /claude (最贵)
  ↓
对于每个端点，依次尝试两个源:
  1. 主源 (code.newcli.com)
  2. 备源 (dm-fox.rjj.cc)
  - 只有两个源都失败才切换到下一个端点
  ↓
记录成功/失败到内存缓存（每个"端点+源"组合独立追踪）
  ↓
返回响应（包含调试信息头）
```

### Codex 流程

```
用户请求 (/codex/v1/*)
  ↓
Cloudflare Worker
  ↓
识别为 Codex 路由（不进入 OpenAI/Claude 转换分支）
  ↓
优先尝试主源:
  1. https://code.newcli.com/codex/v1/*
  ↓ 失败（4xx/5xx 或网络错误）
尝试备源:
  2. https://dm-fox.rjj.cc/codex/v1/*
  ↓
成功: 透传上游响应（保持 Codex 兼容）
失败: 返回最后一个上游错误响应（保持原始状态码和响应体）
```

### 备源机制说明

Worker 为每个端点配置了主源和备源，提供高可用性：

- **主源**: `https://code.newcli.com` - 默认优先使用
- **备源**: `https://dm-fox.rjj.cc` - 主源失败时自动切换

**切换逻辑**：
1. 尝试某个端点时，先尝试主源
2. 如果主源失败（4xx/5xx 或网络错误），立即尝试备源的相同端点
3. 只有两个源都失败后，才切换到下一个端点
4. 每个"端点+源"组合独立追踪健康状态

**示例**：
```
请求 /claude/aws/v1/messages
  ↓
尝试: code.newcli.com/claude/aws/v1/messages (失败)
  ↓
尝试: dm-fox.rjj.cc/claude/aws/v1/messages (成功) ✓
  ↓
返回响应，响应头显示:
  X-Used-Endpoint: /claude/aws
  X-Used-Base-URL: https://dm-fox.rjj.cc
  X-Base-URL-Index: 1
```

这种设计确保了：
- 优先使用价格最低的端点
- 单个源故障不会导致服务中断
- 最大化可用性和成本效益

## License

MIT
