import type { ActionItem } from './action-items';

export interface HumanDecision {
  ask: string;
  choices: HumanChoice[];
}

export interface HumanChoice {
  kind: 'option' | 'approval';
  label: string;
}

export interface IssueDecisionAnswer {
  ask: string;
  choice: HumanChoice;
  commentUrl?: string;
}

export function humanAskFromHandoff(handoff?: string): string | undefined {
  const firstLine = handoff?.trimStart().split(/\r?\n/, 1)[0];
  const ask = firstLine?.match(/^Human ask:[ \t]+(.{1,400})$/i)?.[1]?.trim();
  return ask || undefined;
}

export function humanDecisionFromHandoff(
  handoff?: string,
): HumanDecision | undefined {
  const ask = humanAskFromHandoff(handoff);
  if (!ask || !handoff) return undefined;
  const choices: HumanDecision['choices'] = [];
  const lines = handoff.trimStart().split(/\r?\n/, 6).slice(1);
  for (const line of lines) {
    if (!/^Human (option|approval):/i.test(line)) break;
    const match = line.match(/^Human (option|approval):[ \t]+(.{1,120})$/i);
    const label = match?.[2]?.trim();
    if (!label) return { ask, choices: [] };
    choices.push({
      kind: match?.[1]?.toLowerCase() === 'approval' ? 'approval' : 'option',
      label,
    });
  }
  const valid =
    (choices.length === 1 && choices[0]?.kind === 'approval') ||
    (choices.length >= 2 &&
      choices.length <= 4 &&
      choices.every((choice) => choice.kind === 'option') &&
      new Set(choices.map((choice) => choice.label.toLowerCase())).size ===
        choices.length);
  return { ask, choices: valid ? choices : [] };
}

export function humanDecisionReply(ask: string, choice: HumanChoice): string {
  return `${choice.kind === 'approval' ? 'Approved' : 'Selected'}: ${choice.label}\n\nFor this request: ${ask}`;
}

export function issueHumanDecision(
  item: ActionItem,
): HumanDecision | undefined {
  if (!item.actionTypes.includes('needs-human')) return undefined;
  return humanDecisionFromHandoff(item.lastCommentBody ?? item.body);
}

export function issueHumanAsk(item: ActionItem): string | undefined {
  return issueHumanDecision(item)?.ask;
}
