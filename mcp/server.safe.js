import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 8787);
const LINJIAN_URL = (process.env.LINJIAN_URL || "").replace(/\/$/, "");
const LINJIAN_TOKEN = process.env.LINJIAN_TOKEN || "";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";
const DEFAULT_DEVICE = process.env.LINJIAN_DEFAULT_DEVICE || "android-phone";

function requireConfig() {
  if (!LINJIAN_URL) throw new Error("Missing env LINJIAN_URL");
  if (!LINJIAN_TOKEN) throw new Error("Missing env LINJIAN_TOKEN");
  if (MCP_ACCESS_KEY.length < 24) throw new Error("MCP_ACCESS_KEY must contain at least 24 characters");
}

async function linjianFetch(path, options = {}) {
  requireConfig();
  const res = await fetch(`${LINJIAN_URL}${path}`, {
    ...options,
    headers: { "X-Auth-Token": LINJIAN_TOKEN, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linjian server HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res;
}

async function postCommand(payload) {
  const res = await linjianFetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function waitCommand(id, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const res = await linjianFetch(`/api/command/status?id=${encodeURIComponent(id)}`);
    last = await res.json();
    const status = last?.command?.status;
    if (status === "completed" || status === "failed") return last;
  }
  return last;
}

function makeServer() {
  const server = new McpServer({ name: "掌心窗·安全轻量版", version: "0.3.5.1-safe.1" });

  server.tool("linjian_status", "检查掌心窗安全版后端是否在线。不会读取屏幕或触发手机动作。", {}, async () => {
    requireConfig();
    const health = await fetch(`${LINJIAN_URL}/health`).then((r) => r.json());
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, health, device_id: DEFAULT_DEVICE }, null, 2) }] };
  });

  server.tool("get_life_state", "读取用户主动共享的轻量手机状态：时间、电量、充电、网络、屏幕开关、当前 App、今日屏幕时间与解锁次数。不会返回屏幕文字、无障碍节点或截图。", {
    device_id: z.string().default(DEFAULT_DEVICE),
  }, async ({ device_id = DEFAULT_DEVICE }) => {
    const res = await linjianFetch(`/api/life_state?device_id=${encodeURIComponent(device_id)}`);
    const payload = await res.json();
    const raw = payload?.life_state || payload?.state || {};
    const state = {
      local_time: raw.local_time,
      local_date: raw.local_date,
      timezone: raw.timezone,
      updated_at_local: raw.updated_at_local,
      battery_percent: raw.battery_percent,
      charging: raw.charging,
      charging_type: raw.charging_type,
      network_type: raw.network_type,
      screen_on: raw.screen_on,
      current_app: raw.current_app,
      screen_time_today_minutes: raw.screen_time_today_minutes,
      unlock_count_today: raw.unlock_count_today,
      accessibility_ready: raw.accessibility_ready,
      guidian_state: raw.guidian_state,
    };
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, device_id, state }, null, 2) }] };
  });

  server.tool("send_notification", "按用户明确要求给其本人手机发送一条系统通知。不要自行连续发送。", {
    title: z.string().max(80).default("掌心窗提醒"),
    message: z.string().max(500),
    device_id: z.string().default(DEFAULT_DEVICE),
  }, async ({ title = "掌心窗提醒", message, device_id = DEFAULT_DEVICE }) => {
    const result = await postCommand({ action: "send_notification", device_id, payload: { title, message } });
    return { content: [{ type: "text", text: JSON.stringify({ queued: true, result }, null, 2) }] };
  });

  server.tool("set_alarm", "仅在用户明确给出时间并要求设置时，为其本人手机设置系统闹钟。", {
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    message: z.string().max(120).default("掌心窗闹钟"),
    vibrate: z.boolean().default(true),
    device_id: z.string().default(DEFAULT_DEVICE),
  }, async ({ hour, minute, message = "掌心窗闹钟", vibrate = true, device_id = DEFAULT_DEVICE }) => {
    const result = await postCommand({ action: "set_alarm", device_id, payload: { hour, minute, message, vibrate, skip_ui: true } });
    return { content: [{ type: "text", text: JSON.stringify({ queued: true, result }, null, 2) }] };
  });

  server.tool("get_guidian_state", "读取用户主动配置的归电状态。不会截图或打开 App。", {
    device_id: z.string().default(DEFAULT_DEVICE),
  }, async ({ device_id = DEFAULT_DEVICE }) => {
    const res = await linjianFetch(`/api/guidian_state?device_id=${encodeURIComponent(device_id)}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("trigger_guidian", "仅在用户明确要求时触发一次归电提醒页。", {
    device_id: z.string().default(DEFAULT_DEVICE),
    wait_seconds: z.number().int().min(3).max(20).default(8),
  }, async ({ device_id = DEFAULT_DEVICE, wait_seconds = 8 }) => {
    const result = await postCommand({ action: "trigger_guidian", device_id, payload: {} });
    const id = result?.command?.id;
    const observed = id ? await waitCommand(id, wait_seconds) : null;
    return { content: [{ type: "text", text: JSON.stringify({ queued: result, observed_status: observed?.command || null }, null, 2) }] };
  });

  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.type("text/plain").send("掌心窗安全轻量版正在运行。"));
app.get("/health", (_req, res) => res.json({ ok: true, service: "linjian-safe-mcp", version: "0.3.5.1-safe.1" }));

app.post("/mcp/:accessKey", async (req, res) => {
  if (!MCP_ACCESS_KEY || req.params.accessKey !== MCP_ACCESS_KEY) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal_error" }, id: null });
  }
});

app.all("/mcp", (_req, res) => res.status(404).json({ ok: false, error: "not_found" }));

app.listen(PORT, "0.0.0.0", () => {
  requireConfig();
  console.log(`掌心窗安全轻量版 listening on 0.0.0.0:${PORT}`);
});
