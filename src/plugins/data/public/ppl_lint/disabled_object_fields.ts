/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Walk an `indices.getMapping` response and collect the dotted names of object
 * fields mapped with `enabled: false`. Such objects are stored in `_source` but
 * never indexed, so every field beneath them silently resolves to null at query
 * time. The `enabled: false` attribute is stripped by `_field_caps` (so it never
 * appears in `indexPattern.fields`); it must be read from `_mappings` directly.
 *
 * Runs client-side on the response of the existing DSL mapping route, so no new
 * backend endpoint is needed. Only field names are derived — no other mapping
 * detail is retained.
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
