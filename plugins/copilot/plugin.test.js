import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePluginTestContext } from "../test-helpers.js";

const loadPlugin = async () => {
  await import("./plugin.js");
  return globalThis.__openusage_plugin;
};

function makeUsageResponse(overrides = {}) {
  return {
    copilot_plan: "pro",
    quota_reset_date: "2099-01-15T00:00:00Z",
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: 80,
        entitlement: 300,
        remaining: 240,
        quota_id: "premium",
      },
      chat: {
        percent_remaining: 95,
        entitlement: 1000,
        remaining: 950,
        quota_id: "chat",
      },
    },
    ...overrides,
  };
}

function setKeychainToken(ctx, token) {
  ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
    if (service === "OpenUsage-copilot") return JSON.stringify({ token });
    return null;
  });
}

function setGhCliKeychain(ctx, value) {
  ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
    if (service === "gh:github.com") return value;
    return null;
  });
}

function setStateFileToken(ctx, token) {
  ctx.host.fs.writeText(
    ctx.app.pluginDataDir + "/auth.json",
    JSON.stringify({ token }),
  );
}

function mockUsageOk(ctx, body) {
  ctx.host.http.request.mockReturnValue({
    status: 200,
    bodyText: JSON.stringify(body || makeUsageResponse()),
  });
}

function setDeviceFlowState(ctx, state) {
  ctx.host.fs.writeText(
    ctx.app.pluginDataDir + "/device_flow.json",
    JSON.stringify(state),
  );
}

describe("copilot plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin;
    if (vi.resetModules) vi.resetModules();
  });

  it("loads token from OpenUsage keychain", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "ghu_keychain");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe("token ghu_keychain");
  });

  it("loads token from gh CLI keychain (plain)", async () => {
    const ctx = makePluginTestContext();
    setGhCliKeychain(ctx, "gho_plain_token");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe("token gho_plain_token");
  });

  it("loads token from gh CLI keychain (base64-encoded)", async () => {
    const ctx = makePluginTestContext();
    const encoded = ctx.base64.encode("gho_encoded_token");
    setGhCliKeychain(ctx, "go-keyring-base64:" + encoded);
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe("token gho_encoded_token");
  });

  it("loads token from state file", async () => {
    const ctx = makePluginTestContext();
    setStateFileToken(ctx, "ghu_state");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
  });

  it("prefers keychain over gh-cli", async () => {
    const ctx = makePluginTestContext();
    ctx.host.keychain.readGenericPassword.mockImplementation((service) => {
      if (service === "OpenUsage-copilot")
        return JSON.stringify({ token: "ghu_keychain" });
      if (service === "gh:github.com") return "gho_ghcli";
      return null;
    });
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe("token ghu_keychain");
  });

  it("prefers keychain over state file", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "ghu_keychain");
    setStateFileToken(ctx, "ghu_state");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe("token ghu_keychain");
  });

  it("starts device flow when no token found", async () => {
    const ctx = makePluginTestContext();
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        device_code: "dc_123",
        user_code: "ABCD-1234",
        expires_in: 900,
        interval: 5,
      }),
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Visit github.com/login/device and enter: ABCD-1234",
    );
  });

  it("polls device flow and returns usage on success", async () => {
    const ctx = makePluginTestContext();
    setDeviceFlowState(ctx, {
      device_code: "dc_123",
      user_code: "ABCD-1234",
      expires_at: Date.now() + 600000,
      interval: 5,
    });

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("access_token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: "ghu_new" }),
        };
      }
      return {
        status: 200,
        bodyText: JSON.stringify(makeUsageResponse()),
      };
    });

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalled();
  });

  it("throws pending badge while device flow authorization_pending", async () => {
    const ctx = makePluginTestContext();
    setDeviceFlowState(ctx, {
      device_code: "dc_123",
      user_code: "WXYZ-5678",
      expires_at: Date.now() + 600000,
      interval: 5,
    });
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ error: "authorization_pending" }),
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Visit github.com/login/device and enter: WXYZ-5678",
    );
  });

  it("throws expiry message when device code is expired_token", async () => {
    const ctx = makePluginTestContext();
    setDeviceFlowState(ctx, {
      device_code: "dc_123",
      user_code: "ABCD-1234",
      expires_at: Date.now() + 600000,
      interval: 5,
    });
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ error: "expired_token" }),
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Code expired. Refresh to try again.",
    );
  });

  it("throws expiry when device flow state has expired locally", async () => {
    const ctx = makePluginTestContext();
    setDeviceFlowState(ctx, {
      device_code: "dc_123",
      user_code: "ABCD-1234",
      expires_at: Date.now() - 1000,
      interval: 5,
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Code expired. Refresh to try again.",
    );
  });

  it("renders both Premium and Chat lines", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    const premium = result.lines.find((l) => l.label === "Premium");
    const chat = result.lines.find((l) => l.label === "Chat");
    expect(premium).toBeTruthy();
    expect(premium.used).toBe(20); // 100 - 80
    expect(premium.limit).toBe(100);
    expect(chat).toBeTruthy();
    expect(chat.used).toBe(5); // 100 - 95
  });

  it("renders only Premium when Chat is missing", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify(
        makeUsageResponse({
          quota_snapshots: {
            premium_interactions: {
              percent_remaining: 50,
              entitlement: 300,
              remaining: 150,
              quota_id: "premium",
            },
          },
        }),
      ),
    });
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
    expect(result.lines.find((l) => l.label === "Chat")).toBeFalsy();
  });

  it("shows 'No usage data' when both snapshots missing", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({ copilot_plan: "free" }),
    });
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines[0].text).toBe("No usage data");
  });

  it("returns plan label from copilot_plan", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.plan).toBe("Pro");
  });

  it("capitalizes multi-word plan labels", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify(
        makeUsageResponse({ copilot_plan: "business plus" }),
      ),
    });
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.plan).toBe("Business Plus");
  });

  it("propagates resetsAt from quota_reset_date", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    const premium = result.lines.find((l) => l.label === "Premium");
    expect(premium.resetsAt).toBe("2099-01-15T00:00:00.000Z");
  });

  it("omits resetsAt when quota_reset_date is missing", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify(
        makeUsageResponse({ quota_reset_date: undefined }),
      ),
    });
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    const premium = result.lines.find((l) => l.label === "Premium");
    expect(premium).toBeTruthy();
    expect(premium.resetsAt).toBeUndefined();
  });

  it("clamps usedPercent to 0 when percent_remaining > 100", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify(
        makeUsageResponse({
          quota_snapshots: {
            premium_interactions: {
              percent_remaining: 120,
              entitlement: 300,
              remaining: 360,
              quota_id: "premium",
            },
          },
        }),
      ),
    });
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium").used).toBe(0);
  });

  it("throws on 401 with keychain token", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({ status: 401, bodyText: "" });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Token invalid. Refresh to sign in again.",
    );
  });

  it("throws on 403 with keychain token", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({ status: 403, bodyText: "" });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Token invalid. Refresh to sign in again.",
    );
  });

  it("falls through to device flow on 401 with gh-cli token", async () => {
    const ctx = makePluginTestContext();
    setGhCliKeychain(ctx, "gho_tok");
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("copilot_internal")) {
        return { status: 401, bodyText: "" };
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          device_code: "dc_x",
          user_code: "FALL-BACK",
          expires_in: 900,
          interval: 5,
        }),
      };
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Visit github.com/login/device and enter: FALL-BACK",
    );
  });

  it("throws on HTTP 500", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({ status: 500, bodyText: "" });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Usage request failed (HTTP 500). Try again later.",
    );
  });

  it("throws on network error", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("ECONNREFUSED");
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Usage request failed. Check your connection.",
    );
  });

  it("throws on invalid JSON response", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: "not-json",
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow(
      "Usage response invalid. Try again later.",
    );
  });

  it("persists token from gh-cli to keychain and state file", async () => {
    const ctx = makePluginTestContext();
    setGhCliKeychain(ctx, "gho_persist");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalledWith(
      "OpenUsage-copilot",
      JSON.stringify({ token: "gho_persist" }),
    );
    const stateFile = ctx.host.fs.readText(
      ctx.app.pluginDataDir + "/auth.json",
    );
    expect(JSON.parse(stateFile).token).toBe("gho_persist");
  });

  it("saves token after device flow success", async () => {
    const ctx = makePluginTestContext();
    setDeviceFlowState(ctx, {
      device_code: "dc_save",
      user_code: "SAVE-1234",
      expires_at: Date.now() + 600000,
      interval: 5,
    });
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("access_token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: "ghu_saved" }),
        };
      }
      return { status: 200, bodyText: JSON.stringify(makeUsageResponse()) };
    });
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalledWith(
      "OpenUsage-copilot",
      JSON.stringify({ token: "ghu_saved" }),
    );
  });

  it("does not persist token loaded from OpenUsage keychain (already there)", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "ghu_already");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled();
  });

  it("does not persist token loaded from state file", async () => {
    const ctx = makePluginTestContext();
    setStateFileToken(ctx, "ghu_state");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.keychain.writeGenericPassword).not.toHaveBeenCalled();
  });

  it("handles graceful keychain write failure", async () => {
    const ctx = makePluginTestContext();
    setGhCliKeychain(ctx, "gho_tok");
    mockUsageOk(ctx);
    ctx.host.keychain.writeGenericPassword.mockImplementation(() => {
      throw new Error("keychain locked");
    });
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).not.toThrow();
    expect(ctx.host.log.warn).toHaveBeenCalled();
  });

  it("falls through to state file when keychain returns empty", async () => {
    const ctx = makePluginTestContext();
    setStateFileToken(ctx, "ghu_fallback");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines.find((l) => l.label === "Premium")).toBeTruthy();
  });

  it("uses 'token' auth header format (not 'Bearer')", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "ghu_format");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers.Authorization).toMatch(/^token /);
    expect(call.headers.Authorization).not.toMatch(/^Bearer /);
  });

  it("includes correct User-Agent and editor headers", async () => {
    const ctx = makePluginTestContext();
    setKeychainToken(ctx, "tok");
    mockUsageOk(ctx);
    const plugin = await loadPlugin();
    plugin.probe(ctx);
    const call = ctx.host.http.request.mock.calls[0][0];
    expect(call.headers["User-Agent"]).toBe("GitHubCopilotChat/0.26.7");
    expect(call.headers["Editor-Version"]).toBe("vscode/1.96.2");
    expect(call.headers["X-Github-Api-Version"]).toBe("2025-04-01");
  });
});
