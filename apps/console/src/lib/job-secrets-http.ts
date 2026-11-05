import 'server-only';

import {
  credentialSetSchema,
  jobCredentialGrantSchema,
  jobSecretNameSchema,
  jobSecretRecordSchema,
  jobSecretValueSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { JobSecrets } from './job-secrets';
import { jobSecrets } from './job-secrets-runtime';
import { readJobBody } from './repository-job-body';
import type { WorkPrincipal } from './work-auth';

/** Secret administration is separate from Work invocation. Repository-bound
 * automation and run/executor credentials can never administer this registry. */
export async function jobSecretsHttp(
  request: Request,
  principal: WorkPrincipal | undefined,
  service: () => JobSecrets | undefined = jobSecrets,
): Promise<Response> {
  if (
    !principal?.scopes.has('secrets.admin') ||
    principal.sourceRepository !== undefined
  )
    return Response.json(
      { error: 'secrets.admin scope required' },
      { status: 403 },
    );
  try {
    const secrets = service();
    if (!secrets)
      return Response.json(
        { error: 'LCARS secret store is not configured' },
        { status: 409 },
      );
    const path = new URL(request.url).pathname.slice(
      '/api/work/v1/credentials'.length,
    );
    const collection = /^\/(secrets|sets|grants)$/u.exec(path)?.[1];
    if (request.method === 'GET' && collection) {
      const schema =
        collection === 'secrets'
          ? jobSecretRecordSchema
          : collection === 'sets'
            ? credentialSetSchema
            : jobCredentialGrantSchema;
      const values = await secrets.store.list(
        collection as 'secrets' | 'sets' | 'grants',
      );
      return Response.json(values.map((value) => schema.parse(value)));
    }
    if (request.method !== 'POST')
      return Response.json({ error: 'Not found' }, { status: 404 });
    const body: unknown = JSON.parse(await readJobBody(request, 131072));
    const actor = principal.principal;
    if (path === '/secrets') {
      const input = z
        .strictObject({
          name: jobSecretNameSchema,
          kind: jobSecretRecordSchema.shape.kind,
          login: jobSecretRecordSchema.shape.login,
        })
        .parse(body);
      return Response.json(
        await secrets.register({
          ...input,
          enabled: true,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
        }),
      );
    }
    if (path === '/sets')
      return Response.json(
        await secrets.publish(credentialSetSchema.parse(body), actor),
      );
    if (path === '/grants')
      return Response.json(
        await secrets.grant(jobCredentialGrantSchema.parse(body), actor),
      );
    const match =
      /^\/secrets\/([a-z][a-z0-9-]{0,63})\/(versions|promote|disable|enable)$/u.exec(
        path,
      );
    if (!match) return Response.json({ error: 'Not found' }, { status: 404 });
    const name = jobSecretNameSchema.parse(match[1]);
    if (match[2] === 'versions') {
      const { value } = z
        .strictObject({ value: jobSecretValueSchema })
        .parse(body);
      return Response.json(await secrets.upload(name, value, actor));
    }
    if (match[2] === 'promote') {
      const { version } = z
        .strictObject({ version: z.string().regex(/^[1-9][0-9]*$/u) })
        .parse(body);
      return Response.json(await secrets.promote(name, version, actor));
    }
    z.strictObject({}).parse(body);
    return Response.json(
      await secrets.setEnabled(name, match[2] === 'enable', actor),
    );
  } catch {
    // Validation and authenticated SDK errors may contain secret input. Never
    // serialize the original error or log the request body at this boundary.
    return Response.json(
      {
        error:
          'Credential operation refused or unavailable; check configuration, permissions and validated input',
      },
      { status: 409 },
    );
  }
}
