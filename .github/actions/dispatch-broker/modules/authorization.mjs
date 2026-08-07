/**
 * Pure authorization policy (#645 Phase 2 extraction).
 *
 * This is the module the issue itself calls out by name: "a pure policy
 * module... [that] can be versioned, fixture-tested, measured, and audited
 * independently" of the rest of the dispatch controller. It has zero
 * dependencies -- no ledger, no GitHub I/O, no other controller module --
 * on purpose: every input is a plain value, every output is a plain
 * `LedgerAuthorizationDecision` shape (see
 * ../../../../libs/dispatch-contracts/src/ledger.js), and the whole thing is
 * one comparison.
 *
 * Originally lived inline in normalize.mjs; moved out unchanged so it can be
 * imported, tested, and reasoned about on its own.
 */

/**
 * Stable identifiers for which policy clause produced a decision. Every
 * caller names one of these rather than a hand-typed string literal, so a
 * typo can never silently mint a second, un-auditable rule name for the same
 * clause.
 */
export const AUTHORIZATION_RULES = Object.freeze({
  MANUAL_MAINTAINER: 'manual-maintainer',
  OWNER_COMMENT: 'owner-comment',
  MAINTAINER_ISSUE_EVENT: 'maintainer-issue-event',
  CANARY_SCHEDULED_DISPATCH: 'canary-scheduled-dispatch',
  RECONCILE_LABEL_REPAIR: 'reconcile-label-repair',
});

/**
 * Build an AuthorizationDecision: authorized iff the acting login is exactly
 * the configured maintainer. Every dispatch-triggering event that is not
 * itself an unconditionally-trusted internal ping (canary, the reconcile
 * label-repair, both of which build their own decision inline because they
 * are never a bare actor-equals-maintainer comparison) runs through this one
 * function.
 *
 * @param {string|undefined} actor
 * @param {string|undefined} maintainer
 * @param {string} rule One of AUTHORIZATION_RULES.
 * @param {Record<string, unknown>} [extra] Additional evidence fields (e.g.
 *   comment author association) folded into the decision for audit purposes.
 */
export function authorization(actor, maintainer, rule, extra = {}) {
  return {
    authorized: actor === maintainer,
    actor,
    configuredMaintainer: maintainer,
    rule,
    ...extra,
  };
}
