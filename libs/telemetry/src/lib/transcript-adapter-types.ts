import { SessionAgent, SessionSummary } from './types';

/** Contract implemented by each supported transcript format. */
export interface TranscriptAdapter {
  agent: SessionAgent;
  detect(firstLines: string[], filePath: string): boolean;
  reduce(lines: string[]): SessionSummary[];
}
