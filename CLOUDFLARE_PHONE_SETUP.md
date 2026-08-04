# 掌心窗安全版：Cloudflare Workers 免费部署

这个部署方案把手机后端与六个 MCP 工具合并为一个 Cloudflare Worker。它只需要
Workers Free 计划，不需要 Render，也不需要在仓库中保存任何密钥。

## 部署目录

Cloudflare Workers Builds 连接本仓库后使用以下配置：

- Production branch: `main`
- Root directory: `/worker`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

## 必填 Secrets

部署完成后，在 Worker 的 Settings / Variables and Secrets 中添加：

- `LINJIAN_TOKEN`：至少 24 个字符的随机值，手机 App 也填写同一个值。
- `MCP_ACCESS_KEY`：另一段至少 24 个字符的随机值，只用于保护 MCP 地址。

两段值必须不同，不得写进 GitHub、截图或聊天。

## 手机配置

- 服务器地址：`https://你的-worker名称.你的子域.workers.dev`
- Token：`LINJIAN_TOKEN` 的值
- 设备 ID：`android-phone`
- 轮询间隔：`10000`（当前 App 设置页允许的最大值）

## ChatGPT MCP 地址

```text
https://你的-worker名称.你的子域.workers.dev/mcp/你的MCP_ACCESS_KEY
```

这个完整地址相当于密钥，不得截图、转发或公开。

## 安全范围

Cloudflare 版仍然只暴露以下六个工具：

- `linjian_status`
- `get_life_state`
- `send_notification`
- `set_alarm`
- `get_guidian_state`
- `trigger_guidian`

状态使用 SQLite-backed Durable Object 保存。不会上传屏幕文字、截图、无障碍节点、
经期、城市天气或常用 App 排名，也不提供点击、滑动、输入文字、自动评论或打开 App。
