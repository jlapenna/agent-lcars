import 'server-only';

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const identitiesSchema = z
  .array(
    z.strictObject({
      poolId: z.string().min(1).max(175),
      issuer: z.url().startsWith('https://'),
      jwksUri: z.url().startsWith('https://'),
      audience: z.string().min(1).max(175),
      namespace: z.string().min(1).max(175),
      serviceAccountUid: z.string().min(1).max(175),
    }),
  )
  .max(16);
const clients = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Trust roots are deployment-owned configuration, never supplied in an API
 * request. A projected Kubernetes service-account token must be Pod-bound;
 * generic service-account/OIDC/run tokens cannot assert an arbitrary Pod UID. */
export async function verifyCapacityWorkerIdentity(
  token: string,
  poolId: string,
  verificationKey?: Parameters<typeof jwtVerify>[1],
): Promise<{ podUid: string; namespace: string }> {
  const identities = identitiesSchema.parse(
    JSON.parse(process.env['AGENT_LCARS_CAPACITY_WORKER_IDENTITIES'] ?? '[]'),
  );
  const identity = identities.find((value) => value.poolId === poolId);
  if (identity === undefined)
    throw new Error('No declared capacity worker identity');
  let jwks = clients.get(identity.jwksUri);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(identity.jwksUri), {
      timeoutDuration: 5000,
      cacheMaxAge: 600_000,
    });
    clients.set(identity.jwksUri, jwks);
  }
  const { payload } = await jwtVerify(token, verificationKey ?? jwks, {
    issuer: identity.issuer,
    audience: identity.audience,
    algorithms: ['RS256', 'ES256'],
  });
  const bound = z
    .object({
      namespace: z.literal(identity.namespace),
      pod: z.object({ uid: z.string().min(1).max(175) }),
      serviceaccount: z.object({ uid: z.literal(identity.serviceAccountUid) }),
    })
    .parse(payload['kubernetes.io']);
  return { podUid: bound.pod.uid, namespace: bound.namespace };
}
