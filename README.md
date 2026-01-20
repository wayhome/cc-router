# Claude API Smart Router

智能 Claude API 路由器，在多个 API 端点之间自动切换，优先使用最便宜且可用的端点。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-username/cc-router)

**📘 [Claude Code 配置指南](CLAUDE_CODE_SETUP.md)** - 查看如何在 Claude Code CLI 和 VSCode 扩展中使用

## 功能特性

- **价格优先**: 按价格从低到高尝试端点（aws < droid < ultra < claude）
- **智能故障转移**: 遇到 4xx/5xx 错误自动切换到下一个端点
- **内存状态管理**: 使用全局内存缓存记录端点健康状态（同一实例内共享）
- **自动冷却**: 连续失败 3 次的端点会被标记为不可用 1 分钟
- **自动恢复**: 冷却期结束后端点自动恢复可用
- **零成本**: 完全免费运行

## 快速开始（Claude Code 用户）

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

```
用户请求
  ↓
Cloudflare Worker
  ↓
检查内存缓存中的端点健康状态
  ↓
按价格顺序尝试可用端点:
  1. /claude/aws (最便宜)
  2. /claude/droid
  3. /claude/ultra
  4. /claude (最贵)
  ↓
记录成功/失败到内存缓存
  ↓
返回响应
```

## License

MIT
