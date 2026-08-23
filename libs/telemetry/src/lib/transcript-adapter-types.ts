import { SessionAgent, SessionSummary } from './types';

/** Contract implemented by each supported transcript format. */
export interface TranscriptAdapter {
  agent: SessionAgent;
  detect(firstLines: string[], filePath: string): boolean;
  /**
   * Lines are intentionally iterable rather than an array. The host watcher
   * can then stream a large JSONL transcript through a reducer without first
   * materializing an array of every line alongside the file contents.
   */
  reduce(lines: Iterable<string>): SessionSummary[];
}
