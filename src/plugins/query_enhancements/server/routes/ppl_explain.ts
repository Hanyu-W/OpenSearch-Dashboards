/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { IRouter, Logger, OpenSearchClient } from '../../../../core/server';
import { API, URI } from '../../common';
import { coerceStatusCode, DATASOURCE_UNAVAILABLE_MESSAGE, resolveOpenSearchClient } from '.';

function callExplain(client: OpenSearchClient, query: string, useJsonTree: boolean) {
  return client.transport.request({
    method: 'POST',
    path: `${URI.PPL}/_explain`,
    ...(useJsonTree ? { querystring: { format: 'json_tree' } } : {}),
    body: { query },
  });
}

function explainErrorMessage(err: unknown): string {
  const e = err as { message?: string; body?: unknown; meta?: { body?: unknown } };
  return [e.message, e.body, e.meta?.body]
    .map((value) => {
      if (typeof value === 'string') {
        return value;
      }
      try {
        return JSON.stringify(value ?? '');
      } catch {
        return '';
      }
    })
    .join(' ');
}

function isUnsupportedJsonTreeError(err: unknown): boolean {
  const message = explainErrorMessage(err).toLowerCase();
  return (
    message.includes('json_tree') &&
    (message.includes('unknown response format') ||
      message.includes('unsupported') ||
      message.includes('illegal_argument_exception'))
  );
}

/**
 * Defines the PPL explain proxy route. Forwards a query to OpenSearch
 * `POST /_plugins/_ppl/_explain`, which plans the query without executing it and
 * returns the Calcite physical plan. The explain-backed lint rules read that
 * plan to flag pushdown anti-patterns. Modeled on `definePPLBundleRoute`.
 *
 * The response is the unwrapped transport body (`result.body ?? result`), which
 * matches `definePPLBundleRoute`. The client parser must validate the plan shape
 * before reading it rather than assume a fixed envelope.
 */
export function definePPLExplainRoute(logger: Logger, router: IRouter) {
  router.post(
    {
      path: API.PPL_EXPLAIN,
      validate: {
        // maxLength is belt-and-suspenders: OSD's server.maxPayload (1 MiB default)
        // already bounds the body. 64 KB is 2-4x the largest realistic interactive
        // PPL pipeline, and makes the cap explicit + independent of global config.
        body: schema.object({ query: schema.string({ minLength: 1, maxLength: 65536 }) }),
        query: schema.object({ dataSourceId: schema.maybe(schema.string()) }),
      },
    },
    async (context, req, res) => {
      try {
        const { dataSourceId } = req.query;
        const client = await resolveOpenSearchClient(context, dataSourceId);
        if (!client) {
          return res.custom({ statusCode: 400, body: DATASOURCE_UNAVAILABLE_MESSAGE });
        }

        let result: any;
        try {
          result = await callExplain(client, req.body.query, true);
        } catch (err) {
          if (!isUnsupportedJsonTreeError(err)) {
            throw err;
          }
          logger.debug('PPL explain json_tree unsupported; retrying without format=json_tree');
          result = await callExplain(client, req.body.query, false);
        }

        const body = result?.body ?? result;
        return res.ok({ body });
      } catch (err) {
        const e = err as {
          message?: string;
          status?: number;
          statusCode?: number;
          meta?: { statusCode?: number };
        };
        const message = e.message ?? 'Failed to explain PPL query';
        logger.debug(`PPL explain error: ${message}`);
        return res.custom({
          statusCode: coerceStatusCode(e.status ?? e.statusCode ?? e.meta?.statusCode),
          body: message,
        });
      }
    }
  );
}
