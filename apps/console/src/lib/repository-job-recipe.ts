import { isDeepStrictEqual } from 'node:util';

import {
  isMap,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
  type YAMLMap,
} from 'yaml';

/**
 * The admitted recipe with every declared parameter turned into a Goose
 * `file` parameter, so the worker passes each value (fixed inputs, invocation
 * parameters and the baseline) as a private file path instead of argv. Goose
 * reads the file and substitutes its contents, so templates render exactly as
 * they would with the same value as a string, without Linux's 128 KiB
 * per-argument limit.
 *
 * Goose renders the raw recipe text as a template before it parses YAML, so
 * the rewrite splices only the declaration scalars it changes into the
 * original text; prompts, instructions and quoting are left byte-for-byte.
 * Goose refuses defaults on file parameters and defaults on optional ones, so
 * every parameter becomes `required` without a default; admission has already
 * resolved every value the worker passes.
 */
export function fileParameterRecipe(recipeText: string): string {
  const document = parseDocument(recipeText, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML');
  const parameters = document.get('parameters', true);
  if (!isSeq(parameters)) throw new Error('Recipe parameters must be a list');
  const edits: { start: number; end: number; text: string }[] = [];
  const range = (node: Node | null | undefined) => {
    if (!node?.range) throw new Error('Recipe parameter without source range');
    return node.range;
  };
  for (const item of parameters.items) {
    if (!isMap(item)) throw new Error('Recipe parameter must be a mapping');
    const map = item as YAMLMap;
    for (const pair of map.items) {
      if (!isScalar(pair.key)) continue;
      const value = pair.value as Node | null;
      if (pair.key.value === 'input_type' || pair.key.value === 'requirement') {
        const [start, end] = range(value);
        edits.push({
          start,
          end,
          text: pair.key.value === 'input_type' ? 'file' : 'required',
        });
      } else if (pair.key.value === 'default') {
        let [start] = range(pair.key);
        let end = range(value)[1];
        const lineStart = recipeText.lastIndexOf('\n', start - 1) + 1;
        if (map.flow) {
          // A flow mapping separates entries with commas; drop this entry's.
          const following = /^\s*,/u.exec(recipeText.slice(end));
          if (following) end += following[0].length;
        } else if (/^[ \t]*$/u.test(recipeText.slice(lineStart, start))) {
          // Remove whole lines in a block mapping, block scalars included.
          start = lineStart;
          if (recipeText[end - 1] !== '\n') {
            const newline = recipeText.indexOf('\n', end);
            end = newline === -1 ? recipeText.length : newline + 1;
          }
        }
        edits.push({ start, end, text: '' });
      }
    }
  }
  let text = recipeText;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  // Prove the splice changed exactly the declarations and nothing else.
  const expected = document.toJS({ maxAliasCount: 0 }) as {
    parameters: Record<string, unknown>[];
  };
  expected.parameters = expected.parameters.map(
    ({ default: _default, ...parameter }) => ({
      ...parameter,
      input_type: 'file',
      requirement: 'required',
    }),
  );
  const rewritten = parseDocument(text, { uniqueKeys: true });
  if (
    rewritten.errors.length ||
    !isDeepStrictEqual(rewritten.toJS({ maxAliasCount: 0 }), expected)
  )
    throw new Error('Recipe parameters cannot be passed as files');
  return text;
}
