import { z } from "zod";

// --- Project & Tenant Schemas ---

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  identityProvider: z.string().min(1),
  providerSubject: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  gitRemoteNormalized: z.string().nullable().optional(),
  defaultBranch: z.string().default("main"),
  config: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectMembershipSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
  createdAt: z.string().datetime(),
});
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

// --- Agent Schemas ---

export const AgentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  provider: z.string(),
  clientType: z.string(),
  clientVersion: z.string().nullable().optional(),
  lastSeenAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
});
export type Agent = z.infer<typeof AgentSchema>;

// --- Task Schemas ---

export const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1),
  status: TaskStatusSchema.default("pending"),
  assignedAgentId: z.string().uuid().nullable().optional(),
  nextAction: z.string().default(""),
  currentVersion: z.number().int().nonnegative().default(1),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  leaseExpiresAt: z.string().datetime().nullable().optional(),
  leaseToken: z.string().nullable().optional(),
  leaseAgentId: z.string().nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AcquireTaskLeaseInputSchema = z.object({
  agentId: z.string().min(1),
  durationSeconds: z.number().int().positive().default(300),
});
export type AcquireTaskLeaseInput = z.infer<typeof AcquireTaskLeaseInputSchema>;

export const ReleaseTaskLeaseInputSchema = z.object({
  leaseToken: z.string().min(1),
});
export type ReleaseTaskLeaseInput = z.infer<typeof ReleaseTaskLeaseInputSchema>;

export const CreateTaskInputSchema = TaskSchema.pick({
  projectId: true,
  title: true,
}).extend({
  status: TaskStatusSchema.optional(),
  nextAction: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = TaskSchema.partial().omit({
  id: true,
  projectId: true,
  createdAt: true,
}).extend({
  expectedVersion: z.number().int().positive().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

// --- Checkpoint Schemas ---

export const WorkingTreeSummarySchema = z.object({
  clean: z.boolean(),
  branch: z.string().optional(),
  changedPaths: z.array(z.string()).default([]),
  untrackedPaths: z.array(z.string()).default([]),
  diffSummary: z.string().optional(),
});
export type WorkingTreeSummary = z.infer<typeof WorkingTreeSummarySchema>;

export const CompletedItemSchema = z.object({
  description: z.string().min(1),
  evidence: z.string().optional(),
  timestamp: z.string().datetime().optional(),
});
export type CompletedItem = z.infer<typeof CompletedItemSchema>;

export const DecisionItemSchema = z.object({
  decision: z.string().min(1),
  sourceMemoryId: z.string().uuid().optional(),
  timestamp: z.string().datetime().optional(),
});
export type DecisionItem = z.infer<typeof DecisionItemSchema>;

export const CheckpointStateSchema = z.object({
  completed: z.array(CompletedItemSchema).default([]),
  pending: z.array(z.string()).default([]),
  decisions: z.array(DecisionItemSchema).default([]),
  blockers: z.array(z.string()).default([]),
  nextAction: z.string().default(""),
  notes: z.array(z.string()).optional(),
});
export type CheckpointState = z.infer<typeof CheckpointStateSchema>;

export const CheckpointValidityStatusSchema = z.enum([
  "valid",
  "stale",
  "superseded",
  "needs_review",
]);
export type CheckpointValidityStatus = z.infer<typeof CheckpointValidityStatusSchema>;

export const CheckpointSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().nullable().optional(),
  version: z.number().int().positive(),
  branch: z.string().min(1),
  gitCommit: z.string().nullable().optional(),
  workingTree: WorkingTreeSummarySchema,
  state: CheckpointStateSchema,
  createdByAgentId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  validityStatus: CheckpointValidityStatusSchema.default("valid"),
  idempotencyKey: z.string().nullable().optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CreateCheckpointInputSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  branch: z.string().min(1),
  gitCommit: z.string().nullable().optional(),
  workingTree: WorkingTreeSummarySchema,
  state: CheckpointStateSchema,
  createdByAgentId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
});
export type CreateCheckpointInput = z.infer<typeof CreateCheckpointInputSchema>;

// --- Memory Entries Schemas ---

export const MemoryTypeSchema = z.enum(["fact", "decision", "procedure", "note"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryEntrySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  type: MemoryTypeSchema,
  title: z.string().min(1),
  content: z.string(),
  structuredContent: z.record(z.unknown()).nullable().optional(),
  sourceType: z.string(),
  sourceRef: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
  version: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  isDeleted: z.boolean().default(false),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const SearchMemoryResultSchema = MemoryEntrySchema.extend({
  rank: z.number().optional(),
});
export type SearchMemoryResult = z.infer<typeof SearchMemoryResultSchema>;

// --- Agent Events Schemas ---

export const AgentEventSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  eventType: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  correlationId: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const CreateAgentEventInputSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  eventType: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  correlationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type CreateAgentEventInput = z.infer<typeof CreateAgentEventInputSchema>;

// --- Context Package & Serialization Contracts ---

export type ContextFormat = "toon" | "json";

export const ContextPackageSchema = z.object({
  schemaVersion: z.number().int().default(1),
  projectId: z.string().uuid(),
  projectName: z.string().optional(),
  taskId: z.string().uuid().optional(),
  checkpointVersion: z.number().int().optional(),
  instructions: z.array(z.string()).default([]),
  facts: z.record(z.unknown()).default({}),
  decisions: z.array(z.record(z.unknown())).default([]),
  taskState: z.record(z.unknown()).default({}),
  recentEvents: z.array(z.record(z.unknown())).default([]),
  gitState: z.record(z.unknown()).optional(),
});
export type ContextPackage = z.infer<typeof ContextPackageSchema>;

export const EncodedContextSchema = z.object({
  format: z.enum(["toon", "json"]),
  serialized: z.string(),
  estimatedTokens: z.number().int().nonnegative(),
  baselineTokens: z.number().int().nonnegative(),
  savingsPercent: z.number(),
  contextVersion: z.number().int().default(1),
});
export type EncodedContext = z.infer<typeof EncodedContextSchema>;

// --- API Contracts ---

export const ResolveProjectRequestSchema = z.object({
  workingDirectory: z.string().optional(),
  gitRemoteUrl: z.string().optional(),
  projectName: z.string().optional(),
});
export type ResolveProjectRequest = z.infer<typeof ResolveProjectRequestSchema>;

export const AssembleContextRequestSchema = z.object({
  taskId: z.string().uuid().optional(),
  clientType: z.string().default("generic"),
  modelId: z.string().optional(),
  formatPreference: z.enum(["auto", "toon", "json"]).default("auto"),
  tokenBudget: z.number().int().positive().default(8000),
});
export type AssembleContextRequest = z.input<typeof AssembleContextRequestSchema>;

export const AssembleContextResponseSchema = z.object({
  contextId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  checkpointVersion: z.number().int().optional(),
  format: z.enum(["toon", "json"]),
  content: z.string(),
  estimatedTokens: z.number().int(),
  baselineTokens: z.number().int().optional(),
  savingsPercent: z.number(),
  tokenBudget: z.number().int().optional(),
  budgetExceeded: z.boolean().default(false),
  prunedItemsCount: z.number().int().default(0),
  sources: z.array(z.object({
    type: z.string(),
    id: z.string(),
  })),
});
export type AssembleContextResponse = z.infer<typeof AssembleContextResponseSchema>;
