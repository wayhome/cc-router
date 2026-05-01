# TODO

## 2026-05-02 刷新 README 当前行为说明

- [x] 对照 `src/config.js`、`src/paths.js`、`src/utils.js` 校验 README 路由说明
- [x] 更新 README 中容易过时或容易误解的路由、fallback、模型与验证说明
- [x] 更新 `tasks/lessons.md` 记录这次文档滞后问题
- [x] 执行文档检查与必要验证，并记录结果

### 验收标准

- [x] README 明确区分 Claude 兼容 `/codex/v1/messages` 与原生 Codex `/codex/v1/*`
- [x] README 的默认和指定端点尝试顺序与 `buildEndpointAttemptOrder` 一致
- [x] README 不再保留旧跨协议 fallback、`/claude/droid` 或 `gpt-5-codex` 相关误导

### Review

- README 已刷新简介、功能特性、快速开始、使用方法、Codex 路由、本地预演和路由摘要，明确 `/codex/v1/messages` 是 Claude 兼容端点，原生 Codex 只覆盖 `/responses`、`/chat/completions`、`/images/generations`、`/models` 和 `/models/{model}`。
- README 的默认顺序、显式端点顺序和 `x-ccr-tier: true` 行为已按 `buildEndpointAttemptOrder` 对齐。
- 已移除 README 中旧的跨协议 fallback、`/claude/droid`、`gpt-5-codex` 相关字样。
- 已更新 `tasks/lessons.md`，记录 `/codex` 双重含义需要在文档中明确区分。
- `git diff --check` 通过；旧术语扫描未命中；路由/顺序断言通过。
- 本次只改 Markdown，未修改 JavaScript，因此未运行 `npm test`。

## 2026-05-01 更正 Codex 模型列表并删除 Droid

- [x] 移除 Codex 模型 `gpt-5-codex`
- [x] 加入 Codex 模型 `gpt-5.2` 与 `gpt-5.5`
- [x] 收紧 `/claude` 端点匹配，确保 `/claude/droid/...` 不再作为兼容路径
- [x] 更新 README、验证脚本与 lessons
- [x] 执行路径/模型断言、语法检查、本地预演、Wrangler dry-run 与 `npm test`

### 验收标准

- [x] `/codex/v1/models` 包含 `gpt-5.2`、`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`、`gpt-image-2`
- [x] `/codex/v1/models` 不包含 `gpt-5-codex`
- [x] `/claude/droid/v1/messages` 不再识别为端点兼容路径

### Review

- `src/config.js` 已将 Codex 文本模型更正为 `gpt-5.2`、`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`，并保留图片模型 `gpt-image-2`；已移除 `gpt-5-codex`。
- `scripts/verify_codex_chat_completions.sh` 已断言模型列表包含 `gpt-5.2/gpt-5.3-codex/gpt-5.4/gpt-5.5/gpt-image-2`，且不包含 `gpt-5-codex`。
- `src/paths.js` 已删除旧兼容端点列表，并收紧 `/claude` 匹配；路径断言确认 `/claude/droid/v1/messages` 解析为普通默认路径，`preferredEndpoint: null`。
- README 示例已从 `gpt-5-codex` 改为 `gpt-5.3-codex`，Codex 模型说明已同步。
- 已按用户更正更新 `tasks/lessons.md`。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`。
- `wrangler deploy --dry-run` 通过，上传体积约 `61.02 KiB`，gzip 约 `11.80 KiB`；仍有 Wrangler 默认日志目录 EPERM 警告但不影响打包结果。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

## 2026-05-01 删除 Claude Droid 兼容路径

- [x] 从配置中删除 `/claude/droid` 旧路径兼容
- [x] 删除文档中的 `/claude/droid` 说明
- [x] 执行路径断言、语法检查、Wrangler dry-run、本地预演与 `npm test`

### 验收标准

- [x] `/claude/droid/v1/messages` 不再识别为端点兼容路径
- [x] 运行时代码和用户文档不再出现 `/claude/droid`

### Review

- `src/config.js` 已删除旧兼容端点列表，不再保留 `/claude/droid`。
- `src/paths.js` 已移除旧兼容路径解析循环，并收紧 `/claude` 端点前缀匹配，避免 `/claude/droid/...` 被误识别为 `/claude`。
- CLAUDE_CODE_SETUP 已删除 `/claude/droid` 兼容说明。
- 路径断言通过：`/claude/droid/v1/messages` 不再有 `preferredEndpoint`。
- 语法检查、本地预演和 Wrangler dry-run 结果见上一节 Review。

## 2026-05-01 支持 Codex Images Generations

- [x] 确认 `/codex/v1/images/generations` 走原生 Codex 透传路由
- [x] 将 `gpt-image-2` 加入 Codex 模型列表与模型详情
- [x] 更新 README，补充文生图调用示例与路由说明
- [x] 更新验证脚本，覆盖模型枚举并提供可选图片生成探测
- [x] 执行路径断言、语法检查、Wrangler dry-run、本地预演与 `npm test`

### 验收标准

- [x] `/codex/v1/images/generations` 不进入 Claude 兼容路由
- [x] `/codex/v1/models` 包含 `gpt-image-2`
- [x] `/codex/v1/models/gpt-image-2` 返回 200
- [x] 默认本地回归不触发真实图片生成

### Review

- 现有原生 Codex 透传已覆盖 `/codex/v1/images/generations`；路径断言确认该路径解析为 `routeType: "codex"`，不会进入 Claude 兼容 `/codex/v1/messages` 分支。
- `src/config.js` 已加入 `gpt-image-2`，并为其返回 `modalities/input_modalities/output_modalities` 元数据。
- README 已补充 `gpt-image-2` 文生图 curl 示例和 `/codex/v1/images/generations` 行为说明；CLAUDE_CODE_SETUP 已同步原生 Codex 路由列表。
- `scripts/verify_codex_chat_completions.sh` 已校验 `/codex/v1/models` 包含 `gpt-image-2`，并校验 `/codex/v1/models/gpt-image-2`；真实图片生成仅在 `CCR_VERIFY_IMAGES=true` 时执行。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`，未触发真实图片生成。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- `wrangler deploy --dry-run` 通过，上传体积约 `60.91 KiB`，gzip 约 `11.77 KiB`；仍有 Wrangler 默认日志目录 EPERM 警告但不影响打包结果。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

## 2026-05-01 插入 Claude Super 节点

- [x] 在 `/claude/turbo` 和 `/claude` 之间加入 `/claude/super`
- [x] 保持默认自动路由上限仍为 `/claude/ultra`
- [x] 更新 README、CLAUDE_CODE_SETUP 与任务记录中的端点顺序
- [x] 执行端点顺序断言、语法检查、Wrangler dry-run、本地预演与 `npm test`

### 验收标准

- [x] `x-ccr-tier: true` 时完整顺序为 `/claude/aws -> /codex -> /claude/ultra -> /claude/turbo -> /claude/super -> /claude`
- [x] 默认顺序仍为 `/claude/aws -> /codex -> /claude/ultra`
- [x] `/claude/super` 不再位于旧路径兼容列表

### Review

- `src/config.js` 已将 `/claude/super` 插入 `/claude/turbo` 和 `/claude` 之间，层级为 4。
- 默认自动路由仍为 `/claude/aws -> /codex -> /claude/ultra`。
- `x-ccr-tier: true` 完整顺序为 `/claude/aws -> /codex -> /claude/ultra -> /claude/turbo -> /claude/super -> /claude`。
- README 与 CLAUDE_CODE_SETUP 已同步价格顺序、固定 super 起步示例和 `X-Endpoint-Index`。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- `wrangler deploy --dry-run` 通过，上传体积约 `60.78 KiB`，gzip 约 `11.74 KiB`；仍有 Wrangler 默认日志目录 EPERM 警告但不影响打包结果。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

## 2026-05-01 默认自动升级到 Ultra

- [x] 修改默认 Claude 自动路由顺序为 `/claude/aws -> /codex -> /claude/ultra`
- [x] 保持 `x-ccr-tier: true` 时才允许继续尝试 `/claude/turbo` 与 `/claude`
- [x] 保持显式指定端点的既有层级限制语义
- [x] 更新 README 与 CLAUDE_CODE_SETUP 的默认行为说明
- [x] 执行端点顺序断言、语法检查、Wrangler dry-run、本地预演与 `npm test`

### 验收标准

- [x] 默认 Claude 路由会从 aws 开始，并在失败时最多自动升级到 ultra
- [x] 默认 Claude 路由不会尝试 turbo 或 claude
- [x] `x-ccr-tier: true` 仍可放开到完整顺序

### Review

- `src/utils.js` 已新增默认自动路由上限 `/claude/ultra`：无指定端点且未设置 `x-ccr-tier` 时，尝试顺序为 `/claude/aws -> /codex -> /claude/ultra`。
- `x-ccr-tier: true` 仍会放开完整顺序：`/claude/aws -> /codex -> /claude/ultra -> /claude/turbo -> /claude/super -> /claude`。
- 显式指定端点保持既有层级限制：例如 `/codex` 为 `/codex -> /claude/aws`，`/claude/turbo` 为 `/claude/turbo -> /claude/aws -> /codex -> /claude/ultra`。
- README 与 CLAUDE_CODE_SETUP 已同步默认最多升到 ultra、`x-ccr-tier` 才继续到 turbo/super/claude 的说明。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- `wrangler deploy --dry-run` 通过，上传体积约 `60.76 KiB`，gzip 约 `11.73 KiB`；仍有 Wrangler 默认日志目录 EPERM 警告但不影响打包结果。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

## 2026-05-01 更新 Claude 可用节点顺序

- [x] 将 Claude 兼容端点顺序改为 `/claude/aws`、`/codex`、`/claude/ultra`、`/claude/turbo`、`/claude/super`、`/claude`
- [x] 保持原 Codex 客户端路由 `/codex/v1` 不变
- [x] 让 `/codex/v1/messages` 作为 Claude 兼容端点 `/codex` 转发，而不是进入原 Codex 客户端路由
- [x] 更新 README 与 CLAUDE_CODE_SETUP 中的端点顺序、示例和调试索引
- [x] 执行语法检查、路径解析断言、Wrangler dry-run、本地预演与 `npm test` 并记录结果

### 验收标准

- [x] 默认 Claude 路由从 `/claude/aws` 开始
- [x] 启用 `x-ccr-tier: true` 后按 `/claude/aws -> /codex -> /claude/ultra -> /claude/turbo -> /claude/super -> /claude` 尝试
- [x] `/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/models` 仍是原 Codex 客户端路由
- [x] `/codex/v1/messages` 被识别为 Claude 兼容 `/codex` 端点

### Review

- `src/config.js` 已更新 Claude 兼容端点顺序：`/claude/aws`、`/codex`、`/claude/ultra`、`/claude/turbo`、`/claude/super`、`/claude`。
- `src/paths.js` 已特殊处理 `/codex/v1/messages` 与其子路径，让 Claude 客户端以 `/codex` 为 base URL 时进入 Claude 路由；原生 Codex 的 `/codex/v1/responses`、`/codex/v1/chat/completions`、`/codex/v1/models` 保持不变。
- 路径断言通过：`/codex/v1/messages` 解析为 `{ routeType: "claude", preferredEndpoint: "/codex", apiPath: "/v1/messages" }`；原生 Codex 三个路径仍解析为 `routeType: "codex"`。
- 端点顺序断言通过：默认仅 `/claude/aws`；开启 `x-ccr-tier` 后为 `/claude/aws -> /codex -> /claude/ultra -> /claude/turbo -> /claude/super -> /claude`。
- README 与 CLAUDE_CODE_SETUP 已同步端点顺序、`/codex` 双重含义和调试索引。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- `wrangler deploy --dry-run` 通过，上传体积约 `60.69 KiB`，gzip 约 `11.71 KiB`；仍有 Wrangler 默认日志目录 EPERM 警告但不影响打包结果。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

## 2026-05-01 拆分 Worker 并移除 Claude/Codex 互转

- [x] 将 `worker.js` 拆成 `src/` 下的模块化源码
- [x] 调整 `wrangler.toml`，让 Cloudflare/Wrangler 部署时从模块入口编译打包
- [x] 移除 Claude -> Codex 与 Codex -> Claude 的跨协议备用转换逻辑
- [x] 保留 Claude 路由、Codex 路由、OpenAI Chat 兼容转换等仍需要的能力
- [x] 更新 README、Claude Code 说明和本地验证脚本，删除旧的 `x-force-codex`/`x-force-claude` 互转说明
- [x] 执行语法检查、本地验证脚本与 `npm test`，记录结果

### 验收标准

- [x] 源码不再是单个几千行 `worker.js`
- [x] 部署入口使用模块化 Worker，Wrangler 可在部署时完成依赖打包
- [x] Claude 源全部失败时返回 Claude 路由错误，不再转 Codex
- [x] Codex 源全部失败时返回 Codex 路由错误，不再转 Claude
- [x] Codex `/responses` 继续透传，`/chat/completions` 继续提供 OpenAI Chat 兼容
- [x] 文档与脚本不再验证或宣传 Claude/Codex 互相转换

### Review

- 已删除根目录 3292 行 `worker.js`，改为 `src/worker.js` 入口和 `src/config.js`、`src/health.js`、`src/proxy.js`、`src/paths.js`、`src/models.js`、`src/utils.js`、`src/conversions/*` 等模块。
- `wrangler.toml` 已改为 `main = "src/worker.js"`；`wrangler deploy --dry-run` 通过，Wrangler 可部署时打包模块入口。
- 已移除 `x-force-codex`/`x-force-claude`、`tryCodexAsFallback`、`tryClaudeAsFallback` 以及 Claude/Codex 互转函数；Claude 与 Codex 路由现在彼此独立失败。
- README、CLAUDE_CODE_SETUP 和验证脚本已删除旧的跨协议 fallback 说明与断言。
- 语法检查通过：所有 `src/*.js`、`src/conversions/*.js` 均通过 `node --check`；验证脚本通过 `bash -n`。
- 本地预演通过：`bash scripts/verify_local_wrangler_dev.sh`。
- `npm test` 失败：仓库没有 `package.json`，npm 返回 `ENOENT`。

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

## 2026-04-12 修复 x-force-codex 下 Claude tools 丢失

- [x] 修复 Claude -> Codex fallback 请求转换，透传 `tools/tool_choice`
- [x] 修复 Codex -> Claude fallback 响应转换，回转 `tool_use` 与 `stop_reason=tool_use`
- [x] 扩展验证脚本，增加 `/v1/messages + x-force-codex + tools` 校验
- [x] 更新 README/CLAUDE_CODE_SETUP，明确强制 Codex 下支持工具调用
- [ ] 部署后复测 Claude Code 工具调用链路

### Review

- 根因：`convertClaudeToCodexRequest` 只拼接纯文本，导致 Codex 收不到工具定义与选择策略。
- 影响：`x-force-codex` 场景下模型无法产生可被 Claude Code 识别的 `tool_use`。
- 修复：请求侧映射 `tools/tool_choice`，响应侧将 Codex `function_call` 映射为 Claude `tool_use`。

## 2026-04-12 增加 wrangler dev 本地回归

- [x] 新增 `scripts/verify_local_wrangler_dev.sh` 一键本地预演脚本
- [x] 脚本启动本地 `wrangler dev` 后自动执行全量回归并自动清理进程
- [x] 本机执行通过（含 tools 与 x-force-codex 场景）
- [x] README 补充本地预演说明与可选环境变量

### Review

- 目标是把“部署后才暴露问题”前移到本地开发阶段。
- 本地预演命令：`bash scripts/verify_local_wrangler_dev.sh`。

## 2026-04-12 修复 x-force-codex 流式工具回显

- [x] 复现 `/v1/messages + x-force-codex + stream:true` 被错误降级为 JSON
- [x] 新增 Codex SSE -> Claude SSE 转换（含 text/tool_use/message_delta/message_stop）
- [x] 修复 `tryCodexAsFallback`：流式请求返回 SSE，不再返回 JSON
- [x] 扩展验证脚本：强制 Codex 场景改为 `stream:true` 并校验 `tool_use` 事件
- [ ] 部署后复测 Claude Code 工具调用回显

### Review

- 根因是 fallback 路径忽略了 Claude `stream:true` 协议语义。
- 修复后，Claude Code 在强制 Codex 模式下可收到标准 Claude SSE 事件流。

## 2026-04-13 修复 x-force-codex 强制语义与工具事件兜底

- [x] 修复 `x-force-codex: true` 失败时的路由行为，禁止静默回退 Claude
- [x] 增强 Codex SSE -> Claude SSE：`response.completed` 时兜底补齐缺失 `tool_use` 事件块
- [x] 更新验证脚本，增加“强制 Codex 失败返回错误”的断言
- [x] 运行语法检查、验证脚本与 `npm test` 并记录结果

### Review

- `tryCodexAsFallback` 现在会保留并返回最后一个 Codex 错误响应；`x-force-codex: true` 分支在 Codex 失败时直接返回该错误，不再落回 Claude 主路由。
- `convertCodexStreamToClaude` 在 `response.completed` 事件里增加了工具调用兜底：即使上游遗漏中间 `output_item` 事件，也会补齐 `tool_use` 块后再发 `stop_reason=tool_use`。
- `scripts/verify_codex_chat_completions.sh` 新增“无效 key + x-force-codex”断言，验证强制语义。
- 本地验证通过：`bash scripts/verify_local_wrangler_dev.sh`。
- 远端验证脚本失败是预期（线上仍是旧部署）；`npm test` 失败（仓库缺少 `package.json`，`ENOENT`）。
