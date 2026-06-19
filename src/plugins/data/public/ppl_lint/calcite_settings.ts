/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpSetup } from '../../../../core/public';

const CALCITE_SETTINGS_PATH = '/api/enhancements/ppl/calcite_settings';

export interface CalciteSettings {
  isCalcite: boolean;
  allJoinTypesAllowed: boolean;
}

const SAFE_DEFAULTS: CalciteSettings = { isCalcite: true, allJoinTypesAllowed: false };

class CalciteSettingsCache {
  private cache = new Map<string, CalciteSettings>();
  private pending = new Map<string, Promise<CalciteSettings>>();

  private key(dataSourceId?: string): string {
    return dataSourceId ?? '__local__';
  }

  getCached(dataSourceId?: string): CalciteSettings | undefined {
    return this.cache.get(this.key(dataSourceId));
  }

  async resolve(http: HttpSetup, dataSourceId?: string): Promise<CalciteSettings> {
    const k = this.key(dataSourceId);
    if (this.cache.has(k)) return this.cache.get(k)!;
    if (this.pending.has(k)) return this.pending.get(k)!;

    const promise = http
      .get(CALCITE_SETTINGS_PATH, {
        query: dataSourceId ? { dataSourceId } : {},
      })
      .then((res: { calciteEnabled?: boolean; allJoinTypesAllowed?: boolean }) => ({
        isCalcite: res.calciteEnabled ?? true,
        allJoinTypesAllowed: res.allJoinTypesAllowed ?? false,
      }))
      .catch(() => SAFE_DEFAULTS)
      .then((settings: CalciteSettings) => {
        this.cache.set(k, settings);
        this.pending.delete(k);
        return settings;
      });

    this.pending.set(k, promise);
    return promise;
  }

  invalidate(dataSourceId?: string) {
    const k = this.key(dataSourceId);
    this.cache.delete(k);
    this.pending.delete(k);
  }
}

export const calciteSettingsCache = new CalciteSettingsCache();
