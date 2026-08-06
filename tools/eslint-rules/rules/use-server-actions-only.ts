import * as path from 'node:path';

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from '@typescript-eslint/utils';

export const RULE_NAME = 'use-server-actions-only';

type ProgramStatement = TSESTree.Program['body'][number];

function useServerDirective(
  body: TSESTree.Program['body'],
): TSESTree.ExpressionStatement | undefined {
  for (const statement of body) {
    if (
      statement.type !== AST_NODE_TYPES.ExpressionStatement ||
      statement.expression.type !== AST_NODE_TYPES.Literal ||
      typeof statement.expression.value !== 'string'
    ) {
      return undefined;
    }
    if (statement.expression.value === 'use server') return statement;
  }
  return undefined;
}

function isActionModule(filename: string): boolean {
  const basename = path.basename(filename).toLowerCase();
  return (
    /actions?\.[cm]?[jt]sx?$/.test(basename) &&
    !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(basename)
  );
}

function isTypeOnlyDeclaration(
  declaration: NonNullable<TSESTree.ExportNamedDeclaration['declaration']>,
): boolean {
  return (
    declaration.type === AST_NODE_TYPES.TSInterfaceDeclaration ||
    declaration.type === AST_NODE_TYPES.TSTypeAliasDeclaration
  );
}

function isAsyncFunction(
  node: TSESTree.Node | null,
): node is
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression {
  return (
    node !== null &&
    (node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      node.type === AST_NODE_TYPES.FunctionDeclaration ||
      node.type === AST_NODE_TYPES.FunctionExpression) &&
    node.async
  );
}

export const rule = ESLintUtils.RuleCreator(() => __filename)({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        "Reserve file-level 'use server' for dedicated Server Function action modules.",
    },
    messages: {
      asyncExportsOnly:
        "A file-level 'use server' directive makes every runtime export a Server Function. Export async functions directly, or move constants and helpers to an ordinary `server-only` module.",
      misplacedDirective:
        "File-level 'use server' is reserved for dedicated `*-action.ts`/`actions.ts` Server Function modules. Pages, layouts, and Server Components need no directive; ordinary server modules should import `server-only`.",
      noServerFunctions:
        "This 'use server' action module does not export an async Server Function.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(program) {
        const directive = useServerDirective(program.body);
        if (!directive) return;

        if (!isActionModule(context.filename)) {
          context.report({ node: directive, messageId: 'misplacedDirective' });
          return;
        }

        let serverFunctionCount = 0;
        const reportInvalidExport = (node: TSESTree.Node): void => {
          context.report({ node, messageId: 'asyncExportsOnly' });
        };

        for (const statement of program.body as ProgramStatement[]) {
          if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
            if (statement.exportKind === 'type') continue;
            const { declaration } = statement;

            if (!declaration) {
              const runtimeSpecifiers = statement.specifiers.filter(
                (specifier) => specifier.exportKind !== 'type',
              );
              runtimeSpecifiers.forEach(reportInvalidExport);
              continue;
            }
            if (isTypeOnlyDeclaration(declaration)) continue;

            if (declaration.type === AST_NODE_TYPES.FunctionDeclaration) {
              if (isAsyncFunction(declaration)) serverFunctionCount += 1;
              else reportInvalidExport(declaration);
              continue;
            }

            if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
              for (const variable of declaration.declarations) {
                if (isAsyncFunction(variable.init)) serverFunctionCount += 1;
                else reportInvalidExport(variable);
              }
              continue;
            }

            reportInvalidExport(declaration);
            continue;
          }

          if (statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
            if (isAsyncFunction(statement.declaration))
              serverFunctionCount += 1;
            else reportInvalidExport(statement.declaration);
            continue;
          }

          if (
            statement.type === AST_NODE_TYPES.ExportAllDeclaration &&
            statement.exportKind !== 'type'
          ) {
            reportInvalidExport(statement);
          }
        }

        if (serverFunctionCount === 0) {
          context.report({ node: directive, messageId: 'noServerFunctions' });
        }
      },
    };
  },
});
