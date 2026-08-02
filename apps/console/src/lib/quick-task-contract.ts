import type { AgentPipeline, RepositoryRef, TaskRef } from './watched-repo';

/** Complete client intent crossing the Quick Task Server Action boundary. */
export interface QuickTaskRequest {
  requestId: string;
  repository: RepositoryRef;
  pipeline: AgentPipeline;
  title?: string;
  description: string;
}

/** Canonical result returned for both a new issue and an idempotent replay. */
export interface QuickTaskReceipt {
  requestId: string;
  task: TaskRef;
  url: string;
}
