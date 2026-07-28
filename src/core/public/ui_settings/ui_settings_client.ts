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

import { cloneDeep, defaultsDeep, isEqual } from 'lodash';
import { Observable, Subject, concat, defer, of } from 'rxjs';
import { filter, map } from 'rxjs/operators';

import {
  UserProvidedValues,
  PublicUiSettingsParams,
  UiSettingsType,
  UiSettingScope,
} from '../../server/ui_settings/types';
import { IUiSettingsClient, UiSettingsState } from './types';

import { UiSettingsApi } from './ui_settings_api';

interface UiSettingsClientParams {
  defaults: Record<string, PublicUiSettingsParams>;
  initialSettings?: UiSettingsState;
  done$: Observable<unknown>;
  broadcastChannel?: BroadcastChannel;
  uiSettingApis: {
    default: UiSettingsApi;
    [scope: string]: UiSettingsApi;
  };
}

interface UiSettingsBroadcastMessage {
  type: 'saved';
  key: string;
}

export class UiSettingsClient implements IUiSettingsClient {
  private readonly update$ = new Subject<{ key: string; newValue: any; oldValue: any }>();
  private readonly saved$ = new Subject<{ key: string; newValue: any; oldValue: any }>();
  private readonly updateErrors$ = new Subject<Error>();

  private readonly uiSettingApis: UiSettingsClientParams['uiSettingApis'];
  private readonly broadcastChannel?: BroadcastChannel;
  private readonly defaults: Record<string, PublicUiSettingsParams>;
  private cache: Record<string, PublicUiSettingsParams & UserProvidedValues>;
  private readonly crossTabInvalidations = new Set<string>();
  private crossTabRefreshInProgress = false;
  private localUpdateCount = 0;
  private localUpdateVersion = 0;
  private stopped = false;

  constructor(params: UiSettingsClientParams) {
    this.uiSettingApis = params.uiSettingApis;
    this.broadcastChannel = params.broadcastChannel;
    this.defaults = cloneDeep(params.defaults);
    this.cache = defaultsDeep({}, this.defaults, cloneDeep(params.initialSettings));

    if (
      this.cache['theme:enableUserControl']?.userValue ??
      this.cache['theme:enableUserControl']?.value
    ) {
      const browserSettingsKeys = Object.keys(this.getBrowserStoredSettings());
      for (const key of browserSettingsKeys) {
        // Only keep settings which is declared as preferBrowserSetting as high priority instead of all settings, otherwise all settings could be replaced value easily if they are declared in localStorage.
        const preferBrowser = this.cache[key]?.preferBrowserSetting ?? false;
        if (preferBrowser) {
          // browser level setting should have a higher priority, otherwise its userValue could not be consumed.
          this.cache[key] = defaultsDeep({}, this.getBrowserStoredSettings()[key], this.cache[key]);
        }
      }
    }

    this.broadcastChannel?.addEventListener('message', this.onBroadcastMessage);

    params.done$.subscribe({
      complete: () => {
        this.stopped = true;
        this.broadcastChannel?.removeEventListener('message', this.onBroadcastMessage);
        this.broadcastChannel?.close();
        this.update$.complete();
        this.saved$.complete();
        this.updateErrors$.complete();
      },
    });
  }

  getAll() {
    return cloneDeep(this.cache);
  }

  getDefault<T = any>(key: string): T {
    const declared = this.isDeclared(key);

    if (!declared) {
      throw new Error(
        `Unexpected \`IUiSettingsClient.getDefaultValue("${key}")\` call on unrecognized configuration setting "${key}".
Please check that the setting for "${key}" exists.`
      );
    }
    return this.resolveValue(this.cache[key].value, this.cache[key].type);
  }

  get<T = any>(key: string, defaultOverride?: T) {
    const declared = this.isDeclared(key);

    if (!declared && defaultOverride !== undefined) {
      return defaultOverride;
    }

    if (!declared) {
      throw new Error(
        `Unexpected \`IUiSettingsClient.get("${key}")\` call on unrecognized configuration setting "${key}".
Setting an initial value via \`IUiSettingsClient.set("${key}", value)\` before attempting to retrieve
any custom setting value for "${key}" may fix this issue.
You can use \`IUiSettingsClient.get("${key}", defaultValue)\`, which will just return
\`defaultValue\` when the key is unrecognized.`
      );
    }

    const type = this.cache[key].type;
    const userValue = this.cache[key].userValue;
    const defaultValue = defaultOverride !== undefined ? defaultOverride : this.cache[key].value;
    const value = userValue == null ? defaultValue : userValue;
    return this.resolveValue(value, type);
  }

  get$<T = any>(key: string, defaultOverride?: T) {
    return concat(
      defer(() => of(this.get(key, defaultOverride))),
      this.update$.pipe(
        filter((update) => update.key === key),
        map(() => this.get(key, defaultOverride))
      )
    );
  }

  private validateScope(key: string, scope: UiSettingScope) {
    const definition = this.cache[key] || {};
    const validScopes = Array.isArray(definition.scope)
      ? definition.scope
      : [definition.scope || UiSettingScope.GLOBAL];

    if (scope && !validScopes.includes(scope)) {
      throw new Error(`Unable to process "${key}" with invalid scope: "${scope}"`);
    }
  }

  async getUserProvidedWithScope<T = any>(key: string, scope: UiSettingScope) {
    this.validateScope(key, scope);
    return await this.selectedApi(scope)
      .getAll()
      .then((response: any) => {
        const value = response.settings[key]?.userValue;
        const type = this.cache[key]?.type;
        return this.resolveValue(value, type);
      });
  }

  async set(key: string, value: any, scope?: UiSettingScope) {
    if (scope) {
      this.validateScope(key, scope);
    }
    return await this.update(key, value, scope);
  }

  async remove(key: string, scope?: UiSettingScope) {
    if (scope) {
      this.validateScope(key, scope);
    }
    return await this.update(key, null, scope);
  }

  isDeclared(key: string) {
    return key in this.cache;
  }

  isDefault(key: string) {
    return !this.isDeclared(key) || this.cache[key].userValue == null;
  }

  isCustom(key: string) {
    return this.isDeclared(key) && !('value' in this.cache[key]);
  }

  isOverridden(key: string) {
    return this.isDeclared(key) && Boolean(this.cache[key].isOverridden);
  }

  overrideLocalDefault(key: string, newDefault: any) {
    // capture the previous value
    const prevDefault = this.defaults[key] ? this.defaults[key].value : undefined;

    // update defaults map
    this.defaults[key] = {
      ...(this.defaults[key] || {}),
      value: newDefault,
    };

    // update cached default value
    this.cache[key] = {
      ...(this.cache[key] || {}),
      value: newDefault,
    };

    // don't broadcast change if userValue was already overriding the default
    if (this.cache[key].userValue == null) {
      this.update$.next({ key, newValue: newDefault, oldValue: prevDefault });
      this.saved$.next({ key, newValue: newDefault, oldValue: prevDefault });
    }
  }

  getUpdate$() {
    return this.update$.asObservable();
  }

  getSaved$() {
    return this.saved$.asObservable();
  }

  getUpdateErrors$() {
    return this.updateErrors$.asObservable();
  }

  private resolveValue(value: any, type: UiSettingsType | undefined) {
    if (type === 'json') {
      return JSON.parse(value);
    }

    return type === 'number' && typeof value !== 'bigint'
      ? isFinite(value) && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER)
        ? BigInt(value)
        : parseFloat(value)
      : value;
  }

  private getBrowserStoredSettings() {
    const uiSettingsJSON = window.localStorage.getItem('uiSettings') || '{}';
    try {
      return JSON.parse(uiSettingsJSON);
    } catch (error) {
      this.updateErrors$.next(error);
    }
    return {};
  }

  private setBrowserStoredSettings(key: string, newVal: any) {
    const oldSettings = this.getBrowserStoredSettings();
    const newSettings = cloneDeep(oldSettings);
    if (newVal === null) {
      delete newSettings[key];
    } else {
      newSettings[key] = { userValue: newVal };
    }
    window.localStorage.setItem(`uiSettings`, JSON.stringify(newSettings));
    return { settings: newSettings };
  }

  private assertUpdateAllowed(key: string) {
    if (this.isOverridden(key)) {
      throw new Error(
        `Unable to update "${key}" because its value is overridden by the OpenSearch Dashboards server`
      );
    }
  }

  private selectedApi(scope?: UiSettingScope) {
    return this.uiSettingApis[scope || 'default'] || this.uiSettingApis.default;
  }

  private async mergeSettingsIntoCache(
    key: string,
    defaults: Record<string, any>,
    enableUserControl: boolean,
    settings: Record<string, any> = {}
  ) {
    const hasMultipleScopes =
      Array.isArray(this.cache[key]?.scope) && (this.cache[key].scope?.length ?? 0) > 1;

    if (hasMultipleScopes) {
      // If the updated setting includes multiple scopes, refresh the cache by fetching all scoped settings and merging.
      const freshSettings = await this.selectedApi().getAll();
      this.cache = defaultsDeep(
        {},
        defaults,
        ...(enableUserControl ? [this.getBrowserStoredSettings()] : []),
        freshSettings.settings
      );
    } else {
      this.cache = defaultsDeep(
        {},
        defaults,
        ...(enableUserControl ? [this.getBrowserStoredSettings()] : []),
        settings
      );
    }
  }

  private async update(key: string, newVal: any, scope?: UiSettingScope): Promise<boolean> {
    this.assertUpdateAllowed(key);

    const declared = this.isDeclared(key);
    const defaults = this.defaults;

    const oldVal = declared ? this.cache[key].userValue : undefined;

    const unchanged = oldVal === newVal;
    // if scope is explicitly provided, we should not check if it is unchanged
    // as currently cache may stores settings of all scopes
    if (unchanged && !scope) {
      return true;
    }

    const initialVal = declared ? this.get(key) : undefined;
    this.localUpdateCount += 1;
    this.localUpdateVersion += 1;
    this.setLocally(key, newVal);

    try {
      if (
        this.cache['theme:enableUserControl']?.userValue ??
        this.cache['theme:enableUserControl']?.value
      ) {
        const { settings } = this.cache[key]?.preferBrowserSetting
          ? this.setBrowserStoredSettings(key, newVal)
          : (await this.selectedApi(scope).batchSet(key, newVal)) || {};

        this.mergeSettingsIntoCache(key, defaults, true, settings);
      } else {
        const { settings } = (await this.selectedApi(scope).batchSet(key, newVal)) || {};
        this.mergeSettingsIntoCache(key, defaults, false, settings);
      }
      this.saved$.next({ key, newValue: newVal, oldValue: initialVal });
      this.broadcastSavedSetting(key);
      return true;
    } catch (error) {
      this.setLocally(key, initialVal);
      this.updateErrors$.next(error);
      return false;
    } finally {
      this.localUpdateCount -= 1;
      if (this.localUpdateCount === 0 && this.crossTabInvalidations.size > 0) {
        void this.refreshCrossTabSettings();
      }
    }
  }

  private setLocally(key: string, newValue: any) {
    this.assertUpdateAllowed(key);

    if (!this.isDeclared(key)) {
      this.cache[key] = {};
    }

    const oldValue = this.get(key);

    if (newValue === null) {
      delete this.cache[key].userValue;
    } else {
      const { type } = this.cache[key];
      if (type === 'json' && typeof newValue !== 'string') {
        this.cache[key].userValue = JSON.stringify(newValue);
      } else {
        this.cache[key].userValue = newValue;
      }
    }

    this.update$.next({ key, newValue, oldValue });
  }

  private readonly onBroadcastMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !message ||
      typeof message !== 'object' ||
      (message as Partial<UiSettingsBroadcastMessage>).type !== 'saved' ||
      typeof (message as Partial<UiSettingsBroadcastMessage>).key !== 'string'
    ) {
      return;
    }

    this.crossTabInvalidations.add((message as UiSettingsBroadcastMessage).key);
    void this.refreshCrossTabSettings();
  };

  private broadcastSavedSetting(key: string) {
    try {
      this.broadcastChannel?.postMessage({
        type: 'saved',
        key,
      } as UiSettingsBroadcastMessage);
    } catch {
      // Cross-tab synchronization is best effort; the setting itself is already saved.
    }
  }

  private async refreshCrossTabSettings() {
    if (
      this.stopped ||
      this.crossTabRefreshInProgress ||
      this.localUpdateCount > 0 ||
      this.crossTabInvalidations.size === 0
    ) {
      return;
    }

    this.crossTabRefreshInProgress = true;
    try {
      while (!this.stopped && this.localUpdateCount === 0 && this.crossTabInvalidations.size > 0) {
        const invalidatedKeys = [...this.crossTabInvalidations];
        this.crossTabInvalidations.clear();
        const updateVersion = this.localUpdateVersion;

        try {
          const freshSettings = await this.selectedApi().getAll();

          if (this.stopped) {
            return;
          }

          if (this.localUpdateCount > 0 || this.localUpdateVersion !== updateVersion) {
            invalidatedKeys.forEach((key) => this.crossTabInvalidations.add(key));
            return;
          }

          this.replaceCacheFromServer(freshSettings.settings);
        } catch {
          // A remote save already succeeded; a best-effort refresh failure is not a local update error.
        }
      }
    } finally {
      this.crossTabRefreshInProgress = false;
      if (!this.stopped && this.localUpdateCount === 0 && this.crossTabInvalidations.size > 0) {
        void this.refreshCrossTabSettings();
      }
    }
  }

  private replaceCacheFromServer(settings: UiSettingsState = {}) {
    const oldCache = this.cache;
    const serverCache = defaultsDeep({}, this.defaults, settings);
    const enableUserControl =
      serverCache['theme:enableUserControl']?.userValue ??
      serverCache['theme:enableUserControl']?.value;

    this.cache = defaultsDeep(
      {},
      this.defaults,
      ...(enableUserControl ? [this.getBrowserStoredSettings()] : []),
      settings
    );

    const keys = new Set([...Object.keys(oldCache), ...Object.keys(this.cache)]);
    for (const key of keys) {
      const oldValue = this.resolveCachedValue(oldCache, key);
      const newValue = this.resolveCachedValue(this.cache, key);
      if (!isEqual(oldValue, newValue)) {
        this.update$.next({ key, newValue, oldValue });
      }
    }
  }

  private resolveCachedValue(
    cache: Record<string, PublicUiSettingsParams & UserProvidedValues>,
    key: string
  ) {
    const setting = cache[key];
    if (!setting) {
      return undefined;
    }

    const value = setting.userValue == null ? setting.value : setting.userValue;
    return this.resolveValue(value, setting.type);
  }
}
