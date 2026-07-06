import type { EnvVars } from './env-vars';

const isTrueValue = (value: string | undefined): boolean => {
  return typeof value === 'string' && value.toLowerCase() === 'true';
};

export const isTrue = (key: keyof EnvVars): boolean => {
  return isTrueValue(optional(key));
};

const sanitize = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'undefined' || lower === 'null') return undefined;
  return value;
};

export const optional = (key: keyof EnvVars): string | undefined => {
  const value = (process.env as unknown as Record<string, string | undefined>)[
    key as string
  ];
  return sanitize(value);
};

export const required = (key: keyof EnvVars): string => {
  const value = optional(key);
  if (value === undefined) {
    throw new Error(`process.env.${key as string} not defined`);
  }
  return value;
};

export const getEnvValue = (key: keyof EnvVars): string | undefined =>
  optional(key);

export const splitEnvList = (key: keyof EnvVars): string[] => {
  const value = optional(key);
  return (value ?? '')
    .split(/[:,]/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
};
