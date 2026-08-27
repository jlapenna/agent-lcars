'use server';

import { createServerFunctionable } from '@orpc/next';

import { workRouter } from '@/lib/work-router';

import { context } from './context';

const functionable = createServerFunctionable({ context });

const createItemFn = functionable(workRouter.create);
const cancelItemFn = functionable(workRouter.cancel);
const redispatchItemFn = functionable(workRouter.redispatch);
const getItemFn = functionable(workRouter.get);
const listItemsFn = functionable(workRouter.list);

/**
 * One-line forwarders, not a behavioral difference from the five
 * procedures above: this repo's `fleet/use-server-actions-only` lint rule
 * requires every export of a file-level 'use server' module to be a
 * literal async function (so Next's Server Actions transform can find and
 * register it) - `functionable(workRouter.x)`'s return value is a call
 * expression's result, which the rule refuses to export directly.
 */
export async function createItem(input: Parameters<typeof createItemFn>[0]) {
  return createItemFn(input);
}
export async function cancelItem(input: Parameters<typeof cancelItemFn>[0]) {
  return cancelItemFn(input);
}
export async function redispatchItem(
  input: Parameters<typeof redispatchItemFn>[0],
) {
  return redispatchItemFn(input);
}
export async function getItem(input: Parameters<typeof getItemFn>[0]) {
  return getItemFn(input);
}
export async function listItems(input: Parameters<typeof listItemsFn>[0]) {
  return listItemsFn(input);
}
