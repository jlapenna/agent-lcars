/** Fixed privacy bound the console reader applies to archived CLI
 * transcripts. The host writer that produced these archives (the retired
 * watcher daemon) is gone; docs written before its removal still carry
 * `cliTranscriptArchive`, so the reader contract stays. */
export const CLI_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

export interface CliTranscriptArchive {
  status:
    | 'pending'
    | 'available'
    | 'failed'
    | 'too-large'
    | 'expired'
    | 'unsupported';
  /** Present only after a successful upload; never inferred by a reader. */
  expiresAt?: string;
}
