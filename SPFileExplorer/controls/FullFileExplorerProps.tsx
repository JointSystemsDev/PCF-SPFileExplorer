import { IInputs } from "../generated/ManifestTypes";
import { IFileSystemItem } from "./IFileSystemItem";
import { IFolder } from "./IFolder";
import { IFullFileExplorerProps } from "./IFullFileExplorerProps";
import { IResourceStrings } from "../IResourceStrings";

export const ALL_ITEMS_PAGE_SIZE = 5000;

const SHARED_LOCATION_GUID = "17DE0DBB-153C-4C1A-B98A-223B3EA10125";
const FOLDER_STRUCTURE_KEY = "FolderStructure";
const ALL_DOCUMENTS_CACHE_KEY = "AllDocumentsCache";
const CURRENT_FOLDER_PATH_KEY = "CurrentFolderPath";
const SORT_STATE_KEY = "ClientSideSortState";
const SELECTED_IDS_CACHE_KEY = "SelectedRecordIds";
const DATA_SNAPSHOT_KEY_PREFIX = "DataSnapshot_"; // Per-folder snapshot

const normalizeFolderPath = (folderPath?: string): string => {
  if (!folderPath) {
    return "";
  }

  return folderPath.replace(/\/+$/, "");
};

const isDocumentInFolder = (doc: IFileSystemItem, folderPath: string): boolean => {
  const normalizedFolder = normalizeFolderPath(folderPath);
  const docLocation = normalizeFolderPath(doc.relativelocation || doc.path || "");

  if (!normalizedFolder) {
    return true;
  }

  if (!docLocation) {
    return false;
  }

  return docLocation === normalizedFolder || docLocation.startsWith(normalizedFolder + '/');
};

const updateCacheForFolder = (
  existingDocs: Record<string, IFileSystemItem> | undefined,
  folderPath: string | undefined,
  newDocs: IFileSystemItem[]
): Record<string, IFileSystemItem> => {
  const normalizedFolder = normalizeFolderPath(folderPath);
  const cache: Record<string, IFileSystemItem> = normalizedFolder
    ? { ...(existingDocs ?? {}) }
    : {};

  const newDocKeys = new Set<string>();

  newDocs.forEach((doc) => {
    if (doc?.key) {
      cache[doc.key] = doc;
      newDocKeys.add(doc.key);
    }
  });

  if (normalizedFolder && existingDocs) {
    Object.keys(existingDocs).forEach((key) => {
      const cachedDoc = existingDocs[key];
      if (cachedDoc && isDocumentInFolder(cachedDoc, normalizedFolder) && !newDocKeys.has(key)) {
        delete cache[key];
      }
    });
  }

  return cache;
};

const createDataSnapshot = (documents: IFileSystemItem[]): string => {
  // Create a simple snapshot based on document keys and count
  // This helps detect if data has actually changed
  const keys = documents.map(d => d.key).sort().join('|');
  return `${documents.length}:${keys}`;
};

const buildFolderTreeFromDocuments = (
  rootPath: string,
  documents: IFileSystemItem[]
): IFolder[] => {
  const folderMap: { [path: string]: IFolder } = {};
  
  // Extract unique folder paths from documents
  documents.forEach((doc) => {
    const docPath = doc.relativelocation || doc.path;
    if (docPath && docPath !== rootPath) {
      // Only process paths that start with the root path + "/"
      if (docPath.startsWith(rootPath + '/')) {
        // Remove the root path prefix to get relative path
        const relativePath = docPath.substring(rootPath.length + 1);
        const pathParts = relativePath.split('/').filter((p: string) => p);
        let currentPath = '';
        
        pathParts.forEach((part: string, index: number) => {
          const fullPath = rootPath + '/' + (currentPath ? currentPath + '/' : '') + part;
          currentPath = currentPath ? currentPath + '/' + part : part;
          
          // Only create folder if it's not the document itself (folders don't have extensions typically)
          if (doc.filetype === 'folder' || index < pathParts.length - 1) {
            if (!folderMap[fullPath]) {
              folderMap[fullPath] = {
                path: fullPath,
                key: fullPath,
                name: part,
                children: []
              };
            }
          }
        });
      }
    }
  });

  // Build hierarchical structure - only get direct children of root
  const buildHierarchy = (parentPath: string): IFolder[] => {
    const children: IFolder[] = [];
    
    Object.values(folderMap).forEach((folder) => {
      const folderParentPath = folder.path.substring(0, folder.path.lastIndexOf('/'));
      if (folderParentPath === parentPath) {
        folder.children = buildHierarchy(folder.path);
        children.push(folder);
      }
    });
    
    return children.sort((a, b) => a.name.localeCompare(b.name));
  };
  
  return buildHierarchy(rootPath);
};


/**
 * Function that initilizes properties of the full file explorer control.
 */
export const initFullFileExplorerProps = (
  context: ComponentFramework.Context<IInputs>,
  controlCache: { [index: string]: any },
  resources: IResourceStrings,
  notifyOutputChanged: () => void
): IFullFileExplorerProps => {
  const dataSet = context.parameters.documentsDataSet;
  let folderStructure = controlCache[FOLDER_STRUCTURE_KEY] as IFolder;
  const useClientSideFiltering = (context.parameters as any).useClientSideFiltering?.raw ?? false;

  // Get sort expression - use client-side cache in client-side mode, otherwise use dataset
  let sortExpression: { name: string; sortDirection: number };
  if (useClientSideFiltering && controlCache[SORT_STATE_KEY]) {
    sortExpression = controlCache[SORT_STATE_KEY] as { name: string; sortDirection: number };
  } else {
    sortExpression =
      dataSet.sorting && dataSet.sorting.length > 0
        ? (dataSet.sorting.pop() as { name: string; sortDirection: number })
        : { name: "", sortDirection: 0 };
  }

  // Build complete document list from dataset
  const buildDocumentList = (): IFileSystemItem[] => {

    return dataSet.sortedRecordIds.map((recordId) => {
      const record = dataSet.records[recordId];
      const itemData = {} as IFileSystemItem;

      itemData["isSharedLocation"] =
        record.getValue("locationid") === SHARED_LOCATION_GUID;
      itemData.reference = (record as any)._entityReference;
      itemData.key = record.getRecordId();
      itemData.path = record.getFormattedValue("relativelocation");

      // Read all column values - get raw values for specific fields first
      dataSet.columns.forEach((c) => {
        if (c.name === "ischeckedout" || c.name === "documentid" || c.name === "locationid") {
          // For these fields, use raw value only
          itemData[c.name] = record.getValue(c.name);
        } else {
          // For other fields, use formatted value
          itemData[c.name] = record.getFormattedValue(c.name);
        }
      });

      // Ensure we get the absoluteurl - try formatted first, then raw value
      if (!itemData["absoluteurl"]) {
        itemData["absoluteurl"] = record.getFormattedValue("absoluteurl") || record.getValue("absoluteurl");
      }

      // Compute Portal Release field based on title
      const titleValue = record.getFormattedValue("title");
      itemData["portalrelease"] = titleValue === "1" ? resources.Yes : "";

      // FIX for Problem C: Extract base folder name from relativelocation path
      const fullPath = itemData.relativelocation || itemData.path || "";

      // Simple approach: Split path and remove first segment (base folder)
      const pathParts = fullPath.split('/');
      let displayPath: string;
      if (pathParts.length > 1) {
        // Remove first part (base folder) and rejoin
        displayPath = pathParts.slice(1).join('/');
      } else {
        // Single segment or empty - use as is
        displayPath = fullPath;
      }
      
      // Decode URL-encoded characters (e.g., %20 -> space) for display
      try {
        itemData.relativelocationDisplay = decodeURIComponent(displayPath);
      } catch {
        // If decoding fails, use the original path
        itemData.relativelocationDisplay = displayPath;
      }

      return itemData;
    });
  };

  // Cache all documents for client-side filtering
  const dataSetFilter = dataSet.filtering.getFilter();
  const relativelocationCondition = dataSetFilter?.conditions?.find(
    (condition) => condition.attributeName == "relativelocation"
  );

  if (useClientSideFiltering) {
    const currentDocs = buildDocumentList();
    const existingCache = controlCache[ALL_DOCUMENTS_CACHE_KEY] as
      | Record<string, IFileSystemItem>
      | undefined;
    const targetFolderPath =
      (relativelocationCondition?.value as string | undefined) ||
      (controlCache[CURRENT_FOLDER_PATH_KEY] as string | undefined) ||
      folderStructure?.path;

    // Create folder-specific snapshot key to track changes per folder
    const snapshotKey = DATA_SNAPSHOT_KEY_PREFIX + normalizeFolderPath(targetFolderPath);
    
    // Create snapshot of new data
    const newSnapshot = createDataSnapshot(currentDocs);
    const oldSnapshot = controlCache[snapshotKey] as string | undefined;

    controlCache[ALL_DOCUMENTS_CACHE_KEY] = updateCacheForFolder(
      existingCache,
      targetFolderPath,
      currentDocs
    );

    // Store the new snapshot for this folder
    controlCache[snapshotKey] = newSnapshot;

    // Check if data actually changed for this specific folder
    const dataChanged = oldSnapshot !== newSnapshot;
    
    // If data didn't change, preserve cached selections
    // If data changed (upload/delete), clear cached selections to use dataset's selection
    if (dataChanged) {
      controlCache[SELECTED_IDS_CACHE_KEY] = undefined;
    }
  }

  // Get current folder path - use cache for client-side, filter for server-side
  let currentFolderPath: string;

  if (useClientSideFiltering) {
    // CLIENT-SIDE: Read from cache, default to root folder path
    currentFolderPath = controlCache[CURRENT_FOLDER_PATH_KEY];

    if (relativelocationCondition?.value) {
      currentFolderPath = relativelocationCondition.value as string;
      controlCache[CURRENT_FOLDER_PATH_KEY] = currentFolderPath;
    }

    // If not set and we have folder structure, use root folder path
    if (!currentFolderPath && folderStructure?.path) {
      currentFolderPath = folderStructure.path;
      controlCache[CURRENT_FOLDER_PATH_KEY] = currentFolderPath;
    }

    currentFolderPath = currentFolderPath || "";

    // Ensure dataset filter stays in sync with cached folder path for command bar operations
    if (
      currentFolderPath &&
      (!relativelocationCondition || normalizeFolderPath(relativelocationCondition.value as string) !== normalizeFolderPath(currentFolderPath))
    ) {
      const existingFilter = dataSetFilter ?? { conditions: [], filterOperator: 0 };
      const locationConditionIndex = existingFilter.conditions.findIndex(
        (item) => item.attributeName == "relativelocation"
      );

      if (locationConditionIndex === -1) {
        existingFilter.conditions.push({
          attributeName: "relativelocation",
          value: currentFolderPath,
          conditionOperator: 0,
        });
      } else {
        existingFilter.conditions[locationConditionIndex].value = currentFolderPath;
      }

      dataSet.filtering.setFilter(existingFilter);
    }
  } else {
    // SERVER-SIDE: Read from dataset filter
    currentFolderPath =
      !relativelocationCondition
        ? ""
        : (relativelocationCondition.value as string);
  }

  // Helper function to sort documents client-side
  const sortDocuments = (documents: IFileSystemItem[], sortColumn: string, sortAscending: boolean): IFileSystemItem[] => {
    if (!sortColumn) {
      return documents;
    }

    const sorted = [...documents].sort((a, b) => {
      const aValue = a[sortColumn as keyof IFileSystemItem] as string || "";
      const bValue = b[sortColumn as keyof IFileSystemItem] as string || "";

      // Handle numeric sorting for certain fields
      if (sortColumn === "size" || sortColumn === "filesize") {
        const aNum = parseFloat(aValue) || 0;
        const bNum = parseFloat(bValue) || 0;
        return sortAscending ? aNum - bNum : bNum - aNum;
      }

      // String comparison for all other fields
      const comparison = aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' });
      return sortAscending ? comparison : -comparison;
    });

    return sorted;
  };

  // Determine current folder content based on filtering mode
  let currentFolderContent: IFileSystemItem[];

  if (useClientSideFiltering && controlCache[ALL_DOCUMENTS_CACHE_KEY]) {
    // CLIENT-SIDE: Pass ALL documents to React component
    // React will filter them internally based on currentFolderPath
    currentFolderContent = [
      ...Object.values(controlCache[ALL_DOCUMENTS_CACHE_KEY] as Record<string, IFileSystemItem>),
    ];

    // FIX for Problem B: Apply client-side sorting if sort state exists
    if (sortExpression && sortExpression.name) {
      currentFolderContent = sortDocuments(
        currentFolderContent,
        sortExpression.name,
        sortExpression.sortDirection === 0
      );
    }

  } else {
    // SERVER-SIDE: Use documents from dataset (already filtered by server)
    currentFolderContent = buildDocumentList();
  }

  // Rebuild folder structure from all loaded documents if we have a root folder
  if (folderStructure) {
    const allDocuments =
      useClientSideFiltering && controlCache[ALL_DOCUMENTS_CACHE_KEY]
        ? Object.values(controlCache[ALL_DOCUMENTS_CACHE_KEY] as Record<string, IFileSystemItem>)
        : dataSet.sortedRecordIds.map((recordId) => {
            const record = dataSet.records[recordId];
            return {
              relativelocation: record.getFormattedValue("relativelocation"),
              filetype: record.getFormattedValue("filetype"),
              path: record.getFormattedValue("relativelocation"),
            } as any;
          });

    // Rebuild the folder tree from documents
    folderStructure.children = buildFolderTreeFromDocuments(
      folderStructure.path,
      allDocuments
    );
  }

  // Check for dataset errors
  let error: { message: string; code?: string } | undefined;
  if (dataSet.error) {
    error = {
      message: dataSet.errorMessage || 'An error occurred loading documents',
      code: dataSet.error ? String(dataSet.error) : undefined
    };
  }

  const togglePortalRelease = async (
    selectedItems: IFileSystemItem[],
    enableRelease: boolean
  ): Promise<{ success: number; failed: number; errors: string[] }> => {
    const result = { success: 0, failed: 0, errors: [] as string[] };
    const contextPage = (context as any).page;
    
    // Get parent entity information
    const entityTypeName = contextPage?.entityTypeName;
    const entityId = contextPage?.entityId;
    
    if (!entityTypeName || !entityId) {
      result.errors.push("Parent entity information not available");
      result.failed = selectedItems.length;
      return result;
    }

    // Convert entity type name to OData format (e.g., "cif_foundation" -> "Microsoft.Dynamics.CRM.cif_foundation")
    const odataEntityType = `Microsoft.Dynamics.CRM.${entityTypeName}`;
    const entityIdField = `${entityTypeName}id`;

    // Process each selected document
    for (const item of selectedItems) {
      try {
        // Build the payload with required fields
        const payload = {
          Entity: {
            "@odata.type": "Microsoft.Dynamics.CRM.sharepointdocument",
            sharepointdocumentid: `{${item.key.toUpperCase()}}`,
            documentid: item.documentid,
            locationid: item.locationid || "00000000-0000-0000-0000-000000000000",
            fullname: item.fullname,
            title: enableRelease ? "1" : null
          },
          ParentEntityReference: {
            "@odata.type": odataEntityType,
            [entityIdField]: entityId
          }
        };

        // Make the API call using fetch
        const response = await fetch("/api/data/v9.0/EditDocumentProperties", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          result.success++;
        } else {
          result.failed++;
          const errorText = await response.text().catch(() => response.statusText);
          result.errors.push(`${item.fullname}: ${errorText || 'Update failed'}`);
        }
      } catch (error: any) {
        result.failed++;
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        result.errors.push(`${item.fullname}: ${errorMessage}`);
      }
    }

    // Refresh the dataset after updates
    if (result.success > 0) {
      dataSet.refresh();
    }

    return result;
  };

  return {
    hideFoldersPane: context.parameters.hideFoldersPane
      ? context.parameters.hideFoldersPane.raw
      : false,
    columns: [
      ...dataSet.columns
        .filter((c) => !c.isHidden)
        .map((c) => {
          const col = {
            name: c.name,
            displayName: c.displayName,
            isPrimary: c.isPrimary,
            isSortable: !c.disableSorting,
            visualSizeFactor: c.visualSizeFactor,
            renderIcon: c.name === "fullname",
            isSorted: sortExpression?.name == c.name,
            isSortedDescending: sortExpression?.sortDirection == 1,
          };
          return col;
        }),
      // Add computed Portal Release column
      {
        name: "portalrelease",
        displayName: resources.PortalRelease,
        isPrimary: false,
        isSortable: true,
        visualSizeFactor: 100,
        renderIcon: false,
        isSorted: sortExpression?.name == "portalrelease",
        isSortedDescending: sortExpression?.sortDirection == 1,
      }
    ],
    openRecord: (reference: any) => {
      dataSet.openDatasetItem(reference as ComponentFramework.EntityReference);
    },
    selectRecords: (ids: string[]) => {
      // Cache selections in client-side mode
      if (useClientSideFiltering) {
        controlCache[SELECTED_IDS_CACHE_KEY] = ids;
      }
      dataSet.setSelectedRecordIds(ids);
    },
    selectedRecordsKeys: useClientSideFiltering && controlCache[SELECTED_IDS_CACHE_KEY]
      ? controlCache[SELECTED_IDS_CACHE_KEY]
      : dataSet.getSelectedRecordIds(),
    getFolderStructure: (): Promise<IFolder> => {
      const contextPage = (context as any).page;
      const locationEntityName = "sharepointdocumentlocation";
      const locationFetchXml = `<fetch mapping="logical">
                    <entity name="${locationEntityName}">
                        <attribute name="name" /> 
                        <attribute name="relativeurl" />
                        <attribute name="sitecollectionid" />
                        <attribute name="sharepointdocumentlocationid" />
                        <filter type="and">
                            ${
                              contextPage && contextPage.entityId
                                ? `<condition attribute="regardingobjectid" operator="eq" value="${contextPage.entityId}" />`
                                : `<condition attribute="regardingobjectid" operator="null" />`
                            }
                            <condition attribute="statecode" operator="eq" value="0" />
                            <condition attribute="statuscode" operator = "eq" value="1" />
                            <condition attribute="sitecollectionid" operator="not-null" value="true" />
                            <condition attribute="absoluteurl" operator="null" />
                        </filter>
                        <filter type="or">
                            <condition attribute="servicetype" operator="eq" value="0" />
                        </filter>
                        </entity>
                    </fetch>`;
      const locationFetchQuery =
        "?fetchXml=" + encodeURIComponent(locationFetchXml);

      return new Promise<IFolder>((resolve) => {
        if (folderStructure) {
          resolve(folderStructure);
        } else {
          context.webAPI
            .retrieveMultipleRecords(locationEntityName, locationFetchQuery)
            .then((result) => {
              const sharepointLocation =
                result && result.entities && result.entities.length > 0
                  ? result.entities[0]
                  : null;
              if (sharepointLocation) {
                const allDocuments =
                  useClientSideFiltering && controlCache[ALL_DOCUMENTS_CACHE_KEY]
                    ? Object.values(
                        controlCache[ALL_DOCUMENTS_CACHE_KEY] as Record<string, IFileSystemItem>
                      )
                    : dataSet.sortedRecordIds.map((recordId) => {
                        const record = dataSet.records[recordId];
                        return {
                          relativelocation: record.getFormattedValue("relativelocation"),
                          filetype: record.getFormattedValue("filetype"),
                          path: record.getFormattedValue("relativelocation"),
                        } as any;
                      });
                
                controlCache[FOLDER_STRUCTURE_KEY] = folderStructure = {
                  name: sharepointLocation.name,
                  path: sharepointLocation.relativeurl,
                  key: sharepointLocation.relativeurl,
                  children: buildFolderTreeFromDocuments(
                    sharepointLocation.relativeurl,
                    allDocuments
                  ),
                };
                resolve(folderStructure);
              }
            });
        }
      });
    },
    currentFolderContent,
    setSorting: (column: string, ascending: boolean) => {
      // FIX for Problem B: Handle sorting differently based on mode
      if (useClientSideFiltering) {
        // CLIENT-SIDE: Store sort state in cache and trigger re-render
        controlCache[SORT_STATE_KEY] = {
          name: column,
          sortDirection: ascending ? 0 : 1
        };
        // Use notifyOutputChanged to trigger re-render without fetching from server
        notifyOutputChanged();
      } else {
        // SERVER-SIDE: Use dataset sorting and refresh from server
        if (!dataSet.sorting) {
          dataSet.sorting = [];
        }
        if (dataSet.sorting.length > 0) {
          dataSet.sorting.pop();
        }
        dataSet.sorting.push({ name: column, sortDirection: ascending ? 0 : 1 });
        dataSet.refresh();
      }
    },
    setCurrentFolder: (path: string): void => {
      if (useClientSideFiltering) {
        controlCache[CURRENT_FOLDER_PATH_KEY] = path;

        const existingFilter = dataSet.filtering.getFilter() ?? {
          conditions: [],
          filterOperator: 0,
        };

        const locationConditionId = existingFilter.conditions.findIndex(
          (item) => item.attributeName == "relativelocation"
        );

        if (locationConditionId === -1) {
          existingFilter.conditions.push({
            attributeName: "relativelocation",
            value: path,
            conditionOperator: 0,
          });
        } else {
          existingFilter.conditions[locationConditionId].value = path;
        }

        dataSet.filtering.setFilter(existingFilter);
        notifyOutputChanged(); // Trigger immediate re-render with cached data
        dataSet.refresh(); // Background refresh
      } else {
        // SERVER-SIDE: Set filter and fetch from server
        const existingFilter = dataSet.filtering.getFilter();
        const dataFilter = existingFilter ?? {
          conditions: [],
          filterOperator: 0
        };
        const locationConditionId = dataFilter.conditions.findIndex(
          (item) => item.attributeName == "relativelocation"
        );

        if (locationConditionId == -1) {
          dataFilter.conditions.push({
            attributeName: "relativelocation",
            value: path,
            conditionOperator: 0,
          });
        } else {
          dataFilter.conditions[locationConditionId].value = path;
        }

        dataSet.filtering.setFilter(dataFilter);
        dataSet.refresh();
      }
    },
    currentFolderPath,
    resources,
    error,
    togglePortalRelease,
  };
};
