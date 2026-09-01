export { EventBus } from "./events/event-bus.js";
export type {
  EventListener,
  ListenerErrorObserver,
  ListenerErrorReport,
} from "./events/event-bus.js";
export type {
  ContextCompletedEvent,
  ContextFailedEvent,
  ContextStartedEvent,
  ContextTruncatedEvent,
  ExecutorCompletedEvent,
  ExecutorFailedEvent,
  ExecutorStartedEvent,
  FileWriteEvent,
  NyxaraEventMap,
  PermissionDecisionEvent,
  PermissionRequestedEvent,
  PlannerCompletedEvent,
  PlannerFailedEvent,
  PlannerStartedEvent,
  PlannerProfileResolvedEvent,
  RulesResolvedEvent,
  PlanValidationFailedEvent,
  PlanValidationPassedEvent,
  PlanValidationStartedEvent,
  PlanApprovalEvent,
  PatchEvent,
  PatchFailedEvent,
  ProviderGenerationCompletedEvent,
  ProviderModelsCompletedEvent,
  ProviderOperationFailedEvent,
  ProviderRegisteredEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
  TaskExecutionCompletedEvent,
  TaskExecutionFailedEvent,
  TaskExecutionStartedEvent,
  ValidationCompletedEvent,
  ValidationFailedEvent,
  ValidationStartedEvent,
  ValidationStepEvent,
  ValidationStepStartedEvent,
  ReviewerCompletedEvent,
  ReviewerFailedEvent,
  ReviewerStartedEvent,
  ReviewContextExpandedEvent,
  ReviewContextRequestedEvent,
  ReviewValidationFailedEvent,
  ReviewValidationPassedEvent,
  ReviewValidationStartedEvent,
  RepairEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTaskBlockedEvent,
  WorkflowTaskSelectedEvent,
  WorkflowRuntimeEvent,
  WorkflowPermissionRequestedEvent,
  WorkflowPermissionDecisionEvent,
} from "./events/event.types.js";
export {
  relevantDiff,
  RepairEvidenceBuilder,
} from "./repair/repair-evidence-builder.js";
export {
  deduplicateFindings,
  findingKey,
  RepairTaskBuilder,
  reviewFindings,
  validationFailureDetails,
  validationFindings,
} from "./repair/repair-task-builder.js";
export {
  DEFAULT_REPAIR_LIMITS,
  RepairOrchestrator,
  resolveRepairLimits,
} from "./repair/repair-orchestrator.js";
export { RepairCycleStore } from "./repair/repair-cycle-store.js";
export { RepairError } from "./repair/repair.errors.js";
export type { RepairErrorCode } from "./repair/repair.errors.js";
export type { BuildRepairTaskInput } from "./repair/repair-task-builder.js";
export type { BuildRepairEvidenceInput } from "./repair/repair-evidence-builder.js";
export type {
  RepairContextEvidence,
  RepairContextRequest,
  RepairCycleHistory,
  RepairCycleState,
  RepairCycleStatus,
  RepairEvidence,
  RepairExecutorInput as RepairExecutorTaskInput,
  RepairFinding,
  RepairLimits,
  RepairOperations,
  RepairReason,
  RepairResult,
  RepairResultStatus,
  RepairReviewEvidence,
  RepairReviewRequest,
  RepairTask,
  RepairValidationEvidence,
  RepairValidateRequest,
  RepairWorkflowInput,
} from "./repair/repair.types.js";
export {
  AgentModelConfigError,
  AgentModelRegistry,
} from "./agents/agent-model-registry.js";
export type { AgentModelConfigErrorCode } from "./agents/agent-model-registry.js";
export type { AgentModelConfig, AgentRole } from "./agents/agent.types.js";
export { Executor } from "./executor/executor.js";
export { ExecutorError } from "./executor/executor-error.js";
export type { ExecutorErrorCode } from "./executor/executor-error.js";
export { ExecutorPromptBuilder } from "./executor/executor-prompt-builder.js";
export { EXECUTOR_TOOL_DEFINITIONS } from "./executor/executor-tools.js";
export {
  canTransitionTask,
  DEFAULT_TASK_EXECUTION_STORE_LIMITS,
  TASK_TRANSITIONS,
  TaskExecutionStore,
} from "./executor/task-execution-store.js";
export type { TaskExecutionStoreLimits } from "./executor/task-execution-store.js";
export { ExecutionDecisionSchema } from "./executor/executor.types.js";
export type {
  ExecuteTaskInput,
  ExecuteTaskResult,
  ExecutionDecision,
  ExecutionGitEvidence,
  ExecutionResult,
  ExecutorInput,
  ExecutorLimits,
  ExecutorRunInput,
  RepairExecutorInput,
  RepairExecutorRunInput,
  TaskExecutionState,
  TaskExecutionStatus,
} from "./executor/executor.types.js";
export { ContextEngine, extractSearchTerms } from "./context/context-engine.js";
export {
  DEFAULT_TASK_CONTEXT_BUDGET,
  selectTaskContext,
  taskContextQuery,
} from "./context/task-context-selector.js";
export type { TaskContextSelection } from "./context/task-context-selector.js";
export type {
  BuildContextInput,
  ContextBudget,
  ContextBundle,
  ContextFile,
  ExpandedContext,
  ExpandContextInput,
} from "./context/context.types.js";
export {
  ApproximateTokenEstimator,
} from "./context/token-estimator.js";
export type { TokenEstimator } from "./context/token-estimator.js";
export { Repository } from "./repository/repository.js";
export { Planner } from "./planner/planner.js";
export { PlannerPromptBuilder } from "./planner/planner-prompt-builder.js";
export { PlannerError } from "./planner/planner-error.js";
export type { PlannerErrorCode } from "./planner/planner-error.js";
export {
  BUILT_IN_PLANNING_PROFILES,
  DEFAULT_PLANNING_PROFILE,
  PLANNING_PROFILE_LIMITS,
  PlanningProfileError,
  PlanningProfileSchema,
  parsePlanningProfile,
  planningProfileMetadata,
} from "./planner/planning-profile.js";
export type {
  PlanningProfile,
  PlanningProfileErrorCode,
  PlanningProfileMetadata,
  PlanStyle,
  RiskMode,
} from "./planner/planning-profile.js";
export { PlanningProfileRegistry } from "./planner/planning-profile-registry.js";
export { compilePlanningProfile } from "./planner/planning-profile-compiler.js";
export { PlanValidator } from "./planner/plan-validator.js";
export {
  ExecutionPlanDraftSchema,
  ExecutionPlanSchema,
  normalizePlannerInput,
  PlannedTaskSchema,
  PlanRiskSchema,
} from "./planner/planner.types.js";
export type {
  CreatePlanInput,
  ExecutionPlan,
  ExecutionPlanDraft,
  PlannedTask,
  PlannerInput,
  PlannerRunInput,
  PlanResult,
  PlanRisk,
} from "./planner/planner.types.js";
export {
  PlanRuntimeStore,
  PlanRuntimeError,
  planFingerprint,
  assertApprovedPlanIntegrity,
} from "./planner/plan-runtime-store.js";
export type {
  PlanApprovalRecord,
  PlanRuntimeState,
  PlanStatus,
  PlanRuntimeErrorCode,
} from "./planner/plan-runtime-store.js";
export { detectTaskCycle, TaskGraph } from "./planner/task-graph.js";
export {
  detectPackageManager,
  ValidationCommandDiscovery,
} from "./validation/validation-command-discovery.js";
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUTS,
  SCRIPT_CANDIDATES,
} from "./validation/validation-command-discovery.js";
export {
  normalizeValidationConfig,
} from "./validation/validation-config.js";
export type {
  NormalizedValidationConfig,
} from "./validation/validation-config.js";
export {
  detectTrackedChanges,
  ValidationEngine,
} from "./validation/validation-engine.js";
export { ValidationError } from "./validation/validation.errors.js";
export type { ValidationErrorCode } from "./validation/validation.errors.js";
export {
  DEFAULT_VALIDATION_STORE_LIMITS,
  ValidationStore,
} from "./validation/validation-store.js";
export type {
  ValidationSelector,
  ValidationStoreLimits,
} from "./validation/validation-store.js";
export { VALIDATION_KINDS } from "./validation/validation.types.js";
export type {
  PackageManager,
  ResolvedValidationStep,
  ValidateInput,
  ValidationConfig,
  ValidationDiscoveryResult,
  ValidationKind,
  ValidationResult,
  ValidationStepConfig,
  ValidationStepResult,
  ValidationStepStatus,
} from "./validation/validation.types.js";
export {
  DEFAULT_REVIEW_EVIDENCE_BUDGET,
  reviewContextBytes,
  ReviewEvidenceBuilder,
  resolveReviewEvidenceBudget,
  truncateUtf8,
} from "./review/review-evidence-builder.js";
export { ReviewerError } from "./review/reviewer.errors.js";
export * from "./rules/index.js";
export type { ReviewerErrorCode } from "./review/reviewer.errors.js";
export { Reviewer } from "./review/reviewer.js";
export { ReviewerPromptBuilder } from "./review/reviewer-prompt-builder.js";
export {
  ReviewContextRequestSchema,
  ReviewCriterionResultSchema,
  ReviewFindingDraftSchema,
  ReviewResultDraftSchema,
  RuleEvaluationSchema,
} from "./review/reviewer.schema.js";
export type { ReviewResultDraft } from "./review/reviewer.schema.js";
export { ReviewStore } from "./review/review-store.js";
export {
  ReviewValidator,
  validateReviewContextRequest,
} from "./review/review-validator.js";
export type {
  ReviewContextEvidence,
  ReviewContextExpansion,
  ReviewContextRequest,
  ReviewCriterionResult,
  ReviewCriterionStatus,
  ReviewDiffEvidence,
  ReviewEvidenceBudget,
  ReviewEvidenceBundle,
  ReviewEvidenceInput,
  ReviewerInput,
  ReviewerLimits,
  ReviewerRunInput,
  ReviewerRunResult,
  ReviewFinding,
  ReviewFindingCategory,
  ReviewFindingSeverity,
  ReviewResult,
  RuleEvaluation,
  RuleEvaluationStatus,
  ReviewStatus,
  ReviewTaskInput,
  ReviewTaskResult,
  ReviewValidationEvidence,
  ReviewValidationStepEvidence,
} from "./review/reviewer.types.js";
export { NyxaraOrchestrator } from "./orchestrator/orchestrator.js";
export type {
  ModelGenerateInput,
  NyxaraOrchestratorConfig,
  RepairTaskInput,
  RepairTaskResult,
  RunInput,
  RunTaskPipelineInput,
  StartWorkflowInput,
  TaskPipelineResult,
  TaskPipelineStatus,
  AutonomousWorkflowResult,
  WorkflowRunOutcome,
  ResolveWorkflowPermissionInput,
} from "./orchestrator/orchestrator.types.js";
export {
  ProviderRegistry,
  ProviderRegistryError,
} from "./providers/provider-registry.js";
export type { ProviderRegistryErrorCode } from "./providers/provider-registry.js";
export type {
  TaskRuntimeStatus,
  PendingWorkflowPermission,
  WorkflowError,
  WorkflowFailure,
  WorkflowSnapshot,
  WorkflowState,
  WorkflowStatus,
  WorkflowTaskSnapshot,
} from "@nyxara/shared";
export {
  isTerminalWorkflowStatus,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_STATUSES,
} from "@nyxara/shared";
export { WorkflowEngine } from "./workflow/workflow-engine.js";
export { WorkflowStateError } from "./workflow/workflow.errors.js";
export type { WorkflowErrorCode } from "./workflow/workflow.errors.js";
export {
  DEFAULT_WORKFLOW_LIMITS,
  WORKFLOW_TRANSITIONS,
} from "./workflow/workflow.types.js";
export type {
  WorkflowLimits,
  WorkflowTaskRecord,
  WorkflowTaskRepairStatus,
  WorkflowTransitionInput,
} from "./workflow/workflow.types.js";
