/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { IRouter, Logger } from '../../../../core/server';
import { API } from '../../common';
import { DATASOURCE_UNAVAILABLE_MESSAGE, resolveOpenSearchClient } from '.';

// flat_settings keeps each calcite key as a literal dotted string
// ("plugins.calcite.enabled"), so the filter_path segments must escape those
// dots — filter_path treats an unescaped '.' as object nesting and would match
// nothing (returning an empty body, which the resolver below would misread as
// "calcite enabled"). '*.' matches the transient/persistent/defaults buckets.
const CALCITE_SETTINGS_PATH =
  '/_cluster/settings?flat_settings=true&include_defaults=true' +
  '&filter_path=*.plugins\\.calcite\\.enabled,*.plugins\\.calcite\\.all_join_types\\.allowed';

export function definePPLCalciteSettingsRoute(logger: Logger, router: IRouter) {
  router.get(
    {
      path: API.PPL_CALCITE_SETTINGS,
      validate: {
        query: schema.object({
          dataSourceId: schema.maybe(schema.string()),
        }),
      },
    },
    async (context, req, res) => {
      try {
        const { dataSourceId } = req.query;
        const client = await resolveOpenSearchClient(context, dataSourceId);
        if (!client) {
          return res.custom({ statusCode: 400, body: DATASOURCE_UNAVAILABLE_MESSAGE });
        }

        const result = await client.transport.request({
          method: 'GET',
          path: CALCITE_SETTINGS_PATH,
        });

        const body = result?.body ?? result;
        // Normalize to string so a typed-boolean value (e.g. JSON `false` from a
        // future transport) compares the same as today's string `"false"`.
        const resolveValue = (key: string): string | undefined => {
          const raw = body?.transient?.[key] ?? body?.persistent?.[key] ?? body?.defaults?.[key];
          return raw === undefined || raw === null ? undefined : String(raw);
        };

        return res.ok({
          body: {
            // A successful read with the key absent is definitive: include_defaults=true
            // surfaces plugins.calcite.enabled on any Calcite-capable cluster, so its
            // absence means there is no Calcite engine -> disabled. The catch block below
            // deliberately returns true instead: an error can't distinguish "no plugin"
            // from a transient failure, so it fails open. Don't reconcile the two paths.
            calciteEnabled: resolveValue('plugins.calcite.enabled') === 'true',
            allJoinTypesAllowed: resolveValue('plugins.calcite.all_join_types.allowed') === 'true',
          },
        });
      } catch (err) {
        const e = err as { statusCode?: number; meta?: { statusCode?: number } };
        const status = e?.statusCode ?? e?.meta?.statusCode;
        const message = err instanceof Error ? err.message : String(err);
        if (status === 401 || status === 403) {
          logger.warn(`PPL calcite settings unauthorized (${status}): ${message}`);
        } else {
          logger.debug(`PPL calcite settings error: ${message}`);
        }
        return res.ok({ body: { calciteEnabled: true, allJoinTypesAllowed: false } });
      }
    }
  );
}
