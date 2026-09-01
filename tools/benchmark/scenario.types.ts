export type ProviderMode = "fake" | "real";
export type ScenarioStatus = "completed" | "failed" | "skipped" | "aborted";
export type WorkloadProfile = "light" | "normal" | "heavy" | "repair-heavy";
export type MetricSource = "real_core" | "synthetic_provider" | "real_provider" | "process_self" | "process_tree" | "extension_host" | "unavailable";
/** Single source of truth for report/CLI benchmark versioning. */
export const BENCHMARK_RUNNER_VERSION = "10B.2";

export interface BenchmarkConfig {
  warmupRuns: number;
  measuredRuns: number;
  sampleIntervalMs: number;
  idleDurationMs: number;
  stabilizationMs: number;
  longRunWorkflows: number;
  providerMode: ProviderMode;
  scenarios: string[];
  label?: string;
  repoPath: string;
  outputDir: string;
  seed: number;
  workloadProfile: WorkloadProfile;
  realistic: boolean;
  plannerProvider?: string;
  plannerModel?: string;
  executorProvider?: string;
  executorModel?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  yes?: boolean;
  quiet?: boolean;
  keepFixture?: boolean;
  matrixConfig?: string;
  /** Internal harness hook; never serialized into reports. */
  progress?: (message: string) => void;
  /** Optional injected adapters used by tests/embedders for real-provider dogfood. */
  realProvider?: BenchmarkRealProvider;
}

export interface BenchmarkProviderResponse {
  provider: string;
  model: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  structuredOutputValid?: boolean;
  toolCallSupported?: boolean;
  toolCallSucceeded?: boolean;
  invalidToolCalls?: number;
  toolCallCount?: number;
}

export interface BenchmarkRealProvider {
  generate(role: "planner" | "executor" | "reviewer" | "repair", input: { prompt: string; model: string; tools?: boolean; structured?: boolean }): Promise<BenchmarkProviderResponse>;
}

export interface NumericStats { min: number; max: number; mean: number; median: number; p95: number; stddev: number; count: number; }
export interface MemoryByPhase { planningPeakRssMb: number | null; executionPeakRssMb: number | null; validationPeakRssMb: number | null; reviewPeakRssMb: number | null; repairPeakRssMb: number | null; }
export interface MemorySummary { baselineRssMb: number | null; peakRssMb: number | null; finalRssMb: number | null; stabilizedRssMb?: number | null; retainedRssMb?: number | null; peakHeapUsedMb?: number | null; finalHeapUsedMb?: number | null; stabilizedHeapUsedMb?: number | null; processRssMb?: number | null; childRssMb?: number | null; processTreeRssMb?: number | null; memorySource?: MetricSource; memoryByPhase?: MemoryByPhase; postGcRssMb?: number | null; postGcHeapUsedMb?: number | null; }
export interface TokenUsage { input: number | null; output: number | null; total: number | null; calls: number; }
export interface WorkflowMetrics {
  providerCalls: number; providerCallsByRole: Record<string, number>; toolCalls: number; toolCallsByName: Record<string, number>; toolFailures: number;
  contextBuilds: number; targetedExpansions: number; contextFiles: number; contextBytes: number; contextTruncated: boolean;
  reviewCalls: number; repairCycles: number; permissionRequests: number; permissionsAllowed: number; permissionsDenied: number;
  tokens: Record<string, TokenUsage>; workflowDurationMs?: number; timeToFirstUsefulResultMs?: number;
  tokenSource?: "synthetic" | "provider_reported" | "estimated" | "unavailable";
  latencySource?: "real_core" | "synthetic_provider" | "real_provider";
  workloadProfile?: WorkloadProfile;
  planApprovals?: number; safeOperationPrompts?: number; sensitivePermissionPrompts?: number;
}
export interface TimelineEvent { phase: string; startMs: number; endMs: number; }
export interface Sample { timestampMs: number; scenario: string; run: number; rssMb: number | null; heapUsedMb: number | null; heapTotalMb: number | null; externalMb: number | null; arrayBuffersMb: number | null; cpuUserMs: number | null; cpuSystemMs: number | null; cpuPercent: number | null; source: "process_self" | "extension_host" | "vscode_total" | "unavailable"; }
export interface ScenarioResult { name: string; status: ScenarioStatus; runs: Array<Record<string, unknown>>; duration?: NumericStats; harnessDuration?: NumericStats; memory?: MemorySummary; metrics?: WorkflowMetrics; timeline?: TimelineEvent[]; workloadProfile?: WorkloadProfile | undefined; latencySource?: string; memorySource?: MetricSource; warnings?: string[]; errorCode?: string; error?: string; }
export interface BenchmarkReport { schemaVersion: 1; benchmarkRunId: string; timestamp: string; status: "completed" | "aborted"; label?: string; environment: Record<string, unknown>; repository: Record<string, unknown>; configuration: BenchmarkConfig; scenarios: ScenarioResult[]; summary: Record<string, unknown>; warnings: string[]; }
