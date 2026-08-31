import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod';

import {
  dispatchesContract,
  itemsContract,
  runsContract,
  schedulesContract,
} from './contract';

/** The document `docs/api/work-v1.openapi.json` is generated from. */
export async function generateWorkOpenApi(): Promise<object> {
  const generator = new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(
    {
      items: itemsContract,
      schedules: schedulesContract,
      dispatches: dispatchesContract,
      runs: runsContract,
    },
    {
      base: {
        info: { title: 'Agent LCARS work items', version: '1' },
        servers: [{ url: '/api/work/v1' }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            runToken: {
              type: 'http',
              scheme: 'bearer',
              description: 'A run claim token minted by POST /runs/claim.',
            },
          },
        },
      },
    },
  );
}
