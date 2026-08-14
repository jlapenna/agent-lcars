'use client';

import { Box, Button, Group, Image, Paper, Stack, Text } from '@mantine/core';
import { useEffect, useId, useRef, useState } from 'react';

import {
  QUICK_TASK_EVIDENCE_DISCLOSURE_WARNING,
  QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES,
  QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES,
} from '../lib/quick-task-evidence-contract';

const ACCEPTED_IMAGE_TYPES = new Set<string>(
  QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES,
);

function localFileError(file: File): string | undefined {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    return 'Choose a PNG, JPEG, or WebP image.';
  }
  if (file.size === 0) return 'Choose a non-empty image.';
  if (file.size > QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES) {
    return 'Choose an image no larger than 10 MiB.';
  }
  return undefined;
}

/**
 * Client-side picker only. The multipart route validates all bytes again;
 * this component offers early feedback and preserves the selected File for
 * the caller's retry closure.
 */
export function QuickTaskScreenshotField({
  value,
  onChange,
  disabled = false,
}: {
  value?: File;
  onChange: (file: File | undefined) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();

  useEffect(() => {
    if (!value) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  const adopt = (file: File | undefined) => {
    if (!file || disabled) return;
    const nextError = localFileError(file);
    setError(nextError);
    if (!nextError) onChange(file);
  };

  const chooseFromInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    adopt(event.currentTarget.files?.[0]);
    // Selecting the same file again after remove/replace must still emit.
    event.currentTarget.value = '';
  };

  return (
    <Stack gap="xs">
      <Box>
        <Text component="label" htmlFor={inputId} fw={500} size="sm">
          Screenshot (optional)
        </Text>
        <Text size="xs" c="dimmed">
          PNG, JPEG, or WebP; up to 10 MiB.
        </Text>
      </Box>
      <Text size="xs" c="orange" role="note">
        {QUICK_TASK_EVIDENCE_DISCLOSURE_WARNING}
      </Text>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES.join(',')}
        tabIndex={-1}
        onChange={chooseFromInput}
        disabled={disabled}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
      />
      <Paper
        withBorder
        p="sm"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Paste or drop a screenshot"
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onPaste={(event) => adopt(event.clipboardData.files[0])}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          adopt(event.dataTransfer.files[0]);
        }}
      >
        <Text size="sm">Choose, paste, or drop a screenshot</Text>
      </Paper>
      {error && (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
      {value && previewUrl && (
        <Group align="flex-start" wrap="nowrap">
          <Image
            src={previewUrl}
            alt={`Screenshot preview: ${value.name}`}
            w={160}
            h={100}
            fit="contain"
          />
          <Stack gap="xs">
            <Text size="sm">{value.name}</Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => {
                setError(undefined);
                onChange(undefined);
              }}
              disabled={disabled}
            >
              Remove screenshot
            </Button>
          </Stack>
        </Group>
      )}
    </Stack>
  );
}
