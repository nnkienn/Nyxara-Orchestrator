# Nyxara Core

> **The local-first orchestration engine behind Nyxara.**
> **Bộ máy điều phối local-first đứng sau Nyxara.**

Nyxara Core is the shared orchestration engine used by the Nyxara CLI, VS Code extension, and future clients.

Nyxara Core là bộ máy điều phối dùng chung cho Nyxara CLI, VS Code Extension và các client khác trong tương lai.

It owns the workflow.

Nó là nơi sở hữu và kiểm soát toàn bộ workflow.

```text
User Intent
    ↓
Nyxara Core
    ↓
Plan
    ↓
Execute
    ↓
Validate
    ↓
Review
    ↓
Fix if needed
    ↓
Done
```

---

# 1. Core Goal / Mục tiêu của Core

The primary goal of Nyxara Core is to transform a single developer intention into validated code with the minimum possible manual orchestration.

Mục tiêu chính của Nyxara Core là biến một yêu cầu duy nhất của developer thành code đã được kiểm tra với số thao tác thủ công ít nhất có thể.

The user should not need to:

Người dùng không nên phải:

* copy a plan between AI tools;

* copy review feedback back to another model;

* manually restart a failed review loop;

* repeatedly provide the same repository context;

* manually coordinate Planner, Executor, and Reviewer roles.

* copy plan giữa nhiều AI;

* copy feedback review về cho model khác;

* tự khởi động lại vòng sửa lỗi;

* gửi lại cùng một context nhiều lần;

* tự điều phối Planner, Executor và Reviewer.

Core principle:

Nguyên tắc cốt lõi:

```text
One Prompt
    ↓
One Workflow
    ↓
Validated Code
```

---

# 2. Core Responsibilities / Trách nhiệm của Core

Nyxara Core is responsible for:

Nyxara Core chịu trách nhiệm:

```text
Workflow lifecycle
Task scheduling
Agent coordination
Provider routing
Context selection
Rule selection
Tool execution
Permission checks
Local validation
Review loops
Retry handling
Token tracking
Cost tracking
Event emission
Workflow persistence
```

Nyxara Core is the source of truth for workflow state.

Nyxara Core là nguồn dữ liệu chuẩn cho trạng thái workflow.

AI models must not own workflow state.

AI model không được tự sở hữu trạng thái workflow.

---

# 3. What Core Must Not Do / Những gì Core không được làm

Nyxara Core must not be tightly coupled to:

Nyxara Core không được phụ thuộc cứng vào:

```text
OpenAI
Anthropic
Claude
GPT
Gemini
Kimi
GLM
Ollama
VS Code
CLI UI
Cloud backend
```

These are integrations, providers, or clients.

Đây chỉ là integration, provider hoặc client.

The Core must remain usable independently.

Core phải có thể chạy độc lập.

Bad example:

Ví dụ sai:

```ts
if (provider === "openai") {
  // workflow logic
}
```

Correct direction:

Hướng đúng:

```ts
const provider = providerRegistry.get(providerId);

await provider.generate(request);
```

---

# 4. High-Level Architecture / Kiến trúc tổng thể

```text
                         User
                          │
                          ▼
                 CLI / VS Code
                          │
                          ▼
                ┌────────────────┐
                │  Nyxara Core   │
                └───────┬────────┘
                        │
       ┌────────────────┼────────────────┐
       │                │                │
       ▼                ▼                ▼
 Context Engine    Workflow Engine   Rule Engine
       │                │                │
       └────────────────┼────────────────┘
                        │
                        ▼
                   Agent Router
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
         Planner     Executor    Reviewer
            │           │           │
            └───────────┼───────────┘
                        │
                        ▼
                   Model Router
                        │
               Provider Registry
                        │
                        ▼
                     Models
                        │
                        ▼
                      Tools
```

---

# 5. Core Package Structure / Cấu trúc package Core

Recommended structure:

Cấu trúc đề xuất:

```text
packages/core/
│
├── src/
│   ├── orchestrator/
│   │   ├── orchestrator.ts
│   │   └── orchestrator.types.ts
│   │
│   ├── workflow/
│   │   ├── workflow-engine.ts
│   │   ├── workflow-state.ts
│   │   ├── workflow.types.ts
│   │   └── task-scheduler.ts
│   │
│   ├── agents/
│   │   ├── planner.ts
│   │   ├── executor.ts
│   │   ├── reviewer.ts
│   │   └── agent.types.ts
│   │
│   ├── routing/
│   │   ├── agent-router.ts
│   │   └── model-router.ts
│   │
│   ├── context/
│   │   ├── context-engine.ts
│   │   ├── repository-index.ts
│   │   └── context.types.ts
│   │
│   ├── rules/
│   │   ├── rule-engine.ts
│   │   ├── rule-registry.ts
│   │   └── rule.types.ts
│   │
│   ├── tools/
│   │   ├── tool-registry.ts
│   │   └── tool.types.ts
│   │
│   ├── validation/
│   │   ├── validation-engine.ts
│   │   └── validation.types.ts
│   │
│   ├── permissions/
│   │   ├── permission-engine.ts
│   │   └── permission.types.ts
│   │
│   ├── budget/
│   │   ├── budget-manager.ts
│   │   └── usage.types.ts
│   │
│   ├── events/
│   │   ├── event-bus.ts
│   │   └── event.types.ts
│   │
│   ├── persistence/
│   │   ├── workflow-store.ts
│   │   └── persistence.types.ts
│   │
│   └── index.ts
│
└── package.json
```

---

# 6. Public Core API / API công khai của Core

The public API should remain small.

Public API phải được giữ gọn.

Example:

Ví dụ:

```ts
import { NyxaraOrchestrator } from "@nyxara/core";

const nyxara = new NyxaraOrchestrator(config);

await nyxara.run({
  workspace: process.cwd(),
  prompt: "Add pagination to the notification API",
});
```

Core should expose only stable high-level interfaces.

Core chỉ nên expose các interface cấp cao và ổn định.

Internal workflow details should stay internal.

Chi tiết workflow bên trong không nên bị lộ ra ngoài nếu không cần thiết.

---

# 7. Workflow Model / Mô hình Workflow

Nyxara Core uses a state machine.

Nyxara Core sử dụng state machine.

```text
CREATED
   ↓
ANALYZING
   ↓
PLANNING
   ↓
EXECUTING
   ↓
VALIDATING
   ↓
REVIEWING
   ↓
┌───────────────┐
│               │
PASS            FAIL
│               │
▼               ▼
COMPLETED     FIXING
                │
                ▼
            VALIDATING
                │
                ▼
            REVIEWING
```

Recommended type:

```ts
export type WorkflowStatus =
  | "created"
  | "analyzing"
  | "planning"
  | "executing"
  | "validating"
  | "reviewing"
  | "fixing"
  | "completed"
  | "paused"
  | "failed";
```

Only the Workflow Engine may transition workflow state.

Chỉ Workflow Engine mới được thay đổi workflow state.

Models can return decisions, but they cannot directly mutate workflow state.

Model có thể trả về quyết định, nhưng không được tự thay đổi state.

---

# 8. Task Model / Mô hình Task

A Plan is transformed into structured tasks.

Plan phải được chuyển thành các task có cấu trúc.

```ts
export interface WorkflowTask {
  id: string;

  workflowId: string;

  title: string;

  description?: string;

  status:
    | "pending"
    | "ready"
    | "running"
    | "completed"
    | "failed"
    | "blocked";

  dependencies: string[];

  acceptanceCriteria: string[];

  assignedRole:
    | "planner"
    | "executor"
    | "reviewer";

  attempts: number;
}
```

Task dependencies must be explicit.

Dependency giữa các task phải rõ ràng.

Core decides when a task becomes ready.

Core quyết định khi nào task được chuyển sang trạng thái ready.

---

# 9. Agent Roles / Vai trò Agent

Nyxara V1 starts with three roles:

Nyxara V1 bắt đầu với ba vai trò:

```text
Planner
Executor
Reviewer
```

These are roles, not model names.

Đây là vai trò, không phải tên model.

---

## 9.1 Planner

Planner responsibilities:

Trách nhiệm Planner:

```text
Understand user intent
Inspect repository structure
Identify affected modules
Select relevant rules
Create execution tasks
Define dependencies
Define acceptance criteria
Identify risks
```

Planner must not modify repository files.

Planner không được sửa file trong repository.

Planner output must be structured.

Output của Planner phải có cấu trúc.

---

## 9.2 Executor

Executor responsibilities:

Trách nhiệm Executor:

```text
Receive one executable task
Search relevant code
Read required files
Use tools
Apply code changes
Respond to validation errors
Respond to review issues
```

Executor should follow:

Executor nên tuân theo:

```text
Search first
Read second
Reason third
Edit last
```

Executor must not receive unnecessary repository context.

Executor không được nhận context dư thừa.

---

## 9.3 Reviewer

Reviewer responsibilities:

Trách nhiệm Reviewer:

```text
Check acceptance criteria
Review git diff
Review validation results
Review applicable engineering rules
Detect architecture issues
Detect performance issues
Detect duplicated logic
Return PASS or FAIL
```

Reviewer must return structured evidence.

Reviewer phải trả về bằng chứng có cấu trúc.

Example:

```ts
export interface ReviewResult {
  verdict: "pass" | "fail";

  score?: number;

  issues: ReviewIssue[];
}
```

---

# 10. Model Configuration / Cấu hình Model

Roles must be independent from models.

Role phải độc lập với model.

Example:

```ts
export interface AgentModelConfig {
  role: "planner" | "executor" | "reviewer";

  providerId: string;

  modelId: string;
}
```

Valid configuration:

```text
Planner   → Claude
Executor  → GPT
Reviewer  → Gemini
```

Also valid:

```text
Planner   → Kimi
Executor  → GLM
Reviewer  → Claude
```

Also valid:

```text
Planner   → Ollama
Executor  → Ollama
Reviewer  → Ollama
```

Core must not care which vendor provides each role.

Core không được phụ thuộc vào vendor cụ thể.

---

# 11. Provider Abstraction / Trừu tượng hóa Provider

Provider logic lives outside Core workflow logic.

Logic provider nằm ngoài workflow logic của Core.

Recommended interface:

```ts
export interface ModelProvider {
  id: string;

  displayName: string;

  listModels(): Promise<ModelInfo[]>;

  generate(
    request: GenerateRequest,
  ): Promise<GenerateResponse>;

  capabilities(): ProviderCapabilities;
}
```

Provider Registry resolves providers by ID.

Provider Registry chịu trách nhiệm lấy provider theo ID.

```ts
const provider = providerRegistry.get("anthropic");
```

---

# 12. Context Engine / Bộ máy Context

The Context Engine controls what code is sent to models.

Context Engine kiểm soát code nào được gửi tới model.

The Core must never default to sending the entire repository.

Core không được mặc định gửi toàn bộ repository.

Context flow:

```text
User Prompt
    ↓
Repository Map
    ↓
Search
    ↓
Relevant Files
    ↓
Relevant Symbols
    ↓
Relevant Rules
    ↓
Agent Context
```

Context selection should consider:

Context selection nên xét:

```text
Task description
Changed files
Git diff
Referenced symbols
Imports
Module boundaries
Framework
Rule applicability
Token budget
```

---

# 13. Context Cache / Cache Context

File context may be cached using content hashes.

Có thể cache context file bằng content hash.

```ts
export interface FileContext {
  path: string;

  hash: string;

  summary?: string;

  symbols?: string[];

  lastIndexedAt: number;
}
```

If the hash does not change, reusable derived context should not be regenerated unnecessarily.

Nếu hash không đổi, không nên generate lại summary/context không cần thiết.

---

# 14. Engineering Rule Engine / Bộ máy Quy tắc Kỹ thuật

Engineering rules are first-class data.

Engineering rules phải là dữ liệu cấp hệ thống.

They are not simply strings appended to every prompt.

Không chỉ đơn giản là chuỗi text gắn thêm vào prompt.

Recommended model:

```ts
export interface EngineeringRule {
  id: string;

  title: string;

  description: string;

  category:
    | "architecture"
    | "performance"
    | "security"
    | "database"
    | "backend"
    | "frontend"
    | "testing"
    | "quality";

  severity:
    | "info"
    | "warning"
    | "error"
    | "blocker";

  scope:
    | "global"
    | "workspace"
    | "task";

  checkMode:
    | "static"
    | "ai"
    | "both";
}
```

---

# 15. Rule Hierarchy / Thứ tự ưu tiên Rule

Nyxara supports:

Nyxara hỗ trợ:

```text
Global Rules
      ↓
Workspace Rules
      ↓
Task Rules
```

Priority:

```text
Task > Workspace > Global
```

Workspace conventions should override generic preferences when reasonable.

Convention của project nên được ưu tiên hơn generic best practice khi hợp lý.

---

# 16. Default Rule Examples / Ví dụ Rule mặc định

Examples:

Ví dụ:

```text
Avoid N+1 queries

Avoid database queries inside loops when batching is possible

Avoid duplicated business logic

Avoid unnecessary database round trips

Avoid circular dependencies

Preserve existing module boundaries

Validate external input

Avoid unrelated code modifications

Avoid unnecessary abstraction

Never expose secrets
```

Rules must be filterable.

Rule phải có thể được filter.

A frontend task should not receive every Prisma rule.

Task frontend không nên nhận toàn bộ Prisma rule.

---

# 17. Tool System / Hệ thống Tool

Agents do not directly access the filesystem or shell.

Agent không được truy cập filesystem hoặc shell trực tiếp.

They use Nyxara Tools.

Chúng phải sử dụng Tool của Nyxara.

V1 tools:

```text
list_directory
search_files
search_code
read_file
write_file
apply_patch
git_status
git_diff
run_command
run_typecheck
run_lint
run_tests
run_build
```

Recommended interface:

```ts
export interface Tool<TInput, TOutput> {
  name: string;

  execute(
    input: TInput,
    context: ToolContext,
  ): Promise<TOutput>;
}
```

Every tool execution passes through the Permission Engine.

Mọi tool call phải đi qua Permission Engine.

---

# 18. Permission Engine / Bộ máy Quyền hạn

Nyxara should avoid constant confirmation prompts for safe actions.

Nyxara không nên bắt user xác nhận liên tục với thao tác an toàn.

Balanced defaults:

| Action                 | Behavior    |
| ---------------------- | ----------- |
| Read workspace         | Auto        |
| Search workspace       | Auto        |
| Edit workspace         | Auto        |
| Git status             | Auto        |
| Git diff               | Auto        |
| Typecheck              | Auto        |
| Lint                   | Auto        |
| Tests                  | Auto        |
| Build                  | Auto        |
| Install dependency     | Ask         |
| Delete files           | Ask         |
| Large destructive edit | Ask         |
| Git commit             | Ask         |
| Git push               | Always ask  |
| Outside workspace      | Ask / Block |
| sudo                   | Block       |
| Production deploy      | Block       |

Permission modes:

```text
Safe
Balanced
Autonomous
Custom
```

---

# 19. Validation Engine / Bộ máy Validation

Deterministic tools should run before AI review.

Các tool deterministic phải chạy trước AI Reviewer.

Recommended flow:

```text
Executor
   ↓
Typecheck
   ↓
Lint
   ↓
Tests
   ↓
Build
   ↓
Static Rule Checks
   ↓
Reviewer
```

If validation fails:

Nếu validation fail:

```text
Validation Error
      ↓
Executor Fix
```

Do not call the Reviewer yet.

Chưa gọi Reviewer.

This reduces token usage.

Điều này giúp giảm token.

---

# 20. Automatic Repair Loop / Vòng tự sửa lỗi

Review failure creates a structured Fix Task.

Review fail phải tạo Fix Task có cấu trúc.

```text
Reviewer
   │
   ├── PASS ───────→ Completed
   │
   └── FAIL
        │
        ▼
      Fix Task
        │
        ▼
     Executor
        │
        ▼
    Validation
        │
        ▼
     Reviewer
```

The user does not manually copy review feedback.

User không cần copy review feedback.

---

# 21. Loop Protection / Chống vòng lặp vô hạn

Autonomy must always have boundaries.

Tự động hóa phải có giới hạn.

Recommended defaults:

```text
maxReviewCycles = 3

maxExecutorAttempts = 5

maxWorkflowTokens = configurable

maxWorkflowCost = configurable

maxToolCalls = configurable
```

When a limit is reached:

Khi đạt giới hạn:

```text
Workflow → PAUSED
```

The Core must not continue indefinitely.

Core không được chạy vô hạn.

---

# 22. Budget Manager / Quản lý Quota và Chi phí

Nyxara tracks:

Nyxara theo dõi:

```text
Input tokens
Output tokens
Cached tokens
Estimated cost
Provider calls
Tool calls
Review cycles
Execution duration
```

Budget Manager should be provider-agnostic.

Budget Manager phải độc lập provider.

Pricing metadata may come from provider adapters or a model registry.

Pricing metadata có thể đến từ provider adapter hoặc model registry.

---

# 23. Event Bus / Hệ thống Event

Core must expose realtime events.

Core phải phát event realtime.

Examples:

```text
workflow.started

context.started
context.completed

planner.started
planner.completed

task.started
task.completed

executor.started
executor.completed

tool.started
tool.completed

file.modified

validation.started
validation.failed
validation.passed

review.started
review.failed
review.passed

fix.started
fix.completed

workflow.completed
workflow.paused
workflow.failed
```

Clients subscribe to these events.

Client chỉ subscribe event.

```text
Event Bus
   │
   ├── CLI Renderer
   │
   └── VS Code Renderer
```

This prevents UI logic from leaking into Core.

Nhờ vậy UI logic không đi vào Core.

---

# 24. Persistence / Lưu trạng thái

V1 should use local persistence.

V1 nên lưu local.

Recommended:

```text
SQLite
```

Core should persist at least:

```text
Workflow

Task

AgentRun

ToolCall

ValidationRun

Review

RuleResult

Usage
```

Secrets must never be stored in this database.

Secret không được lưu trong database này.

---

# 25. Error Handling / Xử lý lỗi

Errors should be classified.

Error nên được phân loại.

Suggested categories:

```ts
export type NyxaraErrorType =
  | "provider_error"
  | "authentication_error"
  | "tool_error"
  | "permission_error"
  | "validation_error"
  | "workflow_error"
  | "budget_error"
  | "context_error";
```

Recoverable errors may retry.

Lỗi recoverable có thể retry.

Non-recoverable errors should pause or fail the workflow.

Lỗi không recoverable phải pause hoặc fail workflow.

---

# 26. Security Model / Mô hình bảo mật

Model output is untrusted input.

Output từ model phải được xem là input không đáng tin cậy.

Every action must pass through:

```text
Agent Decision
      ↓
Tool Request
      ↓
Permission Engine
      ↓
Tool Execution
```

Models must never receive unrestricted arbitrary system access by default.

Model không được có quyền hệ thống vô hạn mặc định.

High-risk actions require explicit controls.

Các thao tác nguy hiểm phải có kiểm soát rõ ràng.

---

# 27. CLI and VS Code / CLI và VS Code

Both clients use the same Core.

Cả hai client dùng chung một Core.

```text
                 @nyxara/core
                    /     \
                   /       \
                  ▼         ▼
                CLI      VS Code
```

CLI responsibilities:

```text
Prompt input
Provider selection
Model selection
Realtime status
Final summary
```

VS Code responsibilities:

```text
Prompt UI
Model/provider settings
Workflow visualization
Diff integration
Review display
Usage display
```

Neither client owns workflow logic.

Không client nào sở hữu workflow logic.

---

# 28. Core Configuration / Cấu hình Core

Example:

```ts
export interface NyxaraConfig {
  agents: {
    planner: AgentModelConfig;
    executor: AgentModelConfig;
    reviewer: AgentModelConfig;
  };

  workflow: {
    maxReviewCycles: number;
    maxExecutorAttempts: number;
  };

  budget?: {
    maxTokens?: number;
    maxCost?: number;
  };

  permissions: PermissionConfig;
}
```

Credentials must not be part of this configuration object if it is persisted to the repository.

Credential không được nằm trong config persist vào repository.

---

# 29. Core Design Rules / Quy tắc thiết kế Core

All contributors must follow these rules.

Mọi contributor phải tuân theo:

```text
Core must remain provider-agnostic.

Core must remain UI-agnostic.

Core must remain local-first.

Workflow state must be structured.

Do not use Markdown files as runtime state.

Do not send entire repositories by default.

Use deterministic tools before AI.

Every tool passes through permissions.

Every autonomous loop has limits.

Every important operation emits an event.

Roles are not models.

Models are replaceable.

Providers are adapters.

Rules are structured data.

User credentials remain user-owned.
```

---

# 30. V1 Scope / Phạm vi V1

Nyxara Core V1 includes:

```text
Workflow Engine
Planner
Executor
Reviewer
Provider Registry
Context Engine
Rule Engine
Tool System
Permission Engine
Validation Engine
Budget Manager
Event Bus
Local Persistence
Automatic Repair Loop
```

---

# 31. V1 Non-Goals / Những thứ chưa làm ở V1

Do not implement initially:

Chưa làm ngay:

```text
Nyxara Cloud

User accounts

Team collaboration

Subscription system

Billing system

Agent marketplace

Complex graph editor

Parallel agent swarm

Cloud memory

Figma integration

Jira

Linear
```

These may come later.

Các phần này có thể làm sau.

---

# 32. Definition of Done / Điều kiện hoàn thành Core V1

Nyxara Core V1 is considered successful when:

Nyxara Core V1 được coi là hoàn thành khi:

A developer can enter a repository and provide one prompt:

Developer vào repository và nhập một prompt:

```text
Add pagination and unread filtering to the notification API.

Keep existing behavior backward compatible.
```

Nyxara then automatically:

Nyxara tự:

```text
Analyze Repository
        ↓
Select Rules
        ↓
Create Plan
        ↓
Execute Tasks
        ↓
Run Validation
        ↓
Review
        ↓
Fix Failures
        ↓
Validate Again
        ↓
Review Again
        ↓
Complete
```

The user should not have to:

User không cần:

```text
Copy plans

Copy reviews

Switch between AI chats

Repeat context

Manually restart repair loops
```

Final result:

```text
NYXARA WORKFLOW COMPLETED

Implementation       PASS

Typecheck            PASS

Lint                 PASS

Tests                PASS

Engineering Rules    PASS

AI Review             PASS
```

---

# 33. Core Principle / Nguyên tắc cuối cùng

Every Core decision should answer one question:

Mọi quyết định trong Core phải trả lời được một câu hỏi:

> **Does this reduce the work required to go from developer intent to validated code?**

> **Điều này có giúp giảm công sức để đi từ ý định của developer đến code đã được kiểm tra hay không?**

If not, it is probably not a Core responsibility.

Nếu không, rất có thể nó không thuộc trách nhiệm của Core.

---

# Nyxara Core

```text
AI makes decisions.
Tools perform deterministic work.
Rules define engineering standards.
Nyxara owns workflow state.
Developers remain in control.
```

```text
AI đưa ra quyết định.
Tool thực hiện công việc xác định.
Rule định nghĩa tiêu chuẩn kỹ thuật.
Nyxara sở hữu trạng thái workflow.
Developer vẫn là người kiểm soát cuối cùng.
```
