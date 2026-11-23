/** Safety ceiling (512 MiB) for streamed CLI transcript archive uploads so a
 * runaway or corrupt file cannot stream unboundedly. */
export const CLI_TRANSCRIPT_SAFETY_MAX_BYTES = 512 * 1024 * 1024;

/** Maximum byte length (32 MiB) of a single JSONL line during streamed CLI
 * validation so a newline-free binary file cannot exhaust memory. */
export const MAX_TRANSCRIPT_LINE_BYTES = 32 * 1024 * 1024;

export interface CliTranscriptArchive {
  /** `'too-large'` is retained so historical CLI session documents captured
   * under the former 5 MiB limit still parse within their 30-day Firestore TTL. */
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
