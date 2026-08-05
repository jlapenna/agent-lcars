# Workspace ESLint rules

## Client/server import boundaries

`no-server-only-imports-in-client` is the fast, direct-import check for the
Console's React Server Component boundary. The production Next build remains
the transitive authority: this rule does not attempt to reproduce the bundler's
module graph.

Project discovery is intentionally synchronous. The rule reads Nx's resolved,
cached project graph when one already exists. It never creates a graph while
ESLint is loading, because Nx plugin inference can itself load ESLint and form a
configuration cycle. When the cache is unavailable (the usual editor and
project-inference case), the rule recursively discovers `project.json`,
package-based `package.json`, and tsconfig-only inferred project roots without
assuming `apps/*` or `libs/*` layout. This fallback reads project names, source
roots, and `nx.tags`; inferred targets are irrelevant to this boundary
decision.

Root and project-owned `tsconfig.json` path mappings are resolved for each
import. A `browser`, `client`, `schema`, or `ui` subpath is safe only when an
applicable exact or wildcard mapping resolves to a real source file and that
file has no `server-only` or `assertNotBrowser()` marker. A matching workspace
alias with no resolvable target produces a configuration diagnostic instead of
failing open. Imports that match no workspace alias or project keep ordinary
third-party package behavior.

An explicit `<project>/server` mapping is always a server boundary, including
when its index only re-exports a marker-bearing module. A project that exposes
that server entry point alongside an explicit `browser` or `client` entry point
also keeps its package root server-side; only the resolved safe entry point is
allowed into a client graph.

Sprinkles carries its companion rule independently. Keep its fixtures aligned
with this contract, but do not share source or build contexts across
repositories.
