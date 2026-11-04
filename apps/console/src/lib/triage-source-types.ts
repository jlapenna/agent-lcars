import type {
  TrackerIssue,
  TriageAnchor,
} from '@agent-lcars/dispatch-contracts';

export interface TriageSource {
  anchor: TriageAnchor;
  issue?: TrackerIssue;
  pipeline?: 'claude' | 'codex' | 'opencode' | 'goose';
  bug?: boolean;
  routed?: boolean;
  labelIds?: string[];
  dispatchLabel?: string;
  observedAt: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  comments: { id: number | string; body: string; updatedAt: string }[];
  openFixPr: boolean;
  owned: boolean;
  parked: boolean;
  enabled: boolean;
}
