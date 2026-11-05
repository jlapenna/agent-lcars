import 'server-only';

import { jobSecretNameSchema, jobSecretValueSchema } from '@agent-lcars/work';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { z } from 'zod';

export interface JobSecretBackend {
  checkContainer(name: string): Promise<void>;
  addVersion(name: string, value: string): Promise<string>;
  readVersion(name: string, version: string): Promise<string>;
}

/** All resources are constructed inside one LCARS-owned project. Callers can
 * never supply a project, URL, backend path, or unvalidated version selector. */
export class GoogleJobSecretBackend implements JobSecretBackend {
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  constructor(
    private readonly project: string,
    private readonly writer: string,
  ) {
    if (
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project) ||
      !/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(
        writer,
      )
    )
      throw new Error('Invalid LCARS job secret deployment configuration');
  }
  private resource(name: string) {
    return `projects/${this.project}/secrets/${jobSecretNameSchema.parse(name)}`;
  }
  private async request(path: string, data?: unknown): Promise<unknown> {
    try {
      const sourceClient = await this.auth.getClient();
      const client =
        data === undefined
          ? sourceClient
          : new Impersonated({
              sourceClient,
              targetPrincipal: this.writer,
              targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
              lifetime: 300,
            });
      const response = await client.request({
        url: `https://secretmanager.googleapis.com/v1/${path}`,
        method: data === undefined ? 'GET' : 'POST',
        ...(data === undefined ? {} : { data }),
        timeout: 10000,
        retry: false,
      });
      return response.data;
    } catch {
      // Authenticated client errors may carry headers or plaintext payloads.
      throw new Error('LCARS secret backend operation failed');
    }
  }
  async checkContainer(name: string) {
    const result = z
      .object({ labels: z.record(z.string(), z.string()).optional() })
      .parse(await this.request(this.resource(name)));
    if (result.labels?.['application'] !== 'lcars-job-secrets')
      throw new Error('Secret container is not provisioned for LCARS jobs');
  }
  async addVersion(name: string, value: string) {
    const resource = this.resource(name);
    const data = Buffer.from(jobSecretValueSchema.parse(value)).toString(
      'base64',
    );
    // Google returns project numbers in canonical resource names even when the
    // request uses a project ID. Resolve this exact container before writing.
    const canonicalResource = z
      .object({
        name: z
          .string()
          .regex(
            new RegExp(
              `^projects/(?:${this.project}|[0-9]+)/secrets/${name}$`,
              'u',
            ),
          ),
      })
      .parse(await this.request(resource)).name;
    const result = z.object({ name: z.string() }).parse(
      await this.request(`${resource}:addVersion`, {
        payload: { data },
      }),
    );
    if (!result.name.startsWith(`${canonicalResource}/versions/`))
      throw new Error('Unexpected secret version resource');
    return z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .parse(result.name.slice(`${canonicalResource}/versions/`.length));
  }
  async readVersion(name: string, version: string) {
    z.string()
      .regex(/^[1-9][0-9]*$/u)
      .parse(version);
    const result = z
      .object({ payload: z.object({ data: z.string().max(32768) }) })
      .parse(
        await this.request(`${this.resource(name)}/versions/${version}:access`),
      );
    return jobSecretValueSchema.parse(
      Buffer.from(result.payload.data, 'base64').toString('utf8'),
    );
  }
}
