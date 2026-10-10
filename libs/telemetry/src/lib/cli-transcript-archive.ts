/** Fixed privacy bounds shared by the host writer and console reader. */
export const CLI_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
export const CLI_TRANSCRIPT_RETENTION_DAYS = 30;

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
