import path = require("path");
import { IInputs } from "../generated/ManifestTypes";
import { IFileSystemItem } from "./IFileSystemItem";
import { IFolder } from "./IFolder";
import { IFullFileExplorerProps } from "./IFullFileExplorerProps";

export const ALL_ITEMS_PAGE_SIZE = 5000;

const SHARED_LOCATION_GUID = "17DE0DBB-153C-4C1A-B98A-223B3EA10125";
const FOLDER_STRUCTURE_KEY = "FolderStructure";

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
  controlCache: { [index: string]: any }
): IFullFileExplorerProps => {
  const dataSet = context.parameters.documentsDataSet;
  let folderStructure = controlCache[FOLDER_STRUCTURE_KEY] as IFolder;

  const sortExpression =
    dataSet.sorting && dataSet.sorting.length > 0
      ? dataSet.sorting.pop()
      : { name: "", sortDirection: 0 };

  const currentFolderContent = dataSet.sortedRecordIds.map((recordId) => {
    const record = dataSet.records[recordId];
    const itemData = {} as IFileSystemItem;

    itemData["isSharedLocation"] =
      record.getValue("locationid") === SHARED_LOCATION_GUID;
    itemData.reference = (record as any)._entityReference;
    itemData.key = record.getRecordId();
    itemData.path = record.getFormattedValue("relativelocation");
    dataSet.columns.forEach((c) => {
      itemData[c.name] = record.getFormattedValue(c.name);
      if (c.name === "ischeckedout") {
        itemData[c.name] = record.getValue(c.name);
      }
    });

    return itemData;
  });

  const relativelocationCondition = dataSet.filtering
    .getFilter()
    ?.conditions?.filter(
      (condition) => condition.attributeName == "relativelocation"
    );

  const currentFolderPath =
    !relativelocationCondition || relativelocationCondition.length == 0
      ? ""
      : (relativelocationCondition[0].value as string);

  // Rebuild folder structure from all loaded documents if we have a root folder
  if (folderStructure && dataSet.sortedRecordIds.length > 0) {
    // Get all documents from the dataset (not just current folder)
    const allDocuments = dataSet.sortedRecordIds.map((recordId) => {
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

  return {
    hideFoldersPane: context.parameters.hideFoldersPane
      ? context.parameters.hideFoldersPane.raw
      : false,
    columns: dataSet.columns
      .filter((c) => !c.isHidden)
      .map((c) => {
        return {
          name: c.name,
          displayName: c.displayName,
          isPrimary: c.isPrimary,
          isSortable: !c.disableSorting,
          visualSizeFactor: c.visualSizeFactor,
          renderIcon: c.name === "fullname",
          isSorted: sortExpression?.name == c.name,
          isSortedDescending: sortExpression?.sortDirection == 1,
        };
      }),
    openRecord: (reference: any) => {
      dataSet.openDatasetItem(reference as ComponentFramework.EntityReference);
    },
    selectRecords: (ids: string[]) => {
      dataSet.setSelectedRecordIds(ids);
    },
    selectedRecordsKeys: dataSet.getSelectedRecordIds(),
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
                // Get all documents to build folder structure
                const allDocuments = dataSet.sortedRecordIds.map((recordId) => {
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
      if (!dataSet.sorting) {
        dataSet.sorting = [];
      }
      if (dataSet.sorting.length > 0) {
        dataSet.sorting.pop();
      }
      dataSet.sorting.push({ name: column, sortDirection: ascending ? 0 : 1 });
      dataSet.refresh();
    },
    setCurrentFolder: (path: string): void => {
      const existingFilter = dataSet.filtering.getFilter();
      const dataFilter = existingFilter ?? { 
        conditions: [],
        filterOperator: 0 
      };
      const locationConditionId = dataFilter.conditions.findIndex(
        (item) => item.attributeName == "relativelocation"
      );
      
      // Always set a filter, even for root folder
      if (locationConditionId == -1) {
        dataFilter.conditions.push({
          attributeName: "relativelocation",
          value: path,
          conditionOperator: 0, // Equals operator
        });
      } else {
        dataFilter.conditions[locationConditionId].value = path;
      }
      
      dataSet.filtering.setFilter(dataFilter);
      dataSet.refresh();
    },
    currentFolderPath,
  };
};
