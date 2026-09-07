import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The one way this console renders untrusted Markdown - GitHub issue and
 * comment bodies, agent transcript turns, artifact previews.
 *
 * It exists for two reasons, both of which were being restated (or missed) at
 * each of the three call sites:
 *
 * 1. Security. No `rehype-raw`: raw HTML embedded in the content is escaped
 *    rather than rendered, and react-markdown's default `urlTransform` strips
 *    dangerous link schemes (e.g. `javascript:`). Every caller treats this
 *    content as untrusted, so the decision belongs here once rather than in
 *    three comments that could drift apart.
 *
 * 2. Appearance. The rendered output never got a class, so its links fell
 *    through to the browser's defaults - `#0000EE` unvisited, `#9E9EFF`
 *    visited. On the light ground that measured 1.87:1, and on the dark plane
 *    the visited colour measured 4.43:1 against a blockquote; both under the
 *    4.5:1 AA bar, and neither is a colour this palette contains (#1843).
 */
export function ConsoleMarkdown({ children }: { children: string }) {
  return (
    <div className="lcars-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
