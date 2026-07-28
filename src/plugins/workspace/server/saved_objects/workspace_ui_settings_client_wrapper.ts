/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getWorkspaceState } from '../../../../core/server/utils';
import {
  SavedObject,
  SavedObjectsBaseOptions,
  SavedObjectsClientWrapperFactory,
  SavedObjectsUpdateOptions,
  SavedObjectsUpdateResponse,
  SavedObjectsServiceStart,
  WORKSPACE_TYPE,
  WorkspaceAttribute,
  OpenSearchDashboardsRequest,
  SavedObjectsClientContract,
  SavedObjectsErrorHelpers,
  CURRENT_WORKSPACE_PLACEHOLDER,
  PluginInitializerContext,
  UiSettingsServiceStart,
  IUiSettingsClient,
  UiSettingScope,
} from '../../../../core/server';
import { WORKSPACE_UI_SETTINGS_CLIENT_WRAPPER_ID } from '../../common/constants';
import { Logger } from '../../../../core/server';

/**
 * This saved object client wrapper offers methods to get and update UI settings considering
 * the context of the current workspace.
 */
export class WorkspaceUiSettingsClientWrapper {
  constructor(
    private readonly logger: Logger,
    private readonly env: PluginInitializerContext['env']
  ) {}
  private getScopedClient?: SavedObjectsServiceStart['getScopedClient'];
  private asScopedUISettingsClient?: UiSettingsServiceStart['asScopedToClient'];

  /**
   * WORKSPACE_TYPE is a hidden type, regular saved object client won't return hidden types.
   * To access workspace uiSettings which is defined as a property of workspace object, the
   * WORKSPACE_TYPE needs to be excluded.
   */
  private getWorkspaceTypeEnabledClient(request: OpenSearchDashboardsRequest) {
    return this.getScopedClient?.(request, {
      includedHiddenTypes: [WORKSPACE_TYPE],
      excludedWrappers: [WORKSPACE_UI_SETTINGS_CLIENT_WRAPPER_ID],
    }) as SavedObjectsClientContract;
  }

  private getUISettingsClient(savedObjectClient: SavedObjectsClientContract) {
    return this.asScopedUISettingsClient?.(savedObjectClient) as IUiSettingsClient;
  }

  public setScopedClient(getScopedClient: SavedObjectsServiceStart['getScopedClient']) {
    this.getScopedClient = getScopedClient;
  }

  public setAsScopedUISettingsClient(asScopedToClient: UiSettingsServiceStart['asScopedToClient']) {
    this.asScopedUISettingsClient = asScopedToClient;
  }

  public wrapperFactory: SavedObjectsClientWrapperFactory = (wrapperOptions) => {
    const getRegisteredConfigs = () => {
      const savedObjectsClient = this.getWorkspaceTypeEnabledClient(wrapperOptions.request);
      return this.getUISettingsClient(savedObjectsClient).getRegistered();
    };

    const supportsWorkspaceScope = (
      config: { scope?: UiSettingScope | UiSettingScope[] } | undefined
    ) =>
      Array<UiSettingScope>()
        .concat(config?.scope || [])
        .includes(UiSettingScope.WORKSPACE);

    const partitionWorkspaceSettings = (settings: Record<string, any> = {}) => {
      const registeredConfigs = getRegisteredConfigs();
      return Object.entries(settings).reduce(
        (partitioned, [key, value]) => {
          const config = registeredConfigs[key];
          // Preserve unregistered legacy/custom keys, but never let a value stored
          // in a workspace override a registered setting that is global-only.
          if (!config || supportsWorkspaceScope(config)) {
            partitioned.workspace[key] = value;
          } else {
            partitioned.globalOnly[key] = value;
          }
          return partitioned;
        },
        {
          workspace: {} as Record<string, any>,
          globalOnly: {} as Record<string, any>,
        }
      );
    };

    const filterWorkspaceSettings = (settings: Record<string, any> = {}) =>
      partitionWorkspaceSettings(settings).workspace;

    const getUiSettingsWithWorkspace = async <T = unknown>(
      type: string,
      id: string,
      options: SavedObjectsBaseOptions = {}
    ): Promise<SavedObject<T>> => {
      const { requestWorkspaceId } = getWorkspaceState(wrapperOptions.request);

      /**
       * When getting ui settings within a workspace, it will combine the workspace ui settings with
       * the global ui settings and workspace ui settings will override global settings attribute
       */
      if (type === 'config' && id.startsWith(CURRENT_WORKSPACE_PLACEHOLDER)) {
        // if not in a workspace and try to get workspace level settings
        // it should return NotFoundError
        if (!requestWorkspaceId) {
          throw SavedObjectsErrorHelpers.createGenericNotFoundError();
        }

        const normalizeDocId = id.replace(`${CURRENT_WORKSPACE_PLACEHOLDER}_`, '');

        let configObject: SavedObject<T> = {
          type: 'config',
          id: normalizeDocId,
          references: [],
          attributes: {} as T,
        };

        try {
          configObject = await wrapperOptions.client.get<T>('config', normalizeDocId, options);
        } catch (e) {
          // make global config nullable when getting workspace settings
        }

        let workspaceObject: SavedObject<WorkspaceAttribute> | null = null;
        const workspaceTypeEnabledClient = this.getWorkspaceTypeEnabledClient(
          wrapperOptions.request
        );

        try {
          workspaceObject = await workspaceTypeEnabledClient.get<WorkspaceAttribute>(
            WORKSPACE_TYPE,
            requestWorkspaceId
          );
        } catch (e) {
          this.logger.error(`Unable to get workspaceObject with id: ${requestWorkspaceId}`);
        }

        const registeredConfigs = getRegisteredConfigs();

        const workspaceScopeConfigDefaults = Object.entries(registeredConfigs)
          .filter(([, config]) =>
            Array<UiSettingScope>()
              .concat(config.scope || [])
              .includes(UiSettingScope.WORKSPACE)
          )
          .reduce((acc, [key, config]) => {
            acc[key] = config.value;
            return acc;
          }, {} as Record<string, any>);

        const workspaceSettings = filterWorkspaceSettings(workspaceObject?.attributes?.uiSettings);

        Object.entries(workspaceScopeConfigDefaults).forEach(([key, value]) => {
          workspaceSettings[key] = workspaceSettings[key] || value;
        });

        configObject.attributes = workspaceSettings as T;

        return configObject;
      }

      return wrapperOptions.client.get(type, id, options);
    };

    const updateUiSettingsWithWorkspace = async <T = unknown>(
      type: string,
      id: string,
      attributes: Partial<T>,
      options: SavedObjectsUpdateOptions = {}
    ): Promise<SavedObjectsUpdateResponse<T>> => {
      const { requestWorkspaceId } = getWorkspaceState(wrapperOptions.request);
      const updateWorkspaceSettings = async (
        configDocId: string,
        workspaceId: string,
        workspaceAttributes: Partial<T>
      ) => {
        const savedObjectsClient = this.getWorkspaceTypeEnabledClient(wrapperOptions.request);
        let configObject: SavedObjectsUpdateResponse<T> = {
          type: 'config',
          id: configDocId,
          references: [],
          attributes: {},
        };

        try {
          configObject = await wrapperOptions.client.get<T>('config', configDocId, options);
        } catch (e) {
          // make global config nullable when updating workspace settings
        }

        const workspaceObject = await savedObjectsClient.get<WorkspaceAttribute>(
          WORKSPACE_TYPE,
          workspaceId
        );
        const existingSettings = partitionWorkspaceSettings(workspaceObject.attributes.uiSettings);
        const incomingSettings = partitionWorkspaceSettings(
          workspaceAttributes as Record<string, any>
        );
        const staleGlobalOnlySettings = Object.keys({
          ...existingSettings.globalOnly,
          ...incomingSettings.globalOnly,
        }).reduce((tombstones, key) => {
          // Saved object updates merge nested uiSettings, so omission cannot
          // remove a stale key. Null is an explicit delete tombstone.
          tombstones[key] = null;
          return tombstones;
        }, {} as Record<string, null>);

        const workspaceUpdateResult = await savedObjectsClient.update<WorkspaceAttribute>(
          WORKSPACE_TYPE,
          workspaceId,
          {
            ...workspaceObject.attributes,
            uiSettings: {
              ...existingSettings.workspace,
              ...incomingSettings.workspace,
              ...staleGlobalOnlySettings,
            },
          },
          options
        );

        configObject.attributes = filterWorkspaceSettings(
          workspaceUpdateResult.attributes.uiSettings
        ) as T;

        return configObject;
      };

      /**
       * When updating ui settings within a workspace, it will update the workspace ui settings,
       * the global ui settings will remain unchanged.
       * Skip updating workspace level setting if the request is updating user level setting specifically or global workspace level setting.
       */
      if (type === 'config') {
        if (id.startsWith(CURRENT_WORKSPACE_PLACEHOLDER)) {
          // if not in a workspace and try to update workspace level settings
          // it should return 400 BadRequestError
          if (!requestWorkspaceId) {
            throw SavedObjectsErrorHelpers.createBadRequestError();
          }

          const normalizeDocId = id.replace(`${CURRENT_WORKSPACE_PLACEHOLDER}_`, '');

          return updateWorkspaceSettings(normalizeDocId, requestWorkspaceId, attributes);
        } else if (requestWorkspaceId && id === this.env.packageInfo.version) {
          // The code below maintains backward compatibility for UI setting updates in version 3.0.0.
          // Remove if no external code is modifying these settings through the global scope.
          const registeredConfigs = getRegisteredConfigs();
          const workspaceAttributes: Record<string, unknown> = {};
          const globalAttributes: Record<string, unknown> = {};

          Object.entries(attributes as Record<string, unknown>).forEach(([key, value]) => {
            const config = registeredConfigs[key];
            if (!config || supportsWorkspaceScope(config)) {
              workspaceAttributes[key] = value;
            } else {
              globalAttributes[key] = value;
            }
          });

          let globalResult: SavedObjectsUpdateResponse<T> | undefined;
          let workspaceResult: SavedObjectsUpdateResponse<T> | undefined;

          if (Object.keys(globalAttributes).length > 0) {
            globalResult = await wrapperOptions.client.update(
              type,
              id,
              globalAttributes as Partial<T>,
              options
            );
          }

          if (Object.keys(workspaceAttributes).length > 0) {
            this.logger.warn(
              'Deprecation warning: updating workspace settings through global scope will no longer be supported.'
            );
            workspaceResult = await updateWorkspaceSettings(
              id,
              requestWorkspaceId,
              workspaceAttributes as Partial<T>
            );
          }

          if (globalResult && workspaceResult) {
            return {
              ...globalResult,
              attributes: {
                ...globalResult.attributes,
                ...workspaceResult.attributes,
              },
            };
          }

          return (globalResult || workspaceResult) as SavedObjectsUpdateResponse<T>;
        }
      }
      return wrapperOptions.client.update(type, id, attributes, options);
    };

    return {
      ...wrapperOptions.client,
      checkConflicts: wrapperOptions.client.checkConflicts,
      errors: wrapperOptions.client.errors,
      addToNamespaces: wrapperOptions.client.addToNamespaces,
      deleteFromNamespaces: wrapperOptions.client.deleteFromNamespaces,
      find: wrapperOptions.client.find,
      bulkGet: wrapperOptions.client.bulkGet,
      create: wrapperOptions.client.create,
      bulkCreate: wrapperOptions.client.bulkCreate,
      delete: wrapperOptions.client.delete,
      bulkUpdate: wrapperOptions.client.bulkUpdate,
      deleteByWorkspace: wrapperOptions.client.deleteByWorkspace,
      get: getUiSettingsWithWorkspace,
      update: updateUiSettingsWithWorkspace,
    };
  };
}
