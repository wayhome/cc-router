# Claude/Codex API Smart Router

统一代理 Claude 与 Codex 请求的 Cloudflare Worker：
- Claude 路由支持多端点按优先级切换（`/v1/messages`、`/v1/chat/completions` 等）
- 原生 Codex 路由支持主备源重试（`/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/images/generations` 等）
- `/codex/v1/messages` 是 foxcode 官方 Claude 兼容 Codex 端点，不是原生 Codex Responses 路由
- 对 4xx/5xx 与网络异常自动故障转移，并保持当前路由的上游接口兼容

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wayhome/cc-router)

**🎁 [获取 API Key](https://foxcode.rjj.cc/auth/register?aff=UI2TST)** - 注册获取 Claude/Codex API 访问权限

**📘 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)** - 查看如何在 Claude Code CLI 和 VSCode 扩展中使用

## 功能特性

- **价格优先**: 按价格从低到高排序（aws < codex < ultra < turbo < super < claude）
- **指定端点路由**: 支持通过路径指定优先使用的 Claude 兼容端点（如 `/claude/ultra/v1/messages`、`/codex/v1/messages`）
- **OpenAI 兼容接口**: Claude 路由支持 OpenAI Chat Completions 格式，自动转换为 Claude Messages API
- **智能故障转移**: 当前路由内遇到 4xx/5xx 或网络错误会自动尝试下一个可用端点或源
- **双源互备**: 主源 `code.newcli.com` 和备源 `dm-fox.rjj.cc` 相互备份；Claude 每个端点先试主源再试备源，Codex 原生路由先试主源再试备源
- **Codex 兼容代理**: 原生 Codex 支持 `/responses` 透传、`/chat/completions` 转 Responses、`/images/generations` 透传和 `/models` 本地模型清单
- **模块化源码**: 源码位于 `src/`，Wrangler 部署时会从 `src/worker.js` 打包到 Cloudflare Worker
- **内存状态管理**: 使用全局内存缓存记录端点健康状态（同一实例内共享）
- **自动冷却**: 连续失败 3 次的端点会被标记为不可用 1 分钟
- **自动恢复**: 冷却期结束后端点自动恢复可用
- **Worker 侧零成本**: 可运行在 Cloudflare Workers 免费额度内；上游 API 费用仍按服务商计费

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

4. 开始使用！Claude 请求会自动选择可用端点；原生 Codex 客户端继续使用 `/codex/v1/...`

**提示**：
- Claude 默认使用自动路由，从最低价层级（aws）开始尝试，不可用时最多自动升级到 ultra
- Claude 客户端如果要走 foxcode 官方 Claude 兼容 Codex 端点，使用 `https://your-worker.workers.dev/codex` 作为 base URL，也就是请求 `/codex/v1/messages`
- 原生 Codex 客户端使用 `https://your-worker.workers.dev/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/images/generations`、`/codex/v1/models`
- 你也可以指定 Claude 特定端点，如 `https://your-worker.workers.dev/claude/ultra` 或 `https://your-worker.workers.dev/codex`
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
- Claude Messages：`/v1/messages`、`/claude/*/v1/messages`
- Claude 路由的 OpenAI Chat 兼容：`/v1/chat/completions`、`/claude/*/v1/chat/completions`
- foxcode 官方 Claude 兼容 Codex：`/codex/v1/messages`
- 原生 Codex 客户端：`/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/images/generations`、`/codex/v1/models`、`/codex/v1/models/{model}`

### Claude 路由：自动路由（默认）

将 Claude API 请求发送到你的 Worker URL，Worker 会在默认上限内选择最便宜的可用端点：

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'
```

Worker 会自动：
1. 优先尝试最低价层级端点（`/claude/aws`）
2. 默认会在 `aws -> codex -> ultra` 范围内自动升级
3. 若请求头 `x-ccr-tier: true`，才会继续尝试 `turbo -> super -> claude`
4. 所有允许范围内的 Claude 端点都失败时，返回 Claude 路由错误
5. 记录失败状态，连续失败 3 次后暂时跳过该端点

可通过 Claude Code 的 `ANTHROPIC_CUSTOM_HEADERS` 注入开关头：

```json
{
  "env": {
    "ANTHROPIC_CUSTOM_HEADERS": "x-ccr-tier: true"
  }
}
```

`ANTHROPIC_CUSTOM_HEADERS` 格式为多行 `Header: value`：
`"Header1: value1\nHeader2: value2"`

### Claude 端点配置速查

下表中的“默认尝试顺序”表示不加 `x-ccr-tier: true` 时的行为。显式指定端点时，会先尝试该端点，再按价格顺序循环尝试不高于该端点等级的节点；加上 `x-ccr-tier: true` 后才允许继续尝试更贵节点。

| 场景 | `ANTHROPIC_BASE_URL` | `ANTHROPIC_CUSTOM_HEADERS` | 尝试顺序 |
|---|---|---|---|
| 最省钱（推荐默认） | `https://your-worker.workers.dev` | 不设置 | `aws -> codex -> ultra` |
| 固定从 codex 开始 | `https://your-worker.workers.dev/codex` | 不设置 | `codex -> aws` |
| 固定从 ultra 开始 | `https://your-worker.workers.dev/claude/ultra` | 不设置 | `ultra -> aws -> codex` |
| 固定从 turbo 开始 | `https://your-worker.workers.dev/claude/turbo` | 不设置 | `turbo -> aws -> codex -> ultra` |
| 固定从 super 开始 | `https://your-worker.workers.dev/claude/super` | 不设置 | `super -> aws -> codex -> ultra -> turbo` |
| 固定从 claude 开始 | `https://your-worker.workers.dev/claude` | 不设置 | `claude -> aws -> codex -> ultra -> turbo -> super` |
| 自动路由且允许升档 | `https://your-worker.workers.dev` | `x-ccr-tier: true` | `aws -> codex -> ultra -> turbo -> super -> claude` |

如果要允许继续走更高等级端点，在 `ANTHROPIC_CUSTOM_HEADERS` 加：
`x-ccr-tier: true`

### Claude 路由：指定端点

通过在路径中指定端点名称，可以优先使用特定端点：

```bash
# 优先使用 aws 端点
curl https://your-worker.workers.dev/claude/aws/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude"}
    ]
  }'

# 优先使用 foxcode 官方 Claude 兼容 Codex 端点
curl https://your-worker.workers.dev/codex/v1/messages \
  -H "x-api-key: your-api-key" \
  ...
```

**支持的端点路径**：
- `/claude/aws/v1/messages` - 优先使用 aws 端点（最便宜）
- `/codex/v1/messages` - 优先使用 foxcode 官方 Claude 兼容 Codex 端点
- `/claude/ultra/v1/messages` - 优先使用 ultra 端点
- `/claude/turbo/v1/messages` - 优先使用 turbo 端点
- `/claude/super/v1/messages` - 优先使用 super 端点
- `/claude/v1/messages` - 优先使用 claude 端点（最高等级）
- `/v1/messages` - 自动路由（默认行为）

### Claude 路由：OpenAI 兼容接口

使用 OpenAI Chat Completions API 格式调用 Claude API，Worker 会自动进行格式转换：

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "max_tokens": 1024,
    "temperature": 0.7
  }'
```

**Claude 路由 OpenAI 接口支持的功能**：
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
# 优先使用 ultra 端点的 OpenAI 格式调用
curl https://your-worker.workers.dev/claude/ultra/v1/chat/completions \
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
      "id": "claude-opus-4-6",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-sonnet-4-6",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-haiku-4-5-20251001",
      "object": "model",
      "created": 1677652288,
      "owned_by": "anthropic"
    }
  ]
}
```

**说明**：
- 非流式和流式响应都会自动转换为 OpenAI 兼容格式（含 SSE）
- 建议直接用 OpenAI SDK/LangChain/LlamaIndex 按 OpenAI 方式接入

### 原生 Codex 路由：透传代理 + Chat Completions 兼容

Codex 原生客户端路由是 `/codex/v1/...`。注意：`/codex` 同时也是一个 Claude 兼容端点，Claude 客户端配置 `ANTHROPIC_BASE_URL=https://your-worker.workers.dev/codex` 时会调用 `/codex/v1/messages`；只有下面这些路径会进入原生 Codex 路由：
- `/codex/v1/responses`
- `/codex/v1/chat/completions`
- `/codex/v1/images/generations`
- `/codex/v1/models`
- `/codex/v1/models/{model}`

```bash
curl https://your-worker.workers.dev/codex/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "input": "Write a haiku about retries."
  }'
```

如果你希望在 Codex 路由下直接使用 OpenAI Chat Completions 格式，也可以调用：

```bash
curl https://your-worker.workers.dev/codex/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [
      {"role": "user", "content": "Write a haiku about retries."}
    ]
  }'
```

文生图使用 `gpt-image-2`：

```bash
curl https://your-worker.workers.dev/codex/v1/images/generations \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一个小男孩",
    "size": "1536x1024",
    "quality": "high",
    "n": 1
  }'
```

**行为说明**：
- `/codex/v1/models`：返回 OpenAI Models 列表格式的 Codex 模型清单（用于 SDK 探活/模型枚举，含 `gpt-5.2`、`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5` 与 `gpt-image-2`）
- `/codex/v1/models/{model}`：返回单模型元数据（含 `context_length`/`max_output_tokens` 等字段，默认按 GPT-5 系列 `400k/128k`）
- `/codex/v1/responses`：请求和响应都会原样透传，不做 Claude/OpenAI 格式转换
- `/codex/v1/chat/completions`：自动转换为 Codex Responses 请求并将响应转换回 OpenAI Chat Completions（支持 SSE；tools 参数会透传，上游返回的工具调用会映射为 `tool_calls`）
- `/codex/v1/images/generations`：原样透传到上游，支持 `gpt-image-2`
- 先尝试主源 `https://code.newcli.com`，失败（4xx/5xx 或网络错误）后自动尝试备源 `https://dm-fox.rjj.cc`
- 当两个源都失败时，优先返回最后一个上游错误响应体，保持 Codex 错误格式兼容；不会再切换到 Claude 路由
- 支持的文本模型为 `gpt-5.2`、`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`

## 调试

响应头中包含调试信息：
- `X-Route-Type`: 路由类型（`claude`、`codex`）
- `X-Used-Endpoint`: 实际使用的端点路径
- `X-Endpoint-Index`: Claude 兼容端点索引（0=aws, 1=codex, 2=ultra, 3=turbo, 4=super, 5=claude）
- `X-Used-Base-URL`: 实际使用的基础 URL（主源或备源）
- `X-Base-URL-Index`: 基础 URL 索引（0=主源 newcli, 1=备源 dm-fox）
- `X-Preferred-Endpoint`: 请求指定的优先端点（如果有）
- `X-Format-Conversion`: 格式转换标记（例如 `OpenAI` 或 `openai-chat<->codex-responses`）
- `X-Allow-Higher-Tier-Fallback`: 是否允许向更高等级端点降级（`true/false`）

说明：`X-Used-Endpoint`、`X-Endpoint-Index`、`X-Preferred-Endpoint`、`X-Format-Conversion` 主要用于 Claude/OpenAI 路由；Codex 路由重点查看 `X-Route-Type`、`X-Used-Base-URL`、`X-Base-URL-Index`。

查看日志：
```bash
wrangler tail
```

## 本地预演（wrangler dev）

为了避免“部署后才发现 Codex/Claude Code 不可用”，可以先在本地跑完整回归：

```bash
bash scripts/verify_local_wrangler_dev.sh
```

该脚本会自动：
- 读取项目根目录 `.env`，需要其中有 `CCR_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `OPENAI_API_KEY`
- 启动本地 `wrangler dev`（默认 `http://127.0.0.1:8787`）
- 运行完整验证（`/codex/v1/models`、`gpt-image-2` 模型详情、`/codex/v1/chat/completions`、tools）
- 测试结束后自动关闭本地进程

默认不会发起真实图片生成请求。需要验证文生图时可设置：

```bash
CCR_VERIFY_IMAGES=true bash scripts/verify_local_wrangler_dev.sh
```

可选环境变量：
- `CCR_API_KEY`：验证请求使用的 API Key；未设置时会从 `.env` 的 `ANTHROPIC_AUTH_TOKEN` 或 `OPENAI_API_KEY` 推导
- `CCR_LOCAL_PORT`：本地端口（默认 `8787`）
- `WRANGLER_HOME_DIR`：wrangler HOME 目录（默认 `/tmp/wrangler-home-$USER`，用于规避日志权限问题）

## 配置调整

修改 [src/config.js](src/config.js) 中的配置：

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

## 路由摘要

- Claude Messages 路由：`/v1/messages`、`/claude/*/v1/messages`、`/codex/v1/messages`
- Claude 路由的 OpenAI Chat 兼容：`/v1/chat/completions`、`/claude/*/v1/chat/completions`
- Codex 原生客户端路由：`/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/images/generations`、`/codex/v1/models`、`/codex/v1/models/{model}`
- Claude 默认从 aws 开始，失败时最多自动升级到 ultra；设置 `x-ccr-tier: true` 才允许继续尝试 turbo/super/claude
- 每个端点先试主源 `code.newcli.com`，再试备源 `dm-fox.rjj.cc`
- Claude 和 Codex 路由彼此独立；任一路由全部源失败时返回该路由自身的错误

## License

MIT
