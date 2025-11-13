# Build Documentation

## Overview
This document provides detailed instructions for building the PCF-SPFileExplorer control and generating the solution package for Power Apps deployment.

## Prerequisites
- Developer PowerShell for Visual Studio
- MSBuild tools installed
- Node.js and npm installed

## Version Management

Before building, you should increment the version numbers in two locations:

### 1. Control Version (ControlManifest.Input.xml)
**File Location:** `SPFileExplorer/ControlManifest.Input.xml`

**Current Version:** `0.0.5`

Update the `version` attribute in line 3:
```xml
<control namespace="JSSPFileExplorer" constructor="SPFileExplorer" version="0.0.5" ... >
```

**Version Format:** `major.minor.patch` (e.g., 0.0.6, 0.1.0, 1.0.0)

### 2. Solution Version (Solution.xml)
**File Location:** `Solution/SPFileExplorerSolution/src/Other/Solution.xml`

**Current Version:** `1.0.0.1`

Update the `<Version>` element around line 13:
```xml
<Version>1.0.0.1</Version>
```

**Version Format:** `major.minor.build.revision` (e.g., 1.0.0.2, 1.0.1.0, 1.1.0.0)

## Build Process

### Step 1: Navigate to Solution Directory
Open Developer PowerShell and navigate to the solution directory:
```powershell
cd \PCF-SPFileExplorer\Solution\SPFileExplorerSolution
```

### Step 2: Restore Dependencies
Restore all NuGet packages and dependencies:
```powershell
msbuild /t:restore
```

### Step 3: Build Solution
Build the solution in Release configuration:
```powershell
msbuild /t:build /p:Configuration=Release
```

## Build Output

After a successful build, the solution package will be located at:

**Output Directory:** `Solution/SPFileExplorerSolution/bin/Release/`

**Output Files:**
- **Managed Solution:** `JSSPFileExplorerSolution.zip`


## Notes
- Always increment versions before building for production
- Always Publish All after import
- Test the solution in a development environment before deploying to production
- Keep track of version history
