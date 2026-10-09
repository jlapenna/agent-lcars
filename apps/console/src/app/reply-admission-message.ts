/** Admission does not promise that an executor has started or resumed yet. */
export function replyAdmissionMessage(resumed: boolean): string {
  return resumed
    ? 'Reply admitted with a saved transcript. Resume will be attempted when the agent starts.'
    : 'Reply admitted for a fresh session — no resumable transcript.';
}
