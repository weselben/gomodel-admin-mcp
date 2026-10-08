import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startMock, startMcp } from "../tests/helpers.mjs";
import { isCredentialHeader } from "../src/playground.js";

/**
 * Playground tools (GOMODEL_PLAYGROUND=1): gating, header rules, user-path
 * resolution, dialect mapping, and the audit-log reassembly with its
 * direct-response fallbacks.
 */

describe("playground gating", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  beforeAll(async () => {
    mock = await startMock();
  });

  afterAll(async () => {
    await mock.close();
  });

  test("admin_playground is hidden by default (GOMODEL_PLAYGROUND unset)", async () => {
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
    try {
      const tools = await mcp.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("admin_playground");
      // Full mode without the gate keeps the previous tool count.
      expect(names).toHaveLength(23);
    } finally {
      await mcp.close();
    }
  });

  test("admin_playground registers with GOMODEL_PLAYGROUND=1", async () => {
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const tools = await mcp.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("admin_playground");
      expect(names).toHaveLength(24);
    } finally {
      await mcp.close();
    }
  });

  test("read-only mode hides send-capable playground only when gate off; context works with gate on", async () => {
    const mcp = await startMcp({
      GOMODEL_BASE_URL: mock.url,
      GOMODEL_PLAYGROUND: "1",
      GOMODEL_READ_ONLY: "1",
    });
    try {
      const tools = await mcp.listTools();
      expect(tools.map((t) => t.name)).toContain("admin_playground");

      // send is refused in read-only mode — surfaced through MCP's
      // isError channel (not as a JSON payload with error:).
      const send = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-provider/demo-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(send.isError).toBe(true);
      expect(send.text).toMatch(/GOMODEL_READ_ONLY/);
      // Nothing reached the public API.
      expect(mock.requests.has("POST /v1/chat/completions")).toBe(false);

      // context still works (read-only inspection).
      const context = await mcp.call("admin_playground", { operation: "context" });
      expect(context.isError).toBe(false);
      JSON.parse(context.text);
    } finally {
      await mcp.close();
    }
  });
});

describe("playground dispatch", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  beforeAll(async () => {
    mock = await startMock();
    mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
  });

  afterAll(async () => {
    await mcp.close();
    await mock.close();
  });

  test("no operation lists both ops", async () => {
    const result = await mcp.call("admin_playground");
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Operations of admin_playground:/);
    expect(result.text).toContain("context");
    expect(result.text).toContain("send");
  });

  test("unknown operation errors with the valid list", async () => {
    const result = await mcp.call("admin_playground", { operation: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown operation "nope"');
    expect(result.text).toContain("send");
  });

  test("context returns user-path header name, models, and virtual model policies", async () => {
    const result = await mcp.call("admin_playground", { operation: "context" });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text);
    expect(payload.user_path_header).toBe("X-GoModel-User-Path");
    expect(Array.isArray(payload.models)).toBe(true);
    expect(Array.isArray(payload.virtual_models)).toBe(true);
  });

  test("endpoint is required (field-level error)", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid params for send");
    expect(result.text).toContain("endpoint");
  });

  test("messages role validation: messages endpoint rejects system role with the allowed list", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "messages",
        model: "demo-model",
        messages: [
          { role: "system", content: "be good" },
          { role: "user", content: "hi" },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("messages.0.role");
    expect(result.text).toContain("user, assistant");
  });

  test("messages required for chat_completions", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: { endpoint: "chat_completions", model: "demo-model" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("messages");
    expect(result.text).toContain("required");
  });

  test("every credential header is rejected with a field-level error", () => {
    // Ported list — internal/core/credential_headers.go (10 names).
    const headers = [
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "api-key",
      "x-goog-api-key",
      "x-auth-token",
      "x-access-token",
      "x-gomodel-key",
    ];
    for (const name of headers) {
      expect(isCredentialHeader(name)).toBe(true);
      // Case-insensitive, whitespace-trimming like core.IsCredentialHeader.
      expect(isCredentialHeader(name.toUpperCase())).toBe(true);
      expect(isCredentialHeader(`  ${name} `)).toBe(true);
    }
    expect(isCredentialHeader("X-Session-Id")).toBe(false);
    expect(isCredentialHeader("X-Title")).toBe(false);
    expect(isCredentialHeader("anthropic-version")).toBe(false);
  });

  test("send rejects a caller-supplied Authorization header before any network call", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "chat_completions",
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        headers: { Authorization: "Bearer sk_evil" },
      },
    });
    // Rejected headers go through MCP's isError channel, not a JSON payload.
    expect(result.isError).toBe(true);
    expect(result.text).toContain("headers.Authorization");
    expect(result.text).toContain("rejected");
    // The secret never echoes and no request left the building.
    expect(result.text).not.toContain("sk_evil");
    expect(mock.requests.has("POST /v1/chat/completions")).toBe(false);
  });

  test("send rejects a credential header on a different dialect too", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "messages",
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        headers: { "X-Api-Key": "sk_evil" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("headers.X-Api-Key");
    expect(mock.requests.has("POST /v1/messages")).toBe(false);
  });

  test("send rejects the configured user-path header, pointing at the user_path param", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "chat_completions",
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        headers: { "X-GoModel-User-Path": "/acme" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("headers.X-GoModel-User-Path");
    expect(result.text).toContain("user_path");
    expect(mock.requests.has("POST /v1/chat/completions")).toBe(false);
  });

  test("send maps endpoint to the public path and forces Content-Type; audit reassembly returns one object", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "chat_completions",
        model: "demo-provider/demo-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
        temperature: 0.5,
      },
    });
    expect(result.isError).toBe(false);
    const sent = mock.requestBodies.findLast(
      (entry) => entry.method === "POST" && entry.path === "/v1/chat/completions",
    );
    expect(sent).toBeDefined();
    expect(sent!.body).toMatchObject({
      model: "demo-provider/demo-model",
      max_tokens: 64,
      temperature: 0.5,
    });
    expect(sent!.headers["content-type"]).toBe("application/json");
    expect(sent!.headers.authorization).toBe("Bearer sk_gom_test");

    // One audit-shaped object, byte-equivalent to the dashboard JSON panel.
    const payload = JSON.parse(result.text);
    expect(payload.source).toBe("audit");
    expect(typeof payload.audit_id).toBe("string");
    expect(payload.status).toBe(200);
    expect(payload.latency_ms).toBeCloseTo(1.5, 5);
    expect(payload.usage).toMatchObject({ input_tokens: 3 });
    expect(payload.request_body).toMatchObject({ model: "demo-provider/demo-model" });
    expect(payload.response_body.choices[0].message.content).toContain("demo-provider/demo-model");
    expect(payload.request_headers["Content-Type"]).toBe("application/json");
    expect(payload.request_headers.Authorization).toBe("[redacted]");
  });

  test("messages endpoint maps to /v1/messages with anthropic shape", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "messages",
        model: "demo-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(result.isError).toBe(false);
    expect(mock.requests.has("POST /v1/messages")).toBe(true);
    const payload = JSON.parse(result.text);
    expect(payload.source).toBe("audit");
    expect(payload.response_body.type).toBe("message");
  });

  test("user_path override is sent under the user-path header", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "chat_completions",
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        user_path: "/acme/override",
      },
    });
    expect(result.isError).toBe(false);
    const sent = mock.requestBodies.findLast(
      (entry) => entry.method === "POST" && entry.path === "/v1/chat/completions",
    );
    expect(sent!.headers["x-gomodel-user-path"]).toBe("/acme/override");
  });
});

describe("playground user-path auto-resolve and fallbacks", () => {
  test("virtual model with user_paths policy auto-sends the first entry; explicit user_path wins", async () => {
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      // Register a virtual model with a user_paths policy through the normal
      // write tool, so the mock's virtual-model list reflects it.
      const upsert = await mcp.call("admin_virtual_models", {
        operation: "upsert_virtual_model",
        params: {
          source: "policy-model",
          target_model: "demo-provider/demo-model",
          user_paths: ["/acme/first", "/acme/second"],
        },
      });
      expect(upsert.isError).toBe(false);

      // Auto-resolve: no user_path param -> first policy entry.
      const auto = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "policy-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(auto.isError).toBe(false);
      const autoSent = mock.requestBodies.findLast(
        (entry) => entry.method === "POST" && entry.path === "/v1/chat/completions",
      );
      expect(autoSent!.headers["x-gomodel-user-path"]).toBe("/acme/first");
      const autoPayload = JSON.parse(auto.text);
      expect(autoPayload.source).toBe("audit");
      expect(autoPayload.user_path).toBe("/acme/first");

      // Override: explicit user_path param wins over the policy prefill.
      const override = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "policy-model",
          messages: [{ role: "user", content: "hi" }],
          user_path: "/acme/other",
        },
      });
      expect(override.isError).toBe(false);
      const overrideSent = mock.requestBodies.findLast(
        (entry) => entry.method === "POST" && entry.path === "/v1/chat/completions",
      );
      expect(overrideSent!.headers["x-gomodel-user-path"]).toBe("/acme/other");
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test("stream=true assembles the SSE stream into the non-streaming shape", async () => {
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text);
      expect(payload.source).toBe("audit");
      const body = payload.response_body;
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toContain("demo-model");
      expect(body.usage).toMatchObject({ total_tokens: 8 });
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test("bodies absent from the audit entry (LOGGING_LOG_BODIES=false) fall back to source:direct", async () => {
    process.env.MOCK_PLAYGROUND_BODIES = "0";
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text);
      expect(payload.source).toBe("direct");
      expect(payload.warning).toContain("LOGGING_LOG_BODIES");
      expect(payload.response.choices[0].message.content).toContain("demo-model");
    } finally {
      delete process.env.MOCK_PLAYGROUND_BODIES;
      await mcp.close();
      await mock.close();
    }
  });

  test("audit entry not found in the window falls back to source:direct with a warning", async () => {
    process.env.MOCK_PLAYGROUND_AUDIT_MISS = "1";
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "miss-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text);
      expect(payload.source).toBe("direct");
      expect(payload.warning).toContain("audit entry");
      expect(payload.response.choices[0].message.content).toContain("miss-model");
    } finally {
      delete process.env.MOCK_PLAYGROUND_AUDIT_MISS;
      await mcp.close();
      await mock.close();
    }
  });
});

describe("playground responses dialect", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  beforeAll(async () => {
    mock = await startMock();
    mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
  });

  afterAll(async () => {
    await mcp.close();
    await mock.close();
  });

  test("maps messages -> input and max_tokens -> max_output_tokens on /v1/responses", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "responses",
        model: "demo-model",
        messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }],
        max_tokens: 64,
      },
    });
    expect(result.isError).toBe(false);
    const sent = mock.requestBodies.findLast(
      (entry) => entry.method === "POST" && entry.path === "/v1/responses",
    );
    expect(sent).toBeDefined();
    expect(sent!.body).toMatchObject({
      model: "demo-model",
      input: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      max_output_tokens: 64,
    });
    // `messages` and `max_tokens` must NOT appear on the responses wire.
    expect(sent!.body.messages).toBeUndefined();
    expect(sent!.body.max_tokens).toBeUndefined();
  });

  test("audit reassembly roundtrips a responses-shaped audit entry", async () => {
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "responses",
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text);
    expect(payload.source).toBe("audit");
    // The mock records an Anthropic-shaped response for /v1/messages and a
    // chat-completions-shaped one otherwise; the responses dialect should
    // surface whatever the gateway logged.
    expect(payload.response_body).toBeDefined();
    expect(payload.status).toBe(200);
  });

  test("rejects the 'tool' role on the responses dialect with the allowed list", async () => {
    const before = mock.requests.get("POST /v1/responses") ?? 0;
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "responses",
        model: "demo-model",
        messages: [{ role: "tool", content: "raw output" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("messages.0.role");
    expect(result.text).toContain("system, developer, user, assistant");
    // Schema-level validation rejects the call before any HTTP request.
    expect(mock.requests.get("POST /v1/responses") ?? 0).toBe(before);
  });

  test("the chat_completions and messages endpoints still allow tool/function roles", async () => {
    const before = mock.requests.get("POST /v1/chat/completions") ?? 0;
    const result = await mcp.call("admin_playground", {
      operation: "send",
      params: {
        endpoint: "chat_completions",
        model: "demo-model",
        messages: [{ role: "tool", content: "raw output" }],
      },
    });
    // chat_completions allows tool; the call succeeds and reaches the wire.
    expect(result.isError).toBe(false);
    expect(mock.requests.get("POST /v1/chat/completions") ?? 0).toBe(before + 1);
  });
});

describe("playground error-channel routing", () => {
  test("non-2xx public-API response is surfaced through isError, not as a JSON error field", async () => {
    process.env.MOCK_PUBLIC_FAULT = "POST /v1/chat/completions=400";
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("public API 400");
      expect(result.text).toContain("invalid_request_error");
    } finally {
      delete process.env.MOCK_PUBLIC_FAULT;
      await mcp.close();
      await mock.close();
    }
  });

  test("role validation on chat_completions is surfaced through isError", async () => {
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-model",
          messages: [{ role: "bogus", content: "hi" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("messages.0.role");
      expect(mock.requests.has("POST /v1/chat/completions")).toBe(false);
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test("audit-reassembly fallbacks stay successful with source:direct (not isError)", async () => {
    process.env.MOCK_PLAYGROUND_AUDIT_MISS = "1";
    const mock = await startMock();
    const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url, GOMODEL_PLAYGROUND: "1" });
    try {
      const result = await mcp.call("admin_playground", {
        operation: "send",
        params: {
          endpoint: "chat_completions",
          model: "demo-model",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text);
      expect(payload.source).toBe("direct");
      expect(payload.warning).toBeDefined();
    } finally {
      delete process.env.MOCK_PLAYGROUND_AUDIT_MISS;
      await mcp.close();
      await mock.close();
    }
  });
});
