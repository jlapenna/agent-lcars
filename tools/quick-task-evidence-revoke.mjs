import { Storage } from '@google-cloud/storage';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function value(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function redactEvidenceId(evidenceId) {
  return `${evidenceId.slice(0, 8)}…`;
}

export function parseRevokeArgs(args) {
  const input = {
    bucket: value(args, '--bucket'),
    repositoryId: value(args, '--repository-id'),
    requestId: value(args, '--request-id'),
    evidenceId: value(args, '--evidence-id'),
    generation: value(args, '--generation'),
    apply: args.includes('--apply'),
  };
  if (
    !input.bucket ||
    !input.repositoryId ||
    !input.requestId ||
    !input.generation ||
    !input.evidenceId ||
    !UUID_V4.test(input.evidenceId) ||
    !/^\d+$/u.test(input.repositoryId) ||
    !/^\d+$/u.test(input.generation)
  ) {
    throw new Error(
      'Usage: --bucket <name> --repository-id <number> --request-id <uuid> --evidence-id <uuid-v4> --generation <number> [--apply]',
    );
  }
  return input;
}

function exactBinding(metadata, input) {
  const binding = metadata.metadata ?? {};
  return (
    binding.schemaVersion === 'v1' &&
    binding.evidenceId === input.evidenceId &&
    binding.repositoryId === input.repositoryId &&
    binding.requestId === input.requestId &&
    String(metadata.generation) === input.generation
  );
}

/**
 * Terminal revocation: verify the complete immutable binding, create the
 * permanent tombstone, then delete exactly the observed byte generation.
 */
export async function revokeEvidence(bucket, input) {
  const object = bucket.file(`objects/v1/${input.evidenceId}.webp`);
  const tombstone = bucket.file(`revocations/v1/${input.evidenceId}`);
  let metadata;
  try {
    [metadata] = await object.getMetadata();
  } catch {
    throw new Error('Evidence binding could not be verified');
  }
  if (!exactBinding(metadata, input)) {
    throw new Error('Evidence binding could not be verified');
  }
  const result = {
    evidence: redactEvidenceId(input.evidenceId),
    repositoryId: input.repositoryId,
    requestId: input.requestId,
    generation: input.generation,
    action: input.apply ? 'revoked' : 'dry-run',
  };
  if (!input.apply) return result;

  await tombstone.save('', {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      metadata: {
        schemaVersion: 'v1',
        evidenceId: input.evidenceId,
        repositoryId: input.repositoryId,
        requestId: input.requestId,
        generation: input.generation,
      },
    },
  });
  await object.delete({ ifGenerationMatch: Number(input.generation) });
  return result;
}

async function main() {
  const input = parseRevokeArgs(process.argv.slice(2));
  const result = await revokeEvidence(
    new Storage().bucket(input.bucket),
    input,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main().catch((_error) => {
    process.stderr.write('Quick Task evidence revocation failed.\n');
    process.exitCode = 1;
  });
}
