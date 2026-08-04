import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const VERSION = "0.3.5.1-safe.2";
const DEFAULT_DEVICE = "android-phone";
const MAX_COMMANDS = 50;
const SAFE_ACTIONS = new Set([
  "send_notification",
  "set_alarm",
  "get_guidian_state",
  "trigger_guidian",
]);

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function notFound() {
  return json({ ok: false, error: "not_found" }, 404);
}

function deviceFrom(url) {
  return url.searchParams.get("device_id") || DEFAULT_DEVICE;
}

function makeCommand(input = {}) {
  const action = SAFE_ACTIONS.has(input.action) ? input.action : "noop";
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  return {
    id: crypto.randomUUID(),
    device_id: input.device_id || DEFAULT_DEVICE,
    action,
    payload,
    status: "pending",
    created_at: new Date().toISOString(),
    dispatched_at: null,
    completed_at: null,
    result: "",
    ...payload,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export class PhoneState {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/state") {
      const data = await readJson(request);
      const deviceId = data.device_id || DEFAULT_DEVICE;
      data.updated_at = new Date().toISOString();
      await this.ctx.storage.put(`state:${deviceId}`, data);
      return json({ ok: true, device_id: deviceId });
    }

    if (request.method === "GET" && path === "/state") {
      const deviceId = deviceFrom(url);
      const state = (await this.ctx.storage.get(`state:${deviceId}`)) || null;
      return json({ ok: true, device_id: deviceId, state, life_state: state });
    }

    if (request.method === "GET" && path === "/guidian") {
      const deviceId = deviceFrom(url);
      const state = (await this.ctx.storage.get(`state:${deviceId}`)) || {};
      return json({
        ok: true,
        device_id: deviceId,
        guidian_state: state.guidian_state || {},
      });
    }

    if (request.method === "POST" && path === "/command") {
      const command = makeCommand(await readJson(request));
      const commands = (await this.ctx.storage.get("commands")) || [];
      commands.push(command);
      await this.ctx.storage.put("commands", commands.slice(-MAX_COMMANDS));
      await this.ctx.storage.put(`command:${command.id}`, command);
      return json({ ok: true, command });
    }

    if (request.method === "GET" && path === "/poll") {
      const deviceId = deviceFrom(url);
      const commands = (await this.ctx.storage.get("commands")) || [];
      const index = commands.findIndex(
        (item) => item.device_id === deviceId && item.status === "pending",
      );
      if (index < 0) return json({ ok: true, command: null });
      const [command] = commands.splice(index, 1);
      command.status = "dispatched";
      command.dispatched_at = new Date().toISOString();
      await this.ctx.storage.put("commands", commands);
      await this.ctx.storage.put(`command:${command.id}`, command);
      return json({ ok: true, command });
    }

    if (request.method === "POST" && path === "/report") {
      const report = await readJson(request);
      const commandId = report.command_id || report.id || "";
      const command = commandId
        ? await this.ctx.storage.get(`command:${commandId}`)
        : null;
      if (command) {
        command.status = report.ok ? "completed" : "failed";
        command.completed_at = new Date().toISOString();
        command.result = report.result || "";
        command.report = report;
        await this.ctx.storage.put(`command:${commandId}`, command);
      }
      return json({ ok: true, report, command });
    }

    if (request.method === "GET" && path === "/command-status") {
      const id = url.searchParams.get("id") || "";
      const command = id ? await this.ctx.storage.get(`command:${id}`) : null;
      return json({ ok: Boolean(command), command: command || null });
    }

    return notFound();
  }
}

function phoneStub(env) {
  const id = env.PHONE_STATE.idFromName("primary");
  return env.PHONE_STATE.get(id);
}

async function phoneFetch(env, path, options = {}) {
  const request = new Request(`https://phone.internal${path}`, options);
  return phoneStub(env).fetch(request);
}

async function postCommand(env, payload) {
  const response = await phoneFetch(env, "/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function waitCommand(env, id, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const response = await phoneFetch(
      env,
      `/command-status?id=${encodeURIComponent(id)}`,
    );
    last = await response.json();
    const status = last?.command?.status;
    if (status === "completed" || status === "failed") return last;
  }
  return last;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function makeMcpServer(env) {
  const server = new McpServer({
    name: "掌心窗·安全轻量版",
    version: VERSION,
  });

  server.tool(
    "linjian_status",
    "检查掌心窗安全版是否在线。不会读取屏幕或触发手机动作。",
    {},
    async () =>
      textResult({
        ok: true,
        service: "zhangxinchuang-safe-worker",
        version: VERSION,
        device_id: DEFAULT_DEVICE,
      }),
  );

  server.tool(
    "get_life_state",
    "读取用户主动共享的轻量手机状态：时间、电量、充电、网络、屏幕开关、当前 App、今日屏幕时间与解锁次数。不会返回屏幕文字、无障碍节点或截图。",
    { device_id: z.string().default(DEFAULT_DEVICE) },
    async ({ device_id = DEFAULT_DEVICE }) => {
      const response = await phoneFetch(
        env,
        `/state?device_id=${encodeURIComponent(device_id)}`,
      );
      const payload = await response.json();
      const raw = payload.life_state || payload.state || {};
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
      return textResult({ ok: true, device_id, state });
    },
  );

  server.tool(
    "send_notification",
    "按用户明确要求给其本人手机发送一条系统通知。不要自行连续发送。",
    {
      title: z.string().max(80).default("掌心窗提醒"),
      message: z.string().max(500),
      device_id: z.string().default(DEFAULT_DEVICE),
    },
    async ({ title = "掌心窗提醒", message, device_id = DEFAULT_DEVICE }) => {
      const result = await postCommand(env, {
        action: "send_notification",
        device_id,
        payload: { title, message },
      });
      return textResult({ queued: true, result });
    },
  );

  server.tool(
    "set_alarm",
    "仅在用户明确给出时间并要求设置时，为其本人手机设置系统闹钟。",
    {
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      message: z.string().max(120).default("掌心窗闹钟"),
      vibrate: z.boolean().default(true),
      device_id: z.string().default(DEFAULT_DEVICE),
    },
    async ({
      hour,
      minute,
      message = "掌心窗闹钟",
      vibrate = true,
      device_id = DEFAULT_DEVICE,
    }) => {
      const result = await postCommand(env, {
        action: "set_alarm",
        device_id,
        payload: { hour, minute, message, vibrate, skip_ui: true },
      });
      return textResult({ queued: true, result });
    },
  );

  server.tool(
    "get_guidian_state",
    "读取用户主动配置的归电状态。不会截图或打开 App。",
    { device_id: z.string().default(DEFAULT_DEVICE) },
    async ({ device_id = DEFAULT_DEVICE }) => {
      const response = await phoneFetch(
        env,
        `/guidian?device_id=${encodeURIComponent(device_id)}`,
      );
      return textResult(await response.json());
    },
  );

  server.tool(
    "trigger_guidian",
    "仅在用户明确要求时触发一次归电提醒页。",
    {
      device_id: z.string().default(DEFAULT_DEVICE),
      wait_seconds: z.number().int().min(3).max(20).default(8),
    },
    async ({ device_id = DEFAULT_DEVICE, wait_seconds = 8 }) => {
      const result = await postCommand(env, {
        action: "trigger_guidian",
        device_id,
        payload: {},
      });
      const id = result?.command?.id;
      const observed = id ? await waitCommand(env, id, wait_seconds) : null;
      return textResult({
        queued: result,
        observed_status: observed?.command || null,
      });
    },
  );

  return server;
}

function tokenOk(request, env) {
  const supplied = request.headers.get("X-Auth-Token") || "";
  return Boolean(env.LINJIAN_TOKEN) && supplied === env.LINJIAN_TOKEN;
}

function configOk(env) {
  return (
    typeof env.LINJIAN_TOKEN === "string" &&
    env.LINJIAN_TOKEN.length >= 24 &&
    typeof env.MCP_ACCESS_KEY === "string" &&
    env.MCP_ACCESS_KEY.length >= 24
  );
}

async function handleApi(request, env) {
  if (!tokenOk(request, env)) {
    return json({ ok: false, error: "LINJIAN_ERR_BAD_TOKEN" }, 403);
  }

  const url = new URL(request.url);
  const suffix = url.search;
  const routes = {
    "/api/device/state": "/state",
    "/api/life_state": "/state",
    "/api/guidian_state": "/guidian",
    "/api/poll": "/poll",
    "/api/command": "/command",
    "/api/device/report": "/report",
    "/api/command/status": "/command-status",
  };
  const internalPath = routes[url.pathname];
  if (!internalPath) return notFound();
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  return phoneFetch(env, `${internalPath}${suffix}`, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") || "application/json" },
    body,
  });
}

async function handleMcp(request, env) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = makeMcpServer(env);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers":
            "content-type, x-auth-token, mcp-protocol-version, mcp-session-id, last-event-id",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: configOk(env),
        service: "zhangxinchuang-safe-worker",
        name: "掌心窗",
        version: VERSION,
        configured: configOk(env),
      });
    }

    if (url.pathname === "/api/update.json" || url.pathname === "/update.json") {
      return json({
        ok: true,
        latest_version_name: "0.3.5.1",
        latest_version_code: 30501,
        apk_url: "",
        required: false,
        changelog: ["掌心窗安全轻量版"],
      });
    }

    if (!configOk(env)) {
      return json({ ok: false, error: "server_not_configured" }, 503);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    const mcpPrefix = "/mcp/";
    if (url.pathname.startsWith(mcpPrefix)) {
      const accessKey = decodeURIComponent(url.pathname.slice(mcpPrefix.length));
      if (!accessKey || accessKey !== env.MCP_ACCESS_KEY) return notFound();
      return handleMcp(request, env);
    }

    return notFound();
  },
};
