import type { ProviderOnboardingCapabilities } from "@nyxara/provider-sdk";

export type ProviderAdapterType =
  | "codex-cli"
  | "claude-code-cli"
  | "gemini-cli"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "ollama"
  | "lm-studio"
  | "local-openai-compatible";

export interface ProviderDefinition {
  /** Stable catalog identity. Transport and product identity are intentionally separate. */
  readonly id: string;
  readonly type: ProviderAdapterType;
  readonly displayName: string;
  readonly description: string;
  readonly popular?: boolean;
  readonly iconKey: string;
  readonly onboarding: ProviderOnboardingCapabilities;
  readonly cli?: {
    readonly command: string;
    readonly loginCommand: readonly string[];
    readonly accountLabel: string;
    readonly installUrl: string;
  };
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  {
    id: "codex-cli",
    type: "codex-cli",
    displayName: "OpenAI Codex (ChatGPT)",
    description: "ChatGPT Subscription",
    popular: true,
    iconKey: "CX",
    onboarding: { category: "official", authMethods: ["oauth"], modelDiscovery: true, manualModelId: true },
    cli: { command: "codex", loginCommand: ["codex", "login"], accountLabel: "ChatGPT", installUrl: "https://developers.openai.com/codex/cli" },
  },
  {
    id: "claude-code-cli",
    type: "claude-code-cli",
    displayName: "Claude Code (Claude account)",
    description: "Claude Subscription",
    popular: true,
    iconKey: "CC",
    onboarding: { category: "official", authMethods: ["oauth"], modelDiscovery: true, manualModelId: true },
    cli: { command: "claude", loginCommand: ["claude", "auth", "login"], accountLabel: "Claude", installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup" },
  },
  {
    id: "gemini-cli",
    type: "gemini-cli",
    displayName: "Gemini CLI (Google account)",
    description: "Google Account",
    popular: true,
    iconKey: "GC",
    onboarding: { category: "official", authMethods: ["oauth"], modelDiscovery: true, manualModelId: true },
    cli: { command: "gemini", loginCommand: ["gemini"], accountLabel: "Google", installUrl: "https://www.geminicli.com/docs/get-started/installation" },
  },
  {
    id: "openai",
    type: "openai",
    displayName: "OpenAI",
    description: "Official Provider",
    popular: true,
    iconKey: "O",
    onboarding: { category: "official", authMethods: ["api_key"], defaultEndpoint: "https://api.openai.com/v1", modelDiscovery: true, manualModelId: true, apiKeyHelpUrl: "https://platform.openai.com/api-keys" },
  },
  {
    id: "anthropic",
    type: "anthropic",
    displayName: "Anthropic / Claude",
    description: "Official Provider",
    popular: true,
    iconKey: "C",
    onboarding: { category: "official", authMethods: ["api_key"], defaultEndpoint: "https://api.anthropic.com", modelDiscovery: true, manualModelId: true, apiKeyHelpUrl: "https://console.anthropic.com/settings/keys" },
  },
  {
    id: "gemini",
    type: "gemini",
    displayName: "Google Gemini",
    description: "Official Provider",
    popular: true,
    iconKey: "G",
    onboarding: { category: "official", authMethods: ["api_key"], defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", modelDiscovery: true, manualModelId: true, apiKeyHelpUrl: "https://aistudio.google.com/app/apikey" },
  },
  {
    id: "kimi", type: "openai-compatible", displayName: "Kimi", description: "Compatible Provider", iconKey: "K",
    onboarding: { category: "compatible", authMethods: ["api_key"], defaultEndpoint: "https://api.moonshot.ai/v1", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "deepseek", type: "openai-compatible", displayName: "DeepSeek", description: "Compatible Provider", iconKey: "D",
    onboarding: { category: "compatible", authMethods: ["api_key"], defaultEndpoint: "https://api.deepseek.com", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "glm", type: "openai-compatible", displayName: "GLM / Zhipu", description: "Compatible Provider", iconKey: "G",
    onboarding: { category: "compatible", authMethods: ["api_key"], defaultEndpoint: "https://open.bigmodel.cn/api/paas/v4", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "openrouter", type: "openai-compatible", displayName: "OpenRouter", description: "Compatible Provider", iconKey: "OR",
    onboarding: { category: "compatible", authMethods: ["api_key"], defaultEndpoint: "https://openrouter.ai/api/v1", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "openai-compatible",
    type: "openai-compatible",
    displayName: "Custom OpenAI-compatible",
    description: "Compatible Gateway",
    iconKey: "CG",
    onboarding: { category: "compatible", authMethods: ["api_key", "none"], modelDiscovery: true, manualModelId: true },
  },
  {
    id: "ollama",
    type: "ollama",
    displayName: "Ollama",
    description: "Local Provider",
    iconKey: "OL",
    onboarding: { category: "local", authMethods: ["local", "none"], defaultEndpoint: "http://localhost:11434/v1", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "lm-studio",
    type: "lm-studio",
    displayName: "LM Studio",
    description: "Local Provider",
    iconKey: "LM",
    onboarding: { category: "local", authMethods: ["local", "none"], defaultEndpoint: "http://localhost:1234/v1", modelDiscovery: true, manualModelId: true },
  },
  {
    id: "local-openai-compatible",
    type: "local-openai-compatible",
    displayName: "Local OpenAI-compatible",
    description: "Local Provider",
    iconKey: "L",
    onboarding: { category: "local", authMethods: ["local", "api_key", "none"], modelDiscovery: true, manualModelId: true },
  },
]);

export function providerDefinition(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === id)
    ?? PROVIDER_DEFINITIONS.find((candidate) => candidate.type === id);
  if (!definition) throw new Error(`Unsupported provider: ${id}`);
  return definition;
}
