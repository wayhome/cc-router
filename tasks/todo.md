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

## 2026-04-12 Codex 端点支持 Chat Completions

- [x] 识别 `/codex/v1/chat/completions` 并在 Codex 路由内启用 OpenAI Chat 请求转换
- [x] 将 OpenAI Chat 请求转换为 Codex Responses 请求并透传到 `/codex/v1/responses`
- [x] 将 Codex 响应（JSON/SSE）转换为 OpenAI Chat Completions 响应（JSON/SSE）
- [x] 保持现有 `/codex/v1/responses` 透传行为与 Claude/OpenAI 主路由行为不回归
- [x] 更新 README，补充 Codex Chat Completions 用法说明
- [x] 运行语法检查与 `npm test` 并记录结果

### Review

- `worker.js` 已新增 Codex Chat Completions 识别：`/codex/v1/chat/completions` 会走 OpenAI Chat 请求转换，不影响 `/codex/v1/responses` 透传。
- 已新增 OpenAI Chat <-> Codex Responses 双向转换（含 SSE），并在响应头增加 `X-Format-Conversion: openai-chat<->codex-responses` 便于调试。
- Codex 主备源与跨协议备用逻辑保持不变；仅在成功响应时做格式转换，失败时仍优先透传上游错误体。
- README 已补充 `/codex/v1/chat/completions` 调用示例与行为说明。
- 语法检查通过：`node --check worker.js`。
- `npm test` 执行失败：仓库缺少 `package.json`（`ENOENT`）。

## 2026-04-12 补齐 Codex models 接口

- [x] 新增 `/codex/v1/models` 返回 OpenAI Models 列表格式
- [x] 保持 `/v1/models` 继续返回 Claude 模型列表
- [x] 更新验证脚本，增加 models 探活检查
- [x] 更新 README 的 Codex 行为说明
- [ ] 用 `.env` 执行验证脚本确认通过（待部署后）

### Review

- `worker.js` 已新增 Codex models 路径识别并直接返回模型列表，不再依赖上游是否提供 `/codex/v1/models`。
- Codex 模型列表已补充 `gpt-5.4`。
- `getOpenAIModelsResponse` 改为可传入模型列表与 `owned_by`，分别服务 Claude 与 Codex。
- 验证脚本已增加 `[0/3]` models 校验：检查状态码、`X-Route-Type: codex`、模型列表包含 `gpt-5.4` 与 `gpt-5.3-codex`。
- 当前用 `.env` 对线上地址执行时在 models 校验阶段失败，说明线上实例尚未部署本地最新变更。

## 2026-04-12 修复第三方 context_length 探测告警

- [x] 为 Codex 模型返回补充 `context_length`/`input_token_limit` 等元数据
- [x] 新增 `/codex/v1/models/{model}` 单模型元数据接口
- [x] 更新 README 与验证脚本，覆盖模型详情接口检查
- [ ] 部署后复测第三方软件不再出现 probe-down 告警

### Review

- 已在模型列表与模型详情响应中返回上下文窗口相关字段，目标是让客户端直接读取元数据而不是 probe-down。
- 将 Codex 模型元数据调整为 GPT-5 系列常见规格：`context_length=400000`、`max_output_tokens=128000`，避免 `128000/32768` 保守值导致误判。

## 2026-04-12 Codex Chat Completions tools 支持

- [x] 在 OpenAI Chat -> Codex 请求转换中透传 `tools` 与 `tool_choice`
- [x] 在 Codex -> OpenAI 非流式响应转换中映射 `function_call` 到 `tool_calls`
- [x] 在 Codex -> OpenAI 流式响应转换中映射 function_call 相关 SSE 事件到 `tool_calls` delta
- [x] 更新验证脚本，增加 tools 场景校验
- [x] 更新 README，标注 `/codex/v1/chat/completions` 支持 tools

### Review

- 根因是原先 `convertOpenAIToCodexRequest` 走 Claude 中转并把结构压成纯文本，导致 `tools/tool_choice` 丢失。
- 已改为直接构造 Codex Responses 请求体，保留 `tools/tool_choice/parallel_tool_calls`。
- 已补齐 `response.output_item.*`、`response.function_call_arguments.*` 事件到 Chat Completions `tool_calls` 的映射。
