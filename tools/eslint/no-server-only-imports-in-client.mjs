// ESLint rule: a `'use client'` module must not *value*-import a
// server-only module.
//
// Value-importing something like `@agent-lcars/telemetry/server` or
// `../lib/github-client` into a client component drags Node-only
// dependencies (firebase-admin, google-auth-library, @octokit/rest, ...)
// into the browser bundle. Turbopack/webpack then either fails the build
// outright (dozens of module-resolve errors - see #59) or, worse, ships
// something that only breaks at hydration ("Attempted to call X() from the
// server" / undefined exports).
//
// `import type { X } from '...'` (and any import/export where every
// specifier is type-only) is always allowed: type-only bindings are erased
// before bundling and carry no runtime dependency, so they're the
// documented escape hatch for a client module that only needs a
// server-module's *types*.
//
// This is deliberately a small, explicit denylist rather than a dynamic
// scan of the workspace graph - see issue #537: it targets the exact
// modules a retro (#521) found agents reaching for by accident from a
// client file. The broader case of a *non*-`'use client'` component
// transitively dragging server-only deps into a client subtree (because
// something upstream imported it without the directive) is out of scope
// here; that's caught by the `next build`-based smoke instead (catches
// anything prerenderable) and, as a last resort, the hermetic e2e suite.

const CLIENT_DIRECTIVE = 'use client';

/**
 * @param {string} source
 * @param {readonly string[]} restricted
 */
function matchesRestricted(source, restricted) {
  return restricted.some(
    (name) => source === name || source.endsWith(`/${name}`),
  );
}

/**
 * @param {import('estree').Program} program
 */
function fileHasUseClientDirective(program) {
  const first = program.body[0];
  return (
    first?.type === 'ExpressionStatement' &&
    first.expression.type === 'Literal' &&
    first.expression.value === CLIENT_DIRECTIVE
  );
}

/**
 * True when a declaration is erased before bundling: either the whole
 * declaration is `import type`/`export type`, or (for named
 * import/export lists) every individual specifier carries its own inline
 * `type` keyword. Default/namespace specifiers never carry per-specifier
 * `importKind`, so a bare `import Foo from '...'` is never type-only
 * unless the whole declaration says so.
 *
 * @param {{ importKind?: string; exportKind?: string; specifiers?: readonly { importKind?: string; exportKind?: string }[] }} node
 */
function isTypeOnly(node) {
  if (node.importKind === 'type' || node.exportKind === 'type') return true;
  if (!node.specifiers || node.specifiers.length === 0) return false;
  return node.specifiers.every(
    (specifier) =>
      specifier.importKind === 'type' || specifier.exportKind === 'type',
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow 'use client' modules from value-importing, re-exporting, or dynamically importing a server-only module.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          restricted: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      restricted:
        "'{{source}}' is server-only and cannot be value-imported from a '{{directive}}' module - Next.js will either fail the client build or ship something that only breaks at hydration. Use `import type` if you only need types, or move the server-dependent logic behind a server action / API route (see #537).",
    },
  },
  create(context) {
    const restricted = context.options[0]?.restricted ?? [];
    if (restricted.length === 0) return {};

    let isClientModule = false;

    /**
     * @param {import('estree').Node} node
     * @param {import('estree').Literal | null | undefined} sourceNode
     */
    function checkSource(node, sourceNode) {
      if (!isClientModule) return;
      if (!sourceNode || typeof sourceNode.value !== 'string') return;
      if (isTypeOnly(node)) return;
      const source = sourceNode.value;
      if (matchesRestricted(source, restricted)) {
        context.report({
          node,
          messageId: 'restricted',
          data: { source, directive: CLIENT_DIRECTIVE },
        });
      }
    }

    return {
      Program(node) {
        isClientModule = fileHasUseClientDirective(node);
      },
      ImportDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
      },
      ImportExpression(node) {
        // Dynamic `import('...')` has no type-only form - it's always a
        // runtime reference.
        if (!isClientModule) return;
        if (
          node.source?.type === 'Literal' &&
          typeof node.source.value === 'string' &&
          matchesRestricted(node.source.value, restricted)
        ) {
          context.report({
            node,
            messageId: 'restricted',
            data: { source: node.source.value, directive: CLIENT_DIRECTIVE },
          });
        }
      },
    };
  },
};

export default {
  rules: {
    'no-server-only-imports-in-client': rule,
  },
};
