import { WORK_ID_RE } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import {
  itemsContract,
  schedulesContract,
  WORK_ID_PATTERN,
  workIdSchema,
} from './contract';
import { generateWorkOpenApi } from './openapi';

describe('WORK_ID_PATTERN', () => {
  it('is the same ULID pattern the orchestrator uses (CLI-bundle safety: no import of it here)', () => {
    expect(String(WORK_ID_PATTERN)).toBe(String(WORK_ID_RE));
    expect(workIdSchema.safeParse('01J5Z3K9QX8F0N2B4V6C8D1E3G').success).toBe(
      true,
    );
    expect(workIdSchema.safeParse('not-a-ulid').success).toBe(false);
  });
});

describe('itemsContract', () => {
  it('declares the five item procedures', () => {
    expect(Object.keys(itemsContract).sort()).toEqual([
      'cancel',
      'create',
      'get',
      'list',
      'redispatch',
    ]);
  });
});

describe('schedulesContract', () => {
  it('declares the six schedule procedures', () => {
    expect(Object.keys(schedulesContract).sort()).toEqual([
      'create',
      'disable',
      'enable',
      'get',
      'list',
      'tick',
    ]);
  });
});

describe('generateWorkOpenApi', () => {
  it('emits both the items and schedules REST routes with bearer security', async () => {
    const doc = (await generateWorkOpenApi()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/items',
      '/items/{id}',
      '/items/{id}/cancel',
      '/items/{id}/redispatch',
      '/schedules',
      '/schedules/tick',
      '/schedules/{id}',
      '/schedules/{id}/disable',
      '/schedules/{id}/enable',
    ]);
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('documents every status each route can actually answer with', async () => {
    // The failure this guards is a handler throwing a status the contract
    // never declared: it maps correctly at runtime (oRPC's
    // COMMON_ERROR_STATUS_MAP) while the published document quietly omits
    // it, so a client generated from this file has no branch for it.
    // `redispatch` shipped exactly that way -- it re-checks the pipeline
    // grant and the target repo's control-plane membership, both 403,
    // with no FORBIDDEN in its errors map.
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    const statuses = Object.fromEntries(
      Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => [
          `${method.toUpperCase()} ${path}`,
          Object.keys(operation.responses).sort(),
        ]),
      ),
    );

    expect(statuses).toEqual({
      // 201 always, replay included -- see the create meta's
      // successDescription.
      'PUT /items/{id}': ['201', '403', '409', '429'],
      'GET /items/{id}': ['200', '404'],
      'GET /items': ['200'],
      'POST /items/{id}/cancel': ['200', '404', '409'],
      'POST /items/{id}/redispatch': ['200', '403', '404', '409', '429'],
      'PUT /schedules/{id}': ['201', '400', '403', '409'],
      'GET /schedules/{id}': ['200', '404'],
      'GET /schedules': ['200'],
      'POST /schedules/{id}/enable': ['200', '404'],
      'POST /schedules/{id}/disable': ['200', '404'],
      'POST /schedules/tick': ['200'],
    });
  });
});
