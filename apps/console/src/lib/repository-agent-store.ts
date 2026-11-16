import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { agentDefinitionSchema } from './repository-agent-definition';

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

export interface AgentStore {
  list(): Promise<CatalogAgent[]>;
  read(id: string): Promise<CatalogAgent | undefined>;
  /** Read-modify-write one agent atomically. Returning `{}` writes nothing. */
  mutate(
    id: string,
    change: (current: CatalogAgent | undefined) => { agent?: CatalogAgent },
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
  async read(id: string): Promise<CatalogAgent | undefined> {
    const snapshot = await this.collection.doc(hash.parse(id)).get();
    return snapshot.exists
      ? catalogAgentSchema.parse(snapshot.data())
      : undefined;
  }
  async mutate(
    id: string,
    change: Parameters<AgentStore['mutate']>[1],
  ): ReturnType<AgentStore['mutate']> {
    const ref = this.collection.doc(hash.parse(id));
    return this.database.runTransaction(async (transaction) => {
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
