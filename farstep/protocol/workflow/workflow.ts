import { createWorkflowSchemas } from "farstep/protocol/workflow/schemas";
import type * as v from "valibot";
import { jobSpecSchema } from "#farstep/protocol/jobs/protocol";

export const {
  WORKFLOW_CAPABILITY,
  jsonValueSchema,
  workflowNativeSpecSchema,
  workflowOutputPolicySchema,
  workflowGuardSchema,
  workflowReadySchema,
  workflowReadinessResultSchema,
  workflowTaskSchema,
  workflowPrepareSchema,
  workflowPreparedSchema,
  workflowStartSchema,
  workflowInspectSchema,
  workflowCancelSchema,
  workflowArtifactSchema,
  workflowOutputSchema,
  workflowStepResultSchema,
  workflowResultSchema,
} = createWorkflowSchemas(jobSpecSchema);
export type WorkflowOutputPolicy = v.InferOutput<typeof workflowOutputPolicySchema>;
export type WorkflowGuard = v.InferOutput<typeof workflowGuardSchema>;
export type WorkflowReady = v.InferOutput<typeof workflowReadySchema>;
export type WorkflowReadinessResult = v.InferOutput<
  typeof workflowReadinessResultSchema
>;
export type WorkflowTask = v.InferOutput<typeof workflowTaskSchema>;
export type WorkflowPrepare = v.InferOutput<typeof workflowPrepareSchema>;
export type WorkflowArtifact = v.InferOutput<typeof workflowArtifactSchema>;
export type WorkflowOutput = v.InferOutput<typeof workflowOutputSchema>;
export type WorkflowStepResult = v.InferOutput<typeof workflowStepResultSchema>;
export type WorkflowResult = v.InferOutput<typeof workflowResultSchema>;
