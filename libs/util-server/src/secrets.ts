import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logger } from '@members/logging';

const client = new SecretManagerServiceClient({ fallback: 'rest' });

const secretPromiseCache = new Map<string, Promise<string | null>>();

export async function getSecret(
  name: string,
  defaultValue: string,
): Promise<string>;
export async function getSecret(
  name: string,
  defaultValue: null,
): Promise<string | null>;
export async function getSecret(name: string): Promise<string>;
export async function getSecret(
  name: string,
  defaultValue?: string | null,
): Promise<string | null> {
  let promise = secretPromiseCache.get(name);
  if (!promise) {
    promise = client
      .accessSecretVersion({
        name: name,
      })
      .then(([version]) => {
        return version.payload?.data?.toString() ?? null;
      })
      .catch((err) => {
        secretPromiseCache.delete(name);
        throw err;
      });
    secretPromiseCache.set(name, promise);
  }

  const cached = await promise;
  const secretValue = cached ?? defaultValue;
  if (secretValue === undefined || secretValue === null) {
    if (defaultValue === undefined) {
      throw new Error(
        `Secret not found or empty for: ${name} (default: ${defaultValue})`,
      );
    }
    return defaultValue;
  }
  return secretValue;
}

/**
 * Create or update a secret in Google Cloud Secret Manager
 */
export async function upsertSecret(
  client: SecretManagerServiceClient,
  projectId: string,
  secretId: string,
  value: string,
  force: boolean,
): Promise<'created' | 'updated' | 'skipped'> {
  const parent = `projects/${projectId}`;
  const secretName = `${parent}/secrets/${secretId}`;

  try {
    // Check if secret exists
    await client.getSecret({ name: secretName });

    try {
      const [latestVersion] = await client.accessSecretVersion({
        name: `${secretName}/versions/latest`,
      });
      const latestValue = latestVersion.payload?.data?.toString();
      if (latestValue === value) {
        logger.info(`ℹ️  Secret ${secretId} value is unchanged (skipping)`);
        return 'skipped';
      }
    } catch (_versionError: unknown) {
      // Ignore errors here; if we can't access the latest version, fall through to add a new one.
    }

    if (!force) {
      logger.info(
        `⚠️  Secret ${secretId} already exists (use --force to update)`,
      );
      return 'skipped';
    }

    // Add a new version to existing secret
    await client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from(value, 'utf8'),
      },
    });

    logger.info(`✅ Updated secret: ${secretId}`);
    return 'updated';
  } catch (error: unknown) {
    const err = error as { code?: number };
    if (err.code === 5) {
      // Secret doesn't exist (NOT_FOUND), try to create it
      try {
        await client.createSecret({
          parent,
          secretId,
          secret: {
            replication: {
              automatic: {},
            },
          },
        });
      } catch (createErr: unknown) {
        const cErr = createErr as { code?: number };
        // If it actually already exists (e.g. race condition or soft-deleted mismatch), just proceed to add version
        if (cErr.code !== 6) {
          throw createErr;
        }
      }

      await client.addSecretVersion({
        parent: secretName,
        payload: {
          data: Buffer.from(value, 'utf8'),
        },
      });

      logger.info(`✅ Created/Updated secret: ${secretId}`);
      return 'created';
    }

    throw error;
  }
}
