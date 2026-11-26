import 'server-only';

import { required } from '@agent-lcars/util-server';
import type { OutlineEventNotice } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';

// Source and receipt metadata outlive the host subscription's seven-day
// retention, then Firestore TTL removes it. Creator observations are durable.
const expiresAt = () => new Date(Date.now() + 14 * 24 * 60 * 60_000);

export const OUTLINE_AGENT_DOCUMENTS = 'outlineAgentDocuments';

export interface OutlineDocumentObservation {
  readonly agentCreated: boolean;
  readonly everSubscribed?: boolean;
  readonly creatorVerified?: boolean;
}
export interface OutlineDeliveryReceipt {
  readonly deliveryId: string;
  readonly host: string;
  readonly notice: OutlineEventNotice;
}
export interface OutlineEventStore {
  saveNotice(notice: OutlineEventNotice): Promise<void>;
  notice(id: string): Promise<OutlineEventNotice | undefined>;
  wasRouted(noticeId: string): Promise<boolean>;
  markRouted(noticeId: string): Promise<void>;
  observe(documentId: string, agentCreated: boolean): Promise<void>;
  document(documentId: string): Promise<OutlineDocumentObservation | undefined>;
  subscribed(documentId: string): Promise<void>;
  saveReceipt(receipt: OutlineDeliveryReceipt): Promise<void>;
  receipt(deliveryId: string): Promise<OutlineDeliveryReceipt | undefined>;
}

/** Only immutable identifiers, positive creator observations and host delivery
 * receipts. There is no second document-to-terminal registration map. */
export class FirestoreOutlineEventStore implements OutlineEventStore {
  constructor(private readonly firestore: () => Firestore) {}

  async saveNotice(notice: OutlineEventNotice) {
    await this.firestore()
      .collection('outlineAgentNotices')
      .doc(notice.deliveryId)
      .set({ ...notice, expiresAt: expiresAt() }, { merge: true });
  }
  async notice(id: string) {
    const result = await this.firestore()
      .collection('outlineAgentNotices')
      .doc(id)
      .get();
    if (!result.exists) return undefined;
    const {
      expiresAt: _expiry,
      routed: _routed,
      ...notice
    } = result.data() ?? {};
    return notice as OutlineEventNotice;
  }
  async wasRouted(noticeId: string) {
    const result = await this.firestore()
      .collection('outlineAgentNotices')
      .doc(noticeId)
      .get();
    return result.data()?.routed === true;
  }
  async markRouted(noticeId: string) {
    await this.firestore()
      .collection('outlineAgentNotices')
      .doc(noticeId)
      .set({ routed: true }, { merge: true });
  }
  async observe(documentId: string, agentCreated: boolean) {
    await this.firestore()
      .collection(OUTLINE_AGENT_DOCUMENTS)
      .doc(documentId)
      .set({ agentCreated, creatorVerified: true }, { merge: true });
  }
  async document(documentId: string) {
    const result = await this.firestore()
      .collection(OUTLINE_AGENT_DOCUMENTS)
      .doc(documentId)
      .get();
    return result.exists
      ? (result.data() as OutlineDocumentObservation)
      : undefined;
  }
  async subscribed(documentId: string) {
    await this.firestore()
      .collection(OUTLINE_AGENT_DOCUMENTS)
      .doc(documentId)
      .set({ everSubscribed: true }, { merge: true });
  }
  async saveReceipt(receipt: OutlineDeliveryReceipt) {
    await this.firestore()
      .collection('outlineAgentReceipts')
      .doc(encodeURIComponent(receipt.deliveryId))
      .set({ ...receipt, expiresAt: expiresAt() });
  }
  async receipt(deliveryId: string) {
    const result = await this.firestore()
      .collection('outlineAgentReceipts')
      .doc(encodeURIComponent(deliveryId))
      .get();
    return result.exists
      ? (result.data() as OutlineDeliveryReceipt)
      : undefined;
  }
}

let firestore: Firestore | undefined;
export const outlineEventStore: OutlineEventStore =
  new FirestoreOutlineEventStore(() => {
    firestore ??= new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    });
    return firestore;
  });
