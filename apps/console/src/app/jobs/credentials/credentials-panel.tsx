'use client';

import type {
  CredentialSet,
  JobCredentialGrant,
  JobSecretRecord,
} from '@agent-lcars/work';
import {
  Button,
  Group,
  Select,
  Stack,
  Table,
  Textarea,
  TextInput,
} from '@mantine/core';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { DetailWorkspace } from '../../detail-workspace';
import { OpsPanel } from '../../ops-primitives';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/work/v1/credentials${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(
      'Credential operation refused. Check access, the registered secret and the submitted definition.',
    );
  return response.json() as Promise<T>;
}
async function readRegistry() {
  const [secrets, sets, grants] = await Promise.all([
    api<JobSecretRecord[]>('/secrets'),
    api<CredentialSet[]>('/sets'),
    api<JobCredentialGrant[]>('/grants'),
  ]);
  return { secrets, sets, grants };
}

export function JobCredentialsPanel() {
  const [registry, setRegistry] =
    useState<Awaited<ReturnType<typeof readRegistry>>>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('opaque');
  const [login, setLogin] = useState('');
  const [selected, setSelected] = useState('');
  const [value, setValue] = useState('');
  const [version, setVersion] = useState('');
  const [operation, setOperation] = useState('sets');
  const [definition, setDefinition] = useState('');
  useEffect(() => {
    let active = true;
    void readRegistry()
      .then((result) => {
        if (active) setRegistry(result);
      })
      .catch(() => {
        if (active)
          setError(
            'Credential registry could not be loaded. Check your administration grant and the secret-store configuration.',
          );
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(work: () => Promise<unknown>, success: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setRegistry(await readRegistry());
      setNotice(success);
    } catch {
      setError(
        'Credential operation refused. Check access, the registered secret and the submitted definition.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const secretOptions = registry?.secrets.map((secret) => secret.name) ?? [];
  return (
    <DetailWorkspace ariaLabel="Job credentials">
      <Group>
        <Link href="/jobs">Repository jobs</Link>
        <Button
          variant="light"
          disabled={busy}
          onClick={() => void act(async () => undefined, 'Registry refreshed')}
        >
          Refresh
        </Button>
      </Group>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <OpsPanel title="Secrets" className="settings-panel">
        <p>
          Values are accepted when uploading a version and are never shown in
          this list.
        </p>
        <Table.ScrollContainer minWidth={700}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Identity</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Expiry</Table.Th>
                <Table.Th>Last use</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {registry?.secrets.map((secret) => (
                <Table.Tr key={secret.name}>
                  <Table.Td>{secret.name}</Table.Td>
                  <Table.Td>{secret.login ?? secret.kind}</Table.Td>
                  <Table.Td>
                    {secret.promotedVersion ?? 'Not promoted'}
                  </Table.Td>
                  <Table.Td>{secret.enabled ? 'Enabled' : 'Disabled'}</Table.Td>
                  <Table.Td>{secret.expiresAt ?? 'Not declared'}</Table.Td>
                  <Table.Td>{secret.lastUsedAt ?? 'Never'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {registry && registry.secrets.length === 0 && (
          <p>No secrets registered.</p>
        )}
      </OpsPanel>
      <OpsPanel title="Register a secret" className="settings-panel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                api('/secrets', {
                  name,
                  kind,
                  ...(kind === 'github' ? { login } : {}),
                }),
              'Secret registered',
            );
          }}
        >
          <Stack>
            <TextInput
              required
              label="Secret name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Select
              label="Credential type"
              data={[
                { value: 'opaque', label: 'API key or file' },
                { value: 'github', label: 'GitHub token' },
              ]}
              value={kind}
              onChange={(next) => setKind(next ?? 'opaque')}
            />
            {kind === 'github' && (
              <TextInput
                required
                label="Expected GitHub login"
                value={login}
                onChange={(event) => setLogin(event.currentTarget.value)}
              />
            )}
            <Button type="submit" disabled={busy}>
              Register
            </Button>
          </Stack>
        </form>
      </OpsPanel>
      <OpsPanel title="Manage versions" className="settings-panel">
        <Stack>
          <Select
            label="Registered secret"
            disabled={busy}
            data={secretOptions}
            value={selected || null}
            onChange={(next) => {
              setSelected(next ?? '');
              setValue('');
              setVersion('');
            }}
            searchable
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = value;
              setValue('');
              void act(async () => {
                const result = await api<{ version: string }>(
                  `/secrets/${selected}/versions`,
                  { value: submitted },
                );
                setVersion(result.version);
              }, 'Version validated and uploaded. Promote it when ready.');
            }}
          >
            <Stack>
              <Textarea
                label="New secret value"
                description="For GitHub, provide a token and expiresAt JSON record. Input is cleared on submission."
                required
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
              <Button type="submit" disabled={busy || !selected}>
                Upload version
              </Button>
            </Stack>
          </form>
          <TextInput
            label="Version to promote"
            value={version}
            onChange={(event) => setVersion(event.currentTarget.value)}
          />
          <Group>
            <Button
              disabled={busy || !selected || !/^[1-9][0-9]*$/u.test(version)}
              onClick={() =>
                void act(
                  () => api(`/secrets/${selected}/promote`, { version }),
                  'Version promoted for new job occurrences',
                )
              }
            >
              Promote version
            </Button>
            <Button
              variant="light"
              disabled={busy || !selected}
              onClick={() =>
                void act(
                  () => api(`/secrets/${selected}/disable`, {}),
                  'Further delivery of this secret is disabled',
                )
              }
            >
              Disable delivery
            </Button>
            <Button
              variant="light"
              disabled={busy || !selected}
              onClick={() =>
                void act(
                  () => api(`/secrets/${selected}/enable`, {}),
                  'Secret validated and delivery enabled',
                )
              }
            >
              Enable delivery
            </Button>
          </Group>
        </Stack>
      </OpsPanel>
      <OpsPanel
        title="Credential sets and job access"
        className="settings-panel"
      >
        <p>
          Set revisions are immutable. Grants authorize an exact repository,
          job, profile and set revision.
        </p>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Set</Table.Th>
                <Table.Th>Bindings</Table.Th>
                <Table.Th>Consumers</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {registry?.sets.map((set) => (
                <Table.Tr key={`${set.name}-${set.revision}`}>
                  <Table.Td>
                    {set.name} · revision {set.revision}
                  </Table.Td>
                  <Table.Td>
                    {[
                      set.github,
                      ...Object.values(set.environment),
                      ...Object.values(set.files),
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </Table.Td>
                  <Table.Td>
                    {registry.grants
                      .filter(
                        (grant) =>
                          grant.credentialSet.name === set.name &&
                          grant.credentialSet.revision === set.revision,
                      )
                      .map(
                        (grant) =>
                          `${grant.repository}:${grant.job} (${grant.enabled ? (grant.allowScheduled ? 'manual and scheduled' : 'manual') : 'revoked'})`,
                      )
                      .join(', ') || 'None'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () => api(`/${operation}`, JSON.parse(definition)),
              operation === 'sets'
                ? 'Credential set revision published'
                : 'Job access updated',
            );
          }}
        >
          <Stack>
            <Select
              label="Definition type"
              data={[
                { value: 'sets', label: 'Credential set revision' },
                { value: 'grants', label: 'Job access grant' },
              ]}
              value={operation}
              onChange={(next) => setOperation(next ?? 'sets')}
            />
            <Textarea
              required
              label="Definition JSON"
              description="Secret references only. Set enabled to false on a job grant to revoke it."
              minRows={6}
              value={definition}
              onChange={(event) => setDefinition(event.currentTarget.value)}
            />
            <Button type="submit" disabled={busy}>
              Save definition
            </Button>
          </Stack>
        </form>
      </OpsPanel>
    </DetailWorkspace>
  );
}
