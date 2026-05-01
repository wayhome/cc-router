# Lessons

- 当用户指出“README 未反映最新情况”时，优先检查并同步更新以下区域：标题/简介、功能特性、快速开始、使用方法、架构说明，确保文档与当前代码能力一致。
- README 涉及 `/codex` 时必须明确区分 Claude 兼容端点 `/codex/v1/messages` 和原生 Codex 路由 `/codex/v1/responses|chat/completions|images/generations|models`，避免把两者统称成同一路由。
- 当用户明确说明某模型可用时，不要先改模型名；优先排查协议与响应格式（如 JSON/SSE）兼容问题，再决定是否改模型。
- 当用户更正官方支持的模型列表时，立即同步 `SUPPORTED_*_MODELS`、模型元数据、验证脚本断言和 README 示例，并添加“不应再出现的旧模型”断言。
