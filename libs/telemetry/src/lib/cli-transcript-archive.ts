/** Shared bound for explicitly consented CLI snapshots and console reads. */
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
  /** Fences publication against concurrent revocation or a newer capture. */
  captureId?: string;
}
