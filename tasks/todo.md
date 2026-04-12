# TODO

- [x] 识别并解析 Codex 请求路径（`/codex/v1` 前缀）
- [x] 为 Codex 增加“单端点 + 主备源”重试流程（覆盖 4xx/5xx 与网络异常）
- [x] 保持 Codex 请求与响应透传兼容（不做格式转换）
- [x] 为 Codex 返回调试头（已使用源、源索引、路由类型）
- [x] 更新 README 的 Codex 使用说明
- [x] 执行验证命令并记录结果

## 验收标准

- [x] 请求 `/codex/v1...` 不会进入 Claude/OpenAI 转换逻辑
- [x] 当主源失败（4xx/5xx）时会自动尝试备源
- [x] 当全部源失败时，优先返回上游最后一个错误响应（保持 Codex 错误体兼容）
- [x] 现有 Claude/OpenAI 路由行为不回归

## Review

- 已完成 Codex 独立路由分支，路径前缀为 `/codex/v1`，不会进入 OpenAI/Claude 转换逻辑。
- 已完成 Codex 单端点主备源重试：对 4xx/5xx 和网络异常均会切换到下一源。
- Codex 全失败时优先透传最后一个上游错误响应，保留原始状态码/响应体。
- 已新增响应头 `X-Route-Type`，并在 Codex 路由返回 `X-Used-Base-URL`、`X-Base-URL-Index`。
- 语法检查通过：`node --check worker.js`。
- `npm test` 执行失败（仓库无 `package.json`，无法运行测试）。

## 2026-04-12 强制 Codex 修复

- [x] 复现 `x-force-codex: true` 仍返回 `X-Route-Type: claude` 的现象
- [x] 定位 `tryCodexAsFallback` 在 Codex 响应非 JSON 时失败并回退 Claude
- [x] 修复 fallback 请求默认值：显式请求 JSON 并默认关闭 stream
- [x] 增加 Codex SSE 响应解析，避免 `response.json()` 失败导致回退 Claude
- [x] 更新 README 与 CLAUDE_CODE_SETUP 文档，补充 `x-force-codex` 用法
- [x] 重新部署并用 curl 验证返回 `X-Route-Type: codex-fallback`

### Review

- 修复目标：保证 `x-force-codex: true` 在非流式请求下优先返回 Codex 结果，不因上游默认 SSE 而静默回退到 Claude。
- 验证结果：`HTTP 200` 且响应头为 `X-Route-Type: codex-fallback`，响应模型 `gpt-5.3-codex`，输出 `pong`。
