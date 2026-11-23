import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../../lib/session-archive';
import type { IssueSessionGroup } from '../../lib/session-issue-groups';
import {
  ARCHIVE_GROUP_ROW_LIMIT,
  ARCHIVE_INITIAL_SESSIONS,
  windowFlatRows,
  windowIssueGroups,
} from './archive-window';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` }) as SessionRow);

const group = (issueNumber: number, sessions: number): IssueSessionGroup => ({
  issueNumber,
  sessions: rows(sessions),
});

describe('windowFlatRows', () => {
  it('keeps the newest rows and counts the rest', () => {
    const window = windowFlatRows(rows(ARCHIVE_INITIAL_SESSIONS + 7), false);
    expect(window.shown).toHaveLength(ARCHIVE_INITIAL_SESSIONS);
    expect(window.shown[0].sessionId).toBe('s0');
    expect(window.hiddenSessions).toBe(7);
  });

  it('renders everything when asked', () => {
    const window = windowFlatRows(rows(ARCHIVE_INITIAL_SESSIONS + 7), true);
    expect(window.hiddenSessions).toBe(0);
  });
});

describe('windowIssueGroups', () => {
  it('takes whole groups until the window is full', () => {
    const groups = Array.from({ length: 100 }, (_, i) => group(i + 1, 10));
    const window = windowIssueGroups(groups, false);
    expect(window.shown).toHaveLength(ARCHIVE_INITIAL_SESSIONS / 10);
    expect(window.hiddenSessions).toBe(1000 - ARCHIVE_INITIAL_SESSIONS);
    expect(window.rowLimit).toBe(ARCHIVE_GROUP_ROW_LIMIT);
  });

  it('caps a busy group so it cannot fill the window alone', () => {
    const window = windowIssueGroups([group(1, 5000), group(2, 3)], false);
    expect(window.shown.map((g) => g.issueNumber)).toEqual([1, 2]);
    // The group keeps every session, so its heading counts the real total.
    expect(window.shown[0].sessions).toHaveLength(5000);
    expect(window.hiddenSessions).toBe(5000 - ARCHIVE_GROUP_ROW_LIMIT);
  });

  it('renders every group and session when asked', () => {
    const window = windowIssueGroups([group(1, 5000), group(2, 3)], true);
    expect(window).toMatchObject({ hiddenSessions: 0, rowLimit: undefined });
  });
});
