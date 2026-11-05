import 'server-only';

import { required } from '@agent-lcars/util-server';
import type { JobCredentialObservation } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';

import { GoogleJobSecretBackend } from './job-secret-backend';
import { FirestoreJobSecretStore } from './job-secret-store';
import { JobSecrets } from './job-secrets';

let instance: JobSecrets | undefined;
export function validateJobSecretDeployment() {
  const project = process.env['AGENT_LCARS_JOB_SECRETS_PROJECT'];
  const writer = process.env['AGENT_LCARS_JOB_SECRETS_WRITER'];
  if (!project && !writer) return;
  if (!project || !writer || project === process.env['PROJECT_ID'])
    throw new Error(
      'LCARS job secrets require a separate project and a writer identity',
    );
  new GoogleJobSecretBackend(project, writer);
}
export function jobSecrets(): JobSecrets | undefined {
  validateJobSecretDeployment();
  const project = process.env['AGENT_LCARS_JOB_SECRETS_PROJECT'];
  if (!project) return undefined;
  instance ??= new JobSecrets(
    new FirestoreJobSecretStore(
      new Firestore({
        projectId: required('PROJECT_ID'),
        databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
      }),
    ),
    new GoogleJobSecretBackend(
      project,
      required('AGENT_LCARS_JOB_SECRETS_WRITER'),
    ),
  );
  return instance;
}

export async function observeJobCredentials(): Promise<JobCredentialObservation> {
  try {
    const service = jobSecrets();
    if (service) return await service.observe();
    return {
      version: 1,
      observedAt: new Date().toISOString(),
      configured: false,
      metadataAvailable: false,
      dependency: 'disabled',
    };
  } catch {
    return {
      version: 1,
      observedAt: new Date().toISOString(),
      configured: true,
      metadataAvailable: false,
      dependency: 'unknown',
    };
  }
}
