'use server';

import { createServerFunctionable } from '@orpc/next';
import { revalidatePath } from 'next/cache';

import { workRouter } from '@/lib/work-router';

import { context } from '../context';

const functionable = createServerFunctionable({ context });
const list = functionable(workRouter.issueList);
const refresh = functionable(workRouter.issueRefresh);
const dispatch = functionable(workRouter.issueDispatch);

export async function listSources(input: Parameters<typeof list>[0]) {
  return list(input);
}
export async function refreshSources(input: Parameters<typeof refresh>[0]) {
  const result = await refresh(input);
  if (!result[0]) revalidatePath('/work/issues');
  return result;
}
export async function dispatchSource(input: Parameters<typeof dispatch>[0]) {
  const result = await dispatch(input);
  if (!result[0]) {
    revalidatePath('/work/issues');
    revalidatePath('/work');
  }
  return result;
}
