/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { schema } from '@osd/config-schema';
import { HttpServiceSetup, RequestHandlerContext } from 'opensearch-dashboards/server';
import { IndexPatternsFetcher } from './fetcher';
import { decideLegacyClient } from '../../../data_source/common/util/';

/**
 * Walk an `indices.getMapping` response and collect the dotted names of object
 * fields mapped with `enabled: false`. Such objects are not indexed, so every
 * field beneath them silently resolves to null at query time. Only the field
 * names are returned — no other mapping detail leaves the server.
 */
export function collectDisabledObjectFields(getMappingResponse: unknown): string[] {
  const names = new Set<string>();
  const body = (getMappingResponse as { body?: unknown })?.body ?? getMappingResponse;
  if (typeof body !== 'object' || body === null) {
    return [];
  }

  const walkProperties = (properties: Record<string, any> | undefined, prefix: string): void => {
    if (!properties) {
      return;
    }
    for (const [name, definition] of Object.entries(properties)) {
      if (typeof definition !== 'object' || definition === null) {
        continue;
      }
      const path = prefix ? `${prefix}.${name}` : name;
      if (definition.enabled === false) {
        names.add(path);
        // The subtree is not indexed; no need to descend further.
        continue;
      }
      walkProperties(definition.properties, path);
    }
  };

  // Response shape: { [indexName]: { mappings: { properties: {...} } } }.
  for (const indexEntry of Object.values(body as Record<string, any>)) {
    walkProperties(indexEntry?.mappings?.properties, '');
  }

  return [...names];
}

export function registerRoutes(http: HttpServiceSetup) {
  const parseMetaFields = (metaFields: string | string[]) => {
    let parsedFields: string[] = [];
    if (typeof metaFields === 'string') {
      parsedFields = JSON.parse(metaFields);
    } else {
      parsedFields = metaFields;
    }
    return parsedFields;
  };

  const router = http.createRouter();

  router.get(
    {
      path: '/api/index_patterns/_disabled_object_fields',
      validate: {
        query: schema.object({
          pattern: schema.string(),
          data_source: schema.maybe(schema.string()),
        }),
      },
    },
    async (context, request, response) => {
      const callAsCurrentUser = await decideLegacyClient(context, request);
      const { pattern } = request.query;

      try {
        // Read-only mapping lookup, scoped to the current user / data source.
        // The mapping-level `enabled: false` attribute is stripped by
        // `_field_caps`, so it must be read from `_mappings` directly. Only the
        // resulting object field-name list leaves the server.
        const mappings = await callAsCurrentUser('indices.getMapping', {
          index: pattern,
          allow_no_indices: true,
          ignore_unavailable: true,
        });

        return response.ok({
          body: { fields: collectDisabledObjectFields(mappings) },
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        // Mirror the wildcard route: a missing index is a not-found, anything
        // else degrades to an empty set so the linter simply self-suppresses.
        return response.ok({
          body: { fields: [] },
          headers: { 'content-type': 'application/json' },
        });
      }
    }
  );

  router.get(
    {
      path: '/api/index_patterns/_fields_for_wildcard',
      validate: {
        query: schema.object({
          pattern: schema.string(),
          meta_fields: schema.oneOf([schema.string(), schema.arrayOf(schema.string())], {
            defaultValue: [],
          }),
          data_source: schema.maybe(schema.string()),
        }),
      },
    },
    async (context, request, response) => {
      const callAsCurrentUser = await decideLegacyClient(context, request);
      const indexPatterns = new IndexPatternsFetcher(callAsCurrentUser);
      const { pattern, meta_fields: metaFields } = request.query;

      let parsedFields: string[] = [];
      try {
        parsedFields = parseMetaFields(metaFields);
      } catch (error) {
        return response.badRequest();
      }

      try {
        const fields = await indexPatterns.getFieldsForWildcard({
          pattern,
          metaFields: parsedFields,
        });

        return response.ok({
          body: { fields },
          headers: {
            'content-type': 'application/json',
          },
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          !!error?.isBoom &&
          !!error?.output?.payload &&
          typeof error?.output?.payload === 'object'
        ) {
          const payload = error?.output?.payload;
          return response.notFound({
            body: {
              message: payload.message,
              attributes: payload,
            },
          });
        } else {
          return response.notFound();
        }
      }
    }
  );

  router.get(
    {
      path: '/api/index_patterns/_fields_for_time_pattern',
      validate: {
        query: schema.object({
          pattern: schema.string(),
          interval: schema.maybe(schema.string()),
          look_back: schema.number({ min: 1 }),
          meta_fields: schema.oneOf([schema.string(), schema.arrayOf(schema.string())], {
            defaultValue: [],
          }),
          data_source: schema.maybe(schema.string()),
        }),
      },
    },
    async (context: RequestHandlerContext, request: any, response: any) => {
      const callAsCurrentUser = await decideLegacyClient(context, request);

      const indexPatterns = new IndexPatternsFetcher(callAsCurrentUser);
      const { pattern, interval, look_back: lookBack, meta_fields: metaFields } = request.query;

      let parsedFields: string[] = [];
      try {
        parsedFields = parseMetaFields(metaFields);
      } catch (error) {
        return response.badRequest();
      }

      try {
        const fields = await indexPatterns.getFieldsForTimePattern({
          pattern,
          interval: interval ? interval : '',
          lookBack,
          metaFields: parsedFields,
        });

        return response.ok({
          body: { fields },
          headers: {
            'content-type': 'application/json',
          },
        });
      } catch (error) {
        return response.notFound();
      }
    }
  );
}
