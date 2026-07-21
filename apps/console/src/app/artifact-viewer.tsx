'use client';

import { Anchor, Box, Group, Loader, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type ArtifactKind = 'markdown' | 'image' | 'pdf' | 'other';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** Only these kinds get a built-in preview; everything else stays link-out
 * only (see #2631 - inline rendering is scoped to markdown/image/pdf). */
export function classifyArtifact(filename: string): ArtifactKind {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext !== undefined && IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; content: string };

/**
 * Fetched browser-side, not through the console's backend: the console runs
 * on Firebase App Hosting (GCP) and cannot reach the LAN-only share host,
 * but the operator's browser is on the VPN (issue #2631 decision (d) -
 * transport is "solved enough" via the existing share.lan.jlapenna.net URL).
 */
function MarkdownPreview({ url }: { url: string }) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((content) => {
        if (!cancelled) setState({ status: 'ready', content });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to load',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state.status === 'loading') return <Loader size="xs" />;
  if (state.status === 'error') {
    return (
      <Text size="xs" c="red">
        Failed to load artifact: {state.message}
      </Text>
    );
  }
  return (
    <Box
      style={{
        maxHeight: 400,
        overflow: 'auto',
        fontSize: 'var(--mantine-font-size-xs)',
      }}
    >
      {/* No rehype-raw plugin: raw HTML embedded in the markdown is never
       * rendered, only escaped, and react-markdown's default urlTransform
       * strips dangerous link/image schemes (e.g. javascript:) - this is
       * agent-generated content, so it's treated as untrusted input. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
    </Box>
  );
}

function ArtifactPreview({
  kind,
  url,
  filename,
}: {
  kind: ArtifactKind;
  url: string;
  filename: string;
}) {
  if (kind === 'markdown') return <MarkdownPreview url={url} />;
  if (kind === 'image') {
    // Plain <img>, not next/image: host is a per-session LAN URL, not
    // something next/image's static remotePatterns config can express.
    return (
      <img
        src={url}
        alt={filename}
        style={{ maxWidth: '100%', maxHeight: 400, display: 'block' }}
      />
    );
  }
  return (
    <iframe
      src={url}
      title={filename}
      sandbox=""
      style={{ width: '100%', height: 400, border: 'none' }}
    />
  );
}

/**
 * Toggle placed next to an artifact's link-out anchor. Renders nothing for
 * file types outside the reviewed set (issue #2631 scope: markdown, images,
 * PDFs) - those stay link-out/download only via the existing anchor.
 */
export function ArtifactPreviewToggle({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  const kind = classifyArtifact(filename);
  const [open, setOpen] = useState(false);

  if (kind === 'other') return null;

  return (
    <Box>
      <Anchor
        component="button"
        type="button"
        size="xs"
        c="dimmed"
        onClick={() => setOpen((prev) => !prev)}
        data-testid={`artifact-toggle-${filename}`}
      >
        <Group gap={2} wrap="nowrap">
          {open ? (
            <IconChevronDown size={12} aria-hidden="true" />
          ) : (
            <IconChevronRight size={12} aria-hidden="true" />
          )}
          preview
        </Group>
      </Anchor>
      {open && (
        <Box mt={4} mb={4} data-testid={`artifact-preview-${filename}`}>
          <ArtifactPreview kind={kind} url={url} filename={filename} />
        </Box>
      )}
    </Box>
  );
}
