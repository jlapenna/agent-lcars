import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { agentDefinitionSchema } from './repository-agent-definition';
import { jobDigest } from './repository-job-definition';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** One cataloged agent: its latest observed definition or error, and whether
 * it may be admitted. */
export const catalogAgentSchema = z.strictObject({
  id: hash,
  repository: z.string(),
  name: z.string(),
  definition: agentDefinitionSchema.optional(),
  error: z.string().optional(),
  refreshedAt: z.iso.datetime(),
  enabled: z.boolean(),
  /** The operator's sticky veto: a principal while an explicit disable
   * stands, null once an explicit enable clears it. */
  vetoedBy: z.string().nullable().optional(),
});
export type CatalogAgent = z.infer<typeof catalogAgentSchema>;

/** Per-repository refresh bookkeeping: when a refresh last started (for
 * oldest-first fairness) and the newest observation that published. */
export const agentSourceSchema = z.strictObject({
  repository: z.string(),
  attemptedAt: z.iso.datetime().optional(),
  observedAt: z.iso.datetime().optional(),
});
export type AgentSource = z.infer<typeof agentSourceSchema>;

export interface AgentStore {
  list(): Promise<CatalogAgent[]>;
  sources(): Promise<AgentSource[]>;
  recordAttempt(repository: string, at: string): Promise<void>;
  /** Atomically claim the right to publish an observation made at `at`:
   * false when a newer observation of the repository already published, so a
   * slow older refresh can never resurrect what a newer one removed. */
  claimObservation(repository: string, at: string): Promise<boolean>;
  read(id: string): Promise<CatalogAgent | undefined>;
  /** Read-modify-write one agent atomically. Returning `{}` writes nothing.
   * With `fence`, nothing is written when a newer observation of
   * `fence.repository` than `fence.at` has claimed publication. */
  mutate(
    id: string,
    change: (current: CatalogAgent | undefined) => { agent?: CatalogAgent },
    fence?: { repository: string; at: string },
  ): Promise<{ agent?: CatalogAgent }>;
}

export class FirestoreAgentStore implements AgentStore {
  constructor(private readonly database: Firestore) {}
  private get collection() {
    return this.database.collection('orchestrator-agents');
  }
  async list(): Promise<CatalogAgent[]> {
    const snapshot = await this.collection.get();
    return snapshot.docs.map((doc) => catalogAgentSchema.parse(doc.data()));
  }
  private source(repository: string) {
    return this.database
      .collection('orchestrator-agent-sources')
      .doc(jobDigest(['agent-source', repository]));
  }
  async sources(): Promise<AgentSource[]> {
    const snapshot = await this.database
      .collection('orchestrator-agent-sources')
      .get();
    return snapshot.docs.map((doc) => agentSourceSchema.parse(doc.data()));
  }
  async recordAttempt(repository: string, at: string): Promise<void> {
    await this.source(repository).set(
      { repository, attemptedAt: at },
      { merge: true },
    );
  }
  async claimObservation(repository: string, at: string): Promise<boolean> {
    const ref = this.source(repository);
    return this.database.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const source = current.exists
        ? agentSourceSchema.parse(current.data())
        : undefined;
      if (source?.observedAt && Date.parse(source.observedAt) > Date.parse(at))
        return false;
      transaction.set(ref, { repository, observedAt: at }, { merge: true });
      return true;
    });
  }
  async read(id: string): Promise<CatalogAgent | undefined> {
    const snapshot = await this.collection.doc(hash.parse(id)).get();
    return snapshot.exists
      ? catalogAgentSchema.parse(snapshot.data())
      : undefined;
  }
  async mutate(
    id: string,
    change: Parameters<AgentStore['mutate']>[1],
    fence?: Parameters<AgentStore['mutate']>[2],
  ): ReturnType<AgentStore['mutate']> {
    const ref = this.collection.doc(hash.parse(id));
    return this.database.runTransaction(async (transaction) => {
      if (fence) {
        const source = await transaction.get(this.source(fence.repository));
        const observedAt = source.exists
          ? agentSourceSchema.parse(source.data()).observedAt
          : undefined;
        if (observedAt && Date.parse(observedAt) > Date.parse(fence.at))
          return {};
      }
      const current = await transaction.get(ref);
      const result = change(
        current.exists ? catalogAgentSchema.parse(current.data()) : undefined,
      );
      // Strip undefined optional properties; Firestore cannot store them.
      if (result.agent)
        transaction.set(
          ref,
          JSON.parse(JSON.stringify(catalogAgentSchema.parse(result.agent))),
        );
      return result;
    });
  }
}
