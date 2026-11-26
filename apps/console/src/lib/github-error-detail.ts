/** Format only bounded GitHub error fields and redact tokens before truncating. */
export function formatGithubErrorDetail(
  message: unknown,
  errors: unknown,
  token: string,
): string {
  const clean = (value: unknown) =>
    typeof value === 'string'
      ? (token ? value.replaceAll(token, '[redacted]') : value)
          .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]+/gi, '[redacted]')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180)
      : '';
  const reasons = (Array.isArray(errors) ? errors.slice(0, 3) : []).map(
    (entry: unknown) => {
      if (typeof entry === 'string') return clean(entry);
      if (!entry || typeof entry !== 'object') return '';
      const { message, field, code } = entry as Record<string, unknown>;
      return (
        clean(message) || [clean(field), clean(code)].filter(Boolean).join(' ')
      );
    },
  );
  return [clean(message), ...reasons].filter(Boolean).join(' ').slice(0, 450);
}
