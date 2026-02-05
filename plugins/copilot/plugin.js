(function () {
  const KEYCHAIN_SERVICE = "OpenUsage-copilot";
  const GH_KEYCHAIN_SERVICE = "gh:github.com";
  const USAGE_URL = "https://api.github.com/copilot_internal/user";
  const DEVICE_CODE_URL = "https://github.com/login/device/code";
  const DEVICE_POLL_URL = "https://github.com/login/oauth/access_token";
  const CLIENT_ID = "Iv1.b507a08c87ecfe98";
  const SCOPES = "read:user";

  function readJson(ctx, path) {
    try {
      if (!ctx.host.fs.exists(path)) return null;
      const text = ctx.host.fs.readText(path);
      return ctx.util.tryParseJson(text);
    } catch (e) {
      ctx.host.log.warn("readJson failed for " + path + ": " + String(e));
      return null;
    }
  }

  function writeJson(ctx, path, value) {
    try {
      ctx.host.fs.writeText(path, JSON.stringify(value));
    } catch (e) {
      ctx.host.log.warn("writeJson failed for " + path + ": " + String(e));
    }
  }

  function saveToken(ctx, token) {
    try {
      ctx.host.keychain.writeGenericPassword(
        KEYCHAIN_SERVICE,
        JSON.stringify({ token: token }),
      );
    } catch (e) {
      ctx.host.log.warn("keychain write failed: " + String(e));
    }
    writeJson(ctx, ctx.app.pluginDataDir + "/auth.json", { token: token });
  }

  function loadTokenFromKeychain(ctx) {
    try {
      const raw = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE);
      if (raw) {
        const parsed = ctx.util.tryParseJson(raw);
        if (parsed && parsed.token) {
          ctx.host.log.info("token loaded from OpenUsage keychain");
          return { token: parsed.token, source: "keychain" };
        }
      }
    } catch (e) {
      ctx.host.log.info("OpenUsage keychain read failed: " + String(e));
    }
    return null;
  }

  function loadTokenFromGhCli(ctx) {
    try {
      const raw = ctx.host.keychain.readGenericPassword(GH_KEYCHAIN_SERVICE);
      if (raw) {
        let token = raw;
        if (
          typeof token === "string" &&
          token.indexOf("go-keyring-base64:") === 0
        ) {
          token = ctx.base64.decode(token.slice("go-keyring-base64:".length));
        }
        if (token) {
          ctx.host.log.info("token loaded from gh CLI keychain");
          return { token: token, source: "gh-cli" };
        }
      }
    } catch (e) {
      ctx.host.log.info("gh CLI keychain read failed: " + String(e));
    }
    return null;
  }

  function loadTokenFromStateFile(ctx) {
    const data = readJson(ctx, ctx.app.pluginDataDir + "/auth.json");
    if (data && data.token) {
      ctx.host.log.info("token loaded from state file");
      return { token: data.token, source: "state" };
    }
    return null;
  }

  function loadToken(ctx) {
    return (
      loadTokenFromKeychain(ctx) ||
      loadTokenFromGhCli(ctx) ||
      loadTokenFromStateFile(ctx)
    );
  }

  function fetchUsage(ctx, token) {
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers: {
        Authorization: "token " + token,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
      timeoutMs: 10000,
    });
  }

  function startDeviceFlow(ctx) {
    let resp;
    try {
      resp = ctx.util.request({
        method: "POST",
        url: DEVICE_CODE_URL,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        bodyText: "client_id=" + CLIENT_ID + "&scope=" + SCOPES,
        timeoutMs: 15000,
      });
    } catch (e) {
      ctx.host.log.error("device flow start failed: " + String(e));
      throw "Usage request failed. Check your connection.";
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.error("device flow start HTTP " + resp.status);
      throw (
        "Usage request failed (HTTP " +
        String(resp.status) +
        "). Try again later."
      );
    }

    const data = ctx.util.tryParseJson(resp.bodyText);
    if (!data || !data.device_code || !data.user_code) {
      ctx.host.log.error("device flow start: invalid response");
      throw "Usage response invalid. Try again later.";
    }

    writeJson(ctx, ctx.app.pluginDataDir + "/device_flow.json", {
      device_code: data.device_code,
      user_code: data.user_code,
      expires_at: Date.now() + (data.expires_in || 900) * 1000,
      interval: data.interval || 5,
    });

    throw "Visit github.com/login/device and enter: " + data.user_code;
  }

  function pollDeviceFlow(ctx, state) {
    let resp;
    try {
      resp = ctx.util.request({
        method: "POST",
        url: DEVICE_POLL_URL,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        bodyText:
          "client_id=" +
          CLIENT_ID +
          "&device_code=" +
          state.device_code +
          "&grant_type=urn:ietf:params:oauth:grant-type:device_code",
        timeoutMs: 15000,
      });
    } catch (e) {
      ctx.host.log.error("device flow poll failed: " + String(e));
      throw "Visit github.com/login/device and enter: " + state.user_code;
    }

    const data = ctx.util.tryParseJson(resp.bodyText);
    if (!data) {
      throw "Visit github.com/login/device and enter: " + state.user_code;
    }

    if (data.error === "authorization_pending" || data.error === "slow_down") {
      throw "Visit github.com/login/device and enter: " + state.user_code;
    }

    if (data.error === "expired_token") {
      writeJson(ctx, ctx.app.pluginDataDir + "/device_flow.json", null);
      throw "Code expired. Refresh to try again.";
    }

    if (data.error) {
      writeJson(ctx, ctx.app.pluginDataDir + "/device_flow.json", null);
      throw "Token invalid. Refresh to sign in again.";
    }

    if (data.access_token) {
      saveToken(ctx, data.access_token);
      writeJson(ctx, ctx.app.pluginDataDir + "/device_flow.json", null);
      return data.access_token;
    }

    throw "Visit github.com/login/device and enter: " + state.user_code;
  }

  function handleDeviceFlow(ctx) {
    const state = readJson(ctx, ctx.app.pluginDataDir + "/device_flow.json");
    if (state && state.device_code && state.user_code) {
      if (state.expires_at && Date.now() > state.expires_at) {
        writeJson(ctx, ctx.app.pluginDataDir + "/device_flow.json", null);
        throw "Code expired. Refresh to try again.";
      }
      return pollDeviceFlow(ctx, state);
    }
    return startDeviceFlow(ctx);
  }

  function makeProgressLine(ctx, label, snapshot, resetDate) {
    if (!snapshot || typeof snapshot.percent_remaining !== "number")
      return null;
    const usedPercent = Math.max(0, 100 - snapshot.percent_remaining);
    const line = ctx.line.progress({
      label: label,
      used: usedPercent,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: ctx.util.toIso(resetDate),
    });
    return line;
  }

  function probe(ctx) {
    const cred = loadToken(ctx);
    let token = cred ? cred.token : null;
    let source = cred ? cred.source : null;

    if (!token) {
      const flowToken = handleDeviceFlow(ctx);
      token = flowToken;
      source = "device";
    }

    let resp;
    try {
      resp = fetchUsage(ctx, token);
    } catch (e) {
      ctx.host.log.error("usage request exception: " + String(e));
      throw "Usage request failed. Check your connection.";
    }

    if (resp.status === 401 || resp.status === 403) {
      if (source === "gh-cli") {
        ctx.host.log.info(
          "gh-cli token returned " +
            resp.status +
            ", falling through to device flow",
        );
        const flowToken2 = handleDeviceFlow(ctx);
        token = flowToken2;
        try {
          resp = fetchUsage(ctx, token);
        } catch (e2) {
          ctx.host.log.error("usage retry exception: " + String(e2));
          throw "Usage request failed. Check your connection.";
        }
        if (resp.status === 401 || resp.status === 403) {
          throw "Token invalid. Refresh to sign in again.";
        }
      } else {
        throw "Token invalid. Refresh to sign in again.";
      }
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.error("usage returned error: status=" + resp.status);
      throw (
        "Usage request failed (HTTP " +
        String(resp.status) +
        "). Try again later."
      );
    }

    if (source === "gh-cli") {
      saveToken(ctx, token);
    }

    const data = ctx.util.tryParseJson(resp.bodyText);
    if (data === null) {
      throw "Usage response invalid. Try again later.";
    }

    ctx.host.log.info("usage fetch succeeded");

    const lines = [];
    let plan = null;
    if (data.copilot_plan) {
      plan = ctx.fmt.planLabel(data.copilot_plan);
    }

    const snapshots = data.quota_snapshots;
    if (snapshots) {
      const premiumLine = makeProgressLine(
        ctx,
        "Premium",
        snapshots.premium_interactions,
        data.quota_reset_date,
      );
      if (premiumLine) lines.push(premiumLine);

      const chatLine = makeProgressLine(
        ctx,
        "Chat",
        snapshots.chat,
        data.quota_reset_date,
      );
      if (chatLine) lines.push(chatLine);
    }

    if (lines.length === 0) {
      lines.push(
        ctx.line.badge({
          label: "Status",
          text: "No usage data",
          color: "#a3a3a3",
        }),
      );
    }

    return { plan: plan, lines: lines };
  }

  globalThis.__openusage_plugin = { id: "copilot", probe };
})();
