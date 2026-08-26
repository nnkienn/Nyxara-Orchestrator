import {
  ProviderError,
  type CredentialStore,
} from "@nyxara/provider-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes discovered models without inventing metadata", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "plain-model" },
          {
            id: "described-model",
            name: "Described Model",
            context_window: 32_000,
            capabilities: { text: true, tools: false },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "gateway",
      baseUrl: "http://localhost:11434/v1/",
      fetch: fetchMock,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "plain-model",
        name: "plain-model",
        provider: "gateway",
      },
      {
        id: "described-model",
        name: "Described Model",
        provider: "gateway",
        contextWindow: 32_000,
        capabilities: { text: true, tools: false },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends a chat prompt and normalizes generated output", async () => {
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url, init) => {
      requestInit = init;
      return jsonResponse({
        id: "chat-1",
        model: "model-1-2026-01-01",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello from the model" },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "gateway",
      baseUrl: "http://localhost:8080/v1",
      apiKey: "test-key",
      fetch: fetchMock,
    });

    await expect(
      provider.generate({
        model: "model-1",
        prompt: "hello",
        responseFormat: "json",
      }),
    ).resolves.toEqual({
      id: "chat-1",
      provider: "gateway",
      model: "model-1-2026-01-01",
      text: "Hello from the model",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    });

    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer test-key",
    );
  });

  it("uses the credential abstraction without exposing secrets", async () => {
    const secret = "never-print-this-secret";
    const credentialStore: CredentialStore = {
      async get() {
        return secret;
      },
      async set() {},
      async delete() {},
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: `Rejected ${secret}` } }, 401),
    ) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      credentialStore,
      fetch: fetchMock,
    });

    let caught: unknown;
    try {
      await provider.listModels();
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code: "authentication_error" });
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("normalizes native tool calls and serializes tool results", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      if (requestBodies.length === 1) {
        return jsonResponse({
          model: "tool-model",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"src/index.ts"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      return jsonResponse({
        model: "tool-model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"status":"completed"}' },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ fetch: fetchMock });
    const tools = [
      {
        name: "read_file",
        description: "Read a workspace file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ] as const;

    const first = await provider.generate({
      model: "tool-model",
      prompt: "Execute one task",
      tools,
    });
    expect(first.toolCalls).toEqual([
      {
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/index.ts" },
      },
    ]);

    await provider.generate({
      model: "tool-model",
      prompt: "Execute one task",
      tools,
      conversation: [
        {
          role: "assistant",
          toolCalls: first.toolCalls,
        },
        {
          role: "tool",
          toolResult: {
            callId: "call-1",
            name: "read_file",
            result: { content: "export {};" },
          },
        },
      ],
    });

    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "user", content: "Execute one task" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "read_file",
                arguments: '{"path":"src/index.ts"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "read_file",
          content: '{"result":{"content":"export {};"}}',
        },
      ],
    });
  });

  it("returns invalid_response for malformed provider output", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{}] })) as unknown as
      typeof fetch;
    const provider = new OpenAICompatibleProvider({ fetch: fetchMock });

    await expect(provider.listModels()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
