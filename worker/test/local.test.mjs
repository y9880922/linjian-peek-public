import assert from "node:assert/strict";
import test from "node:test";

import worker, { PhoneState } from "../src/index.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class PhoneNamespace {
  constructor() {
    this.instance = new PhoneState({ storage: new MemoryStorage() });
  }
  idFromName(name) {
    return name;
  }
  get() {
    return { fetch: (request) => this.instance.fetch(request) };
  }
}

function makeEnv() {
  return {
    PHONE_STATE: new PhoneNamespace(),
    LINJIAN_TOKEN: "test-linjian-token-1234567890",
    MCP_ACCESS_KEY: "test-mcp-access-key-1234567890",
  };
}

function apiRequest(path, token, init = {}) {
  return new Request(`https://unit.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "X-Auth-Token": token,
      ...(init.headers || {}),
    },
  });
}

test("rejects a wrong phone token", async () => {
  const env = makeEnv();
  const response = await worker.fetch(apiRequest("/api/life_state", "wrong"), env);
  assert.equal(response.status, 403);
});

test("stores a safe phone state and reads it back", async () => {
  const env = makeEnv();
  const state = {
    device_id: "android-phone",
    battery_percent: 80,
    charging: true,
    current_app: "ChatGPT",
  };
  const saved = await worker.fetch(
    apiRequest("/api/device/state", env.LINJIAN_TOKEN, {
      method: "POST",
      body: JSON.stringify(state),
    }),
    env,
  );
  assert.equal(saved.status, 200);

  const response = await worker.fetch(
    apiRequest("/api/life_state?device_id=android-phone", env.LINJIAN_TOKEN),
    env,
  );
  const payload = await response.json();
  assert.equal(payload.life_state.battery_percent, 80);
  assert.equal(payload.life_state.current_app, "ChatGPT");
});

test("queues, polls, and completes an allowed command", async () => {
  const env = makeEnv();
  const queuedResponse = await worker.fetch(
    apiRequest("/api/command", env.LINJIAN_TOKEN, {
      method: "POST",
      body: JSON.stringify({
        action: "send_notification",
        device_id: "android-phone",
        payload: { title: "test", message: "hello" },
      }),
    }),
    env,
  );
  const queued = await queuedResponse.json();
  assert.equal(queued.command.action, "send_notification");

  const pollResponse = await worker.fetch(
    apiRequest("/api/poll?device_id=android-phone", env.LINJIAN_TOKEN),
    env,
  );
  const polled = await pollResponse.json();
  assert.equal(polled.command.message, "hello");

  await worker.fetch(
    apiRequest("/api/device/report", env.LINJIAN_TOKEN, {
      method: "POST",
      body: JSON.stringify({
        command_id: queued.command.id,
        ok: true,
        result: "shown",
      }),
    }),
    env,
  );

  const statusResponse = await worker.fetch(
    apiRequest(
      `/api/command/status?id=${encodeURIComponent(queued.command.id)}`,
      env.LINJIAN_TOKEN,
    ),
    env,
  );
  const status = await statusResponse.json();
  assert.equal(status.command.status, "completed");
});

test("protects MCP and exposes only six tools", async () => {
  const env = makeEnv();
  const wrong = await worker.fetch(
    new Request("https://unit.test/mcp/wrong", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    }),
    env,
  );
  assert.equal(wrong.status, 404);

  const list = await worker.fetch(
    new Request(`https://unit.test/mcp/${env.MCP_ACCESS_KEY}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    env,
  );
  assert.equal(list.status, 200);
  const payload = await list.json();
  assert.deepEqual(
    payload.result.tools.map((tool) => tool.name).sort(),
    [
      "get_guidian_state",
      "get_life_state",
      "linjian_status",
      "send_notification",
      "set_alarm",
      "trigger_guidian",
    ],
  );
});
