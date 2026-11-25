import { describe, expect, it } from 'vitest';

import { eventEndsSubscription, renderAgentEventNotice } from './agent-events';
import { WORK_AGENT_EVENT_KIND, workAgentEvent } from './work-agent-events';

const WORK = '01JD5X0ABCDEFGHJKMNPQRSTVW';
const AT = '2026-11-25T18:00:00.000Z';

describe('workAgentEvent', () => {
  it.each([
    ['running', 'state'],
    ['parked', 'needs-reply'],
    ['done', 'done'],
    ['failed', 'done'],
    ['canceled', 'done'],
  ] as const)('maps %s to %s with the state as its detail', (state, kind) => {
    const event = workAgentEvent({
      workId: WORK,
      eventId: `work.${WORK}.r7`,
      state,
      occurredAt: AT,
    });
    expect(event).toEqual({
      id: `work.${WORK}.r7`,
      key: `lcars:work:${WORK}`,
      kind,
      occurredAt: AT,
      detail: state,
    });
    expect(WORK_AGENT_EVENT_KIND[state]).toBe(kind);
  });

  it('ends a subscription only on a terminal state', () => {
    const ends = (state: keyof typeof WORK_AGENT_EVENT_KIND) =>
      eventEndsSubscription(
        { source: 'lcars:work' },
        workAgentEvent({ workId: WORK, eventId: 'e', state, occurredAt: AT }),
      );
    expect(ends('running')).toBe(false);
    expect(ends('parked')).toBe(false);
    expect(ends('done')).toBe(true);
    expect(ends('failed')).toBe(true);
    expect(ends('canceled')).toBe(true);
  });

  it('links the console Work item page over https', () => {
    const event = workAgentEvent({
      workId: WORK,
      eventId: 'e',
      state: 'parked',
      occurredAt: AT,
      consoleUrl: 'https://lcars.example.net/',
    });
    expect(event.link).toBe(`https://lcars.example.net/work/${WORK}`);
    expect(renderAgentEventNotice(event, { id: 'sub1' }, false)).toContain(
      `[lcars-event] lcars:work:${WORK} needs-reply (parked)\nDetails: https://lcars.example.net/work/${WORK}`,
    );
  });

  it.each(['http://localhost:3000', 'not a url'])(
    'omits the link for console URL %s',
    (consoleUrl) => {
      expect(
        workAgentEvent({
          workId: WORK,
          eventId: 'e',
          state: 'done',
          occurredAt: AT,
          consoleUrl,
        }),
      ).not.toHaveProperty('link');
    },
  );

  it('refuses an id the event schema rejects', () => {
    expect(() =>
      workAgentEvent({
        workId: WORK,
        eventId: 'bad id',
        state: 'done',
        occurredAt: AT,
      }),
    ).toThrow();
  });
});
