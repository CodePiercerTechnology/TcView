using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
};

static long ReadRequestId(JsonObject request)
{
    var idNode = request["id"];
    if (idNode is null)
    {
        return 0;
    }

    try
    {
        return idNode.GetValue<long>();
    }
    catch
    {
        try
        {
            var text = idNode.ToString();
            return long.TryParse(text, out var parsed) ? parsed : 0;
        }
        catch
        {
            return 0;
        }
    }
}

while (true)
{
    var line = Console.ReadLine();
    if (line is null)
    {
        break;
    }

    if (string.IsNullOrWhiteSpace(line))
    {
        continue;
    }

    JsonObject? request;
    try
    {
        request = JsonNode.Parse(line) as JsonObject;
    }
    catch
    {
        continue;
    }

    if (request is null)
    {
        continue;
    }

    var id = ReadRequestId(request);
    var method = request["method"]?.GetValue<string>() ?? string.Empty;

    object result = method switch
    {
        "initialize" => HandleInitialize(request),
        "scanProject" => HandleScanProject(request),
        "runPipeline" => HandleRunPipeline(request),
        "installLibraryProject" => HandleInstallLibraryProject(request),
        "addLibraryReference" => HandleAddLibraryReference(request),
        "removeLibraryReference" => HandleRemoveLibraryReference(request),
        _ => new ScanResult(
            Array.Empty<LibraryRef>(),
            Array.Empty<BackendSymbol>(),
            Array.Empty<BackendSymbol>(),
            new[] { $"Unknown method: {method}" }
        )
    };

    var response = new
    {
        id,
        result
    };

    Console.WriteLine(JsonSerializer.Serialize(response, jsonOptions));
}

static object HandleInitialize(JsonObject request)
{
    var workspacePath = request["params"]?["workspacePath"]?.GetValue<string>();
    var diagnostics = new List<string>();
    if (!string.IsNullOrWhiteSpace(workspacePath))
    {
        diagnostics.Add($"Workspace: {workspacePath}");
    }

    // Runtime check only; full Automation Interface integration comes next.
    var aiProgId = ResolveAutomationProgId();
    diagnostics.Add(aiProgId is not null
        ? $"TwinCAT Automation Interface COM ProgID detected: {aiProgId}."
        : "TwinCAT Automation Interface COM ProgID not detected (checked TCatSysManager.TcSysManager, TcSysManagerRM). Using filesystem metadata scan.");

    return new
    {
        backendVersion = "0.2.0",
        capabilities = new[] { "metadata_scan", "filesystem_library_scan", "source_root_scan", "com_probe" },
        diagnostics
    };
}

static object HandleScanProject(JsonObject request)
{
    var projectPath = request["params"]?["projectPath"]?.GetValue<string>();
    var preferAutomationInterface = request["params"]?["preferAutomationInterface"]?.GetValue<bool?>() ?? true;
    var librarySourceRoots = ReadStringArray(request["params"]?["librarySourceRoots"]);
    var tmcRoots = ReadStringArray(request["params"]?["tmcRoots"]);
    var autoBuildTmcIfMissing = request["params"]?["autoBuildTmcIfMissing"]?.GetValue<bool?>() ?? true;
    if (string.IsNullOrWhiteSpace(projectPath) || !Directory.Exists(projectPath))
    {
        return new ScanResult(
            Array.Empty<LibraryRef>(),
            Array.Empty<BackendSymbol>(),
            Array.Empty<BackendSymbol>(),
            new[] { "scanProject: project path missing or not found." }
        );
    }

    var diagnostics = new List<string>();
    var libraries = new List<LibraryRef>();
    var hasProjectTmc = Directory.EnumerateFiles(projectPath, "*.tmc", SearchOption.TopDirectoryOnly).Any();

    if (!preferAutomationInterface && hasProjectTmc)
    {
        diagnostics.Add("TMC-first mode active: skipping initial Automation Interface scan.");
    }
    else if (preferAutomationInterface)
    {
        libraries.AddRange(ScanLibrariesViaAutomationInterface(projectPath, diagnostics));
    }
    libraries.AddRange(ScanLibrariesFromPlcProjReferences(projectPath, diagnostics));
    libraries.AddRange(ScanLibrariesFromFolders(projectPath, diagnostics));
    libraries = libraries
        .DistinctBy(l => $"{l.Vendor}|{l.Name}|{l.Version}|{l.Path}".ToLowerInvariant())
        .OrderBy(l => l.Vendor)
        .ThenBy(l => l.Name)
        .ThenBy(l => l.Version)
        .ToList();

    var metadataSymbols = BuildMetadataSymbols(libraries);
    var aiSymbols = BuildAutomationInterfaceSymbols(libraries, diagnostics);
    var tmcSymbols = BuildTmcSymbols(libraries, projectPath, tmcRoots, diagnostics, autoBuildTmcIfMissing);
    var browserCacheSymbols = BuildManagedLibraryBrowserCacheSymbols(libraries, diagnostics);
    var sourceSymbols = BuildLibrarySourceSymbols(libraries, librarySourceRoots, diagnostics);
    var librarySymbols = MergeLibrarySymbolsByPrecedence(metadataSymbols, browserCacheSymbols, sourceSymbols, tmcSymbols, aiSymbols);
    var sourceLikeSymbols = MergeLibrarySymbolsByPrecedence(Array.Empty<BackendSymbol>(), browserCacheSymbols, sourceSymbols, tmcSymbols, aiSymbols);
    if (sourceLikeSymbols.Count > 0)
    {
        var libsWithSource = new HashSet<string>(sourceLikeSymbols
            .Where(s => !string.IsNullOrWhiteSpace(s.Library))
            .Select(s => s.Library.ToUpperInvariant()));
        libraries = libraries.Select(lib =>
        {
            if (!libsWithSource.Contains(lib.Name.ToUpperInvariant())) return lib;
            if (lib.Mode == "full_source" || lib.Mode == "public_symbols") return lib;
            return lib with { Mode = "public_symbols" };
        }).ToList();
    }
    if (sourceSymbols.Count > 0)
    {
        var libsWithSource = new HashSet<string>(sourceSymbols
            .Where(s => !string.IsNullOrWhiteSpace(s.Library))
            .Select(s => s.Library.ToUpperInvariant()));
        libraries = libraries.Select(lib =>
        {
            if (!libsWithSource.Contains(lib.Name.ToUpperInvariant())) return lib;
            return lib with { Mode = "full_source" };
        }).ToList();
    }

    return new ScanResult(libraries, metadataSymbols, librarySymbols, diagnostics);
}

static object HandleRunPipeline(JsonObject request)
{
    var projectPath = request["params"]?["projectPath"]?.GetValue<string>();
    var anchorPath = request["params"]?["anchorPath"]?.GetValue<string>();
    var activateConfiguration = request["params"]?["activateConfiguration"]?.GetValue<bool?>() ?? true;
    var login = request["params"]?["login"]?.GetValue<bool?>() ?? true;
    var startRuntime = request["params"]?["startRuntime"]?.GetValue<bool?>() ?? true;
    var diagnostics = new List<string>();

    if (string.IsNullOrWhiteSpace(projectPath) || !Directory.Exists(projectPath))
    {
        return new { success = false, diagnostics = new[] { "runPipeline: project path missing or not found." } };
    }

    var resolvedProgId = ResolveAutomationProgId();
    var progIdType = resolvedProgId is not null ? Type.GetTypeFromProgID(resolvedProgId) : null;
    if (progIdType is null)
    {
        return new
        {
            success = false,
            diagnostics = new[] { "runPipeline: Automation Interface not available (ProgID not found)." }
        };
    }
    diagnostics.Add($"runPipeline: using Automation Interface ProgID {resolvedProgId}");

    var tsproj = ResolvePipelineTsproj(projectPath, anchorPath);
    if (string.IsNullOrWhiteSpace(tsproj))
    {
        return new { success = false, diagnostics = new[] { "runPipeline: no .tsproj found." } };
    }
    diagnostics.Add($"runPipeline: target tsproj {tsproj}");

    var finished = new ManualResetEventSlim(false);
    Exception? threadError = null;
    var success = true;

    var thread = new Thread(() =>
    {
        object? sysManager = null;
        try
        {
            sysManager = CreateAutomationInterfaceInstance(resolvedProgId, progIdType, diagnostics);
            if (sysManager is null)
            {
                diagnostics.Add("runPipeline: failed to create SysManager instance.");
                success = false;
                return;
            }

            if (!TryInvoke(sysManager, "OpenConfiguration", tsproj) &&
                !TryInvoke(sysManager, "OpenProject", tsproj) &&
                !TryInvoke(sysManager, "Open", tsproj))
            {
                diagnostics.Add("runPipeline: could not open project via OpenConfiguration/OpenProject/Open.");
                success = false;
                return;
            }
            diagnostics.Add("runPipeline: project opened.");

            if (activateConfiguration)
            {
                var activated =
                    TryInvoke(sysManager, "ActivateConfiguration") ||
                    TryInvoke(sysManager, "ActivateConfig") ||
                    TryInvoke(sysManager, "Activate");
                diagnostics.Add(activated
                    ? "runPipeline: configuration activation requested and invoked."
                    : "runPipeline: configuration activation method unavailable/failed.");
                success &= activated;
            }

            if (login)
            {
                var loggedIn =
                    TryInvoke(sysManager, "Login") ||
                    TryInvoke(sysManager, "LoginAndStart") ||
                    TryInvoke(sysManager, "Online");
                diagnostics.Add(loggedIn
                    ? "runPipeline: PLC login requested and invoked."
                    : "runPipeline: login method unavailable/failed.");
                success &= loggedIn;
            }

            if (startRuntime)
            {
                var started =
                    TryInvoke(sysManager, "StartRestartTwinCAT") ||
                    TryInvoke(sysManager, "StartRestartTwinCat") ||
                    TryInvoke(sysManager, "Start") ||
                    TryInvoke(sysManager, "Run");
                diagnostics.Add(started
                    ? "runPipeline: runtime start requested and invoked."
                    : "runPipeline: runtime start method unavailable/failed.");
                success &= started;
            }

            TryInvoke(sysManager, "SaveConfiguration");
            TryInvoke(sysManager, "CloseConfiguration");
            TryInvoke(sysManager, "Close");
        }
        catch (Exception ex)
        {
            threadError = ex;
            success = false;
        }
        finally
        {
            finished.Set();
        }
    });

    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();

    if (!finished.Wait(TimeSpan.FromSeconds(45)))
    {
        diagnostics.Add("runPipeline: timed out after 45 seconds.");
        success = false;
        return new { success, diagnostics };
    }

    if (threadError is not null)
    {
        diagnostics.Add($"runPipeline: failed with exception: {threadError.Message}");
        success = false;
    }

    return new { success, diagnostics };
}

static object HandleInstallLibraryProject(JsonObject request)
{
    var tsprojPath = request["params"]?["tsprojPath"]?.GetValue<string>();
    var plcprojPath = request["params"]?["plcprojPath"]?.GetValue<string>();
    var solutionPath = request["params"]?["solutionPath"]?.GetValue<string>();
    var outputDirectory = request["params"]?["outputDirectory"]?.GetValue<string>();
    var diagnostics = new List<string>();

    if (string.IsNullOrWhiteSpace(tsprojPath) || !File.Exists(tsprojPath))
    {
        return new AutomationOperationResult(false, null, new[] { "installLibraryProject: tsproj path missing or not found." });
    }
    if (string.IsNullOrWhiteSpace(plcprojPath) || !File.Exists(plcprojPath))
    {
        return new AutomationOperationResult(false, null, new[] { "installLibraryProject: plcproj path missing or not found." });
    }

    var plcProjectName = ResolvePlcProjectName(plcprojPath) ?? Path.GetFileNameWithoutExtension(plcprojPath);
    var outputPath = Path.Combine(
        string.IsNullOrWhiteSpace(outputDirectory) ? Path.GetTempPath() : outputDirectory,
        $"{plcProjectName}.library");

    return RunTwinCATAutomation(tsprojPath, solutionPath, diagnostics, sysManager =>
    {
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        var plcProject = FindPlcProjectTreeItem(sysManager, plcProjectName, diagnostics);
        if (plcProject is null)
        {
            diagnostics.Add($"installLibraryProject: PLC project '{plcProjectName}' was not found in the TwinCAT tree.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        if (!TryInvokeWithDiagnostics(plcProject, diagnostics, "SaveAsLibrary", outputPath, true))
        {
            diagnostics.Add("installLibraryProject: SaveAsLibrary failed.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        diagnostics.Add($"installLibraryProject: library saved and installed from project '{plcProjectName}'.");
        return new AutomationOperationResult(true, outputPath, diagnostics);
    });
}

static object HandleAddLibraryReference(JsonObject request)
{
    var tsprojPath = request["params"]?["tsprojPath"]?.GetValue<string>();
    var plcprojPath = request["params"]?["plcprojPath"]?.GetValue<string>();
    var solutionPath = request["params"]?["solutionPath"]?.GetValue<string>();
    var libraryName = request["params"]?["libraryName"]?.GetValue<string>();
    var version = request["params"]?["version"]?.GetValue<string>()?.Trim();
    var vendor = request["params"]?["vendor"]?.GetValue<string>()?.Trim();
    var diagnostics = new List<string>();

    if (string.IsNullOrWhiteSpace(plcprojPath) || !File.Exists(plcprojPath))
    {
        return new AutomationOperationResult(false, null, new[] { "addLibraryReference: plcproj path missing or not found." });
    }
    if (string.IsNullOrWhiteSpace(libraryName))
    {
        return new AutomationOperationResult(false, null, new[] { "addLibraryReference: library name missing." });
    }

    var libraryNameValue = libraryName;
    var plcprojPathValue = plcprojPath;
    diagnostics.Add("addLibraryReference: using .plcproj PlaceholderReference update as primary path.");
    var directAdded = AddPlaceholderReferenceToPlcProj(plcprojPathValue, libraryNameValue, version, vendor, diagnostics);
    if (directAdded)
    {
        return new AutomationOperationResult(true, null, diagnostics);
    }

    diagnostics.Add("addLibraryReference: primary .plcproj update did not complete. Trying TwinCAT Automation Interface fallback.");
    if (string.IsNullOrWhiteSpace(tsprojPath) || !File.Exists(tsprojPath))
    {
        diagnostics.Add("addLibraryReference: fallback unavailable because tsproj path is missing or not found.");
        return new AutomationOperationResult(false, null, diagnostics);
    }

    var plcProjectName = ResolvePlcProjectName(plcprojPath) ?? Path.GetFileNameWithoutExtension(plcprojPath);
    return RunTwinCATAutomation(tsprojPath, solutionPath, diagnostics, sysManager =>
    {
        var referencesItem = FindPlcReferencesTreeItem(sysManager, plcProjectName, diagnostics);
        if (referencesItem is null)
        {
            diagnostics.Add($"addLibraryReference: fallback failed because References node for '{plcProjectName}' was not found.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        var added =
            TryInvokeWithDiagnostics(referencesItem, diagnostics, "AddLibrary", libraryNameValue, version ?? string.Empty, vendor ?? string.Empty) ||
            TryInvokeWithDiagnostics(referencesItem, diagnostics, "AddLibrary", libraryNameValue);
        if (!added)
        {
            diagnostics.Add($"addLibraryReference: fallback AddLibrary failed for '{libraryName}'.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        diagnostics.Add($"addLibraryReference: added '{libraryName}' to '{plcProjectName}'.");
        return new AutomationOperationResult(true, null, diagnostics);
    });
}

static object HandleRemoveLibraryReference(JsonObject request)
{
    var tsprojPath = request["params"]?["tsprojPath"]?.GetValue<string>();
    var plcprojPath = request["params"]?["plcprojPath"]?.GetValue<string>();
    var solutionPath = request["params"]?["solutionPath"]?.GetValue<string>();
    var referenceName = request["params"]?["referenceName"]?.GetValue<string>();
    var version = request["params"]?["version"]?.GetValue<string>()?.Trim();
    var vendor = request["params"]?["vendor"]?.GetValue<string>()?.Trim();
    var displayName = request["params"]?["displayName"]?.GetValue<string>()?.Trim();
    var diagnostics = new List<string>();

    if (string.IsNullOrWhiteSpace(plcprojPath) || !File.Exists(plcprojPath))
    {
        return new AutomationOperationResult(false, null, new[] { "removeLibraryReference: plcproj path missing or not found." });
    }
    if (string.IsNullOrWhiteSpace(referenceName))
    {
        return new AutomationOperationResult(false, null, new[] { "removeLibraryReference: reference name missing." });
    }

    var referenceNameValue = referenceName;
    var plcprojPathValue = plcprojPath;
    diagnostics.Add("removeLibraryReference: using .plcproj PlaceholderReference update as primary path.");
    var directRemoved = RemovePlaceholderReferenceFromPlcProj(plcprojPathValue, referenceNameValue, displayName, diagnostics);
    if (directRemoved)
    {
        return new AutomationOperationResult(true, null, diagnostics);
    }

    diagnostics.Add("removeLibraryReference: primary .plcproj update did not complete. Trying TwinCAT Automation Interface fallback.");
    if (string.IsNullOrWhiteSpace(tsprojPath) || !File.Exists(tsprojPath))
    {
        diagnostics.Add("removeLibraryReference: fallback unavailable because tsproj path is missing or not found.");
        return new AutomationOperationResult(false, null, diagnostics);
    }

    var plcProjectName = ResolvePlcProjectName(plcprojPath) ?? Path.GetFileNameWithoutExtension(plcprojPath);
    return RunTwinCATAutomation(tsprojPath, solutionPath, diagnostics, sysManager =>
    {
        var referencesItem = FindPlcReferencesTreeItem(sysManager, plcProjectName, diagnostics);
        if (referencesItem is null)
        {
            diagnostics.Add($"removeLibraryReference: fallback failed because References node for '{plcProjectName}' was not found.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        var removed =
            (!string.IsNullOrWhiteSpace(displayName) && TryInvokeWithDiagnostics(referencesItem, diagnostics, "RemoveReference", displayName!)) ||
            TryInvokeWithDiagnostics(referencesItem, diagnostics, "RemoveReference", referenceNameValue, version ?? string.Empty, vendor ?? string.Empty) ||
            TryInvokeWithDiagnostics(referencesItem, diagnostics, "RemoveReference", referenceNameValue);
        if (!removed)
        {
            diagnostics.Add($"removeLibraryReference: fallback RemoveReference failed for '{referenceName}'.");
            return new AutomationOperationResult(false, null, diagnostics);
        }

        diagnostics.Add($"removeLibraryReference: removed '{referenceName}' from '{plcProjectName}'.");
        return new AutomationOperationResult(true, null, diagnostics);
    });
}

static string? ResolvePipelineTsproj(string projectPath, string? anchorPath)
{
    var candidates = Directory.EnumerateFiles(projectPath, "*.tsproj", SearchOption.AllDirectories).ToArray();
    if (candidates.Length == 0)
    {
        return null;
    }
    if (candidates.Length == 1 || string.IsNullOrWhiteSpace(anchorPath))
    {
        return candidates[0];
    }

    var anchor = anchorPath.Replace('/', Path.DirectorySeparatorChar);
    var best = candidates
        .OrderByDescending(candidate => SharedPrefixLength(anchor, candidate))
        .FirstOrDefault();
    return best ?? candidates[0];
}

static int SharedPrefixLength(string a, string b)
{
    var max = Math.Min(a.Length, b.Length);
    var i = 0;
    while (i < max && char.ToLowerInvariant(a[i]) == char.ToLowerInvariant(b[i]))
    {
        i++;
    }
    return i;
}

static IReadOnlyList<LibraryRef> ScanLibrariesViaAutomationInterface(string projectPath, List<string> diagnostics)
{
    var result = new List<LibraryRef>();
    var resolvedProgId = ResolveAutomationProgId();
    var progIdType = resolvedProgId is not null ? Type.GetTypeFromProgID(resolvedProgId) : null;
    if (progIdType is null)
    {
        diagnostics.Add("Automation Interface not available: no supported ProgID registered (TCatSysManager.TcSysManager, TcSysManagerRM).");
        return result;
    }
    diagnostics.Add($"Automation Interface using ProgID: {resolvedProgId}");

    var tsproj = Directory.EnumerateFiles(projectPath, "*.tsproj", SearchOption.AllDirectories).FirstOrDefault();
    if (string.IsNullOrWhiteSpace(tsproj))
    {
        diagnostics.Add("Automation Interface scan skipped: no .tsproj found.");
        return result;
    }

    var finished = new ManualResetEventSlim(false);
    Exception? threadError = null;

    var thread = new Thread(() =>
    {
        try
        {
            var sysManager = CreateAutomationInterfaceInstance(resolvedProgId, progIdType, diagnostics);
            if (sysManager is null)
            {
                diagnostics.Add("Automation Interface scan failed: could not create SysManager instance.");
                return;
            }

            // Method names differ across versions; try common candidates.
            if (!TryInvoke(sysManager, "OpenConfiguration", tsproj) &&
                !TryInvoke(sysManager, "OpenProject", tsproj) &&
                !TryInvoke(sysManager, "Open", tsproj))
            {
                diagnostics.Add("Automation Interface scan: unable to open project via OpenConfiguration/OpenProject/Open.");
                return;
            }

            // TwinCAT AI object-model traversal is version-specific. This pass verifies project open capability.
            diagnostics.Add("Automation Interface project open succeeded.");

            // Placeholder for concrete ITcPlcLibraryManager traversal once COM interop interfaces are referenced.
            // Keep empty here; downstream scanners still provide useful metadata.
            TryInvoke(sysManager, "CloseConfiguration");
        }
        catch (Exception ex)
        {
            threadError = ex;
        }
        finally
        {
            finished.Set();
        }
    });

    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();

    if (!finished.Wait(TimeSpan.FromSeconds(15)))
    {
        diagnostics.Add("Automation Interface scan timed out after 15 seconds.");
        return result;
    }

    if (threadError is not null)
    {
        diagnostics.Add($"Automation Interface scan failed: {threadError.Message}");
    }

    return result;
}

static string? ResolveAutomationProgId()
{
    var candidates = new[]
    {
        "TCatSysManager.TcSysManager",
        "TcSysManagerRM"
    };

    foreach (var candidate in candidates)
    {
        try
        {
            if (Type.GetTypeFromProgID(candidate) is not null)
            {
                return candidate;
            }
        }
        catch
        {
            // Keep probing next candidate.
        }
    }

    return null;
}

static object? CreateAutomationInterfaceInstance(string resolvedProgId, Type progIdType, List<string>? diagnostics = null)
{
    var root = Activator.CreateInstance(progIdType);
    if (root is null)
    {
        return null;
    }

    if (resolvedProgId.Equals("TcSysManagerRM", StringComparison.OrdinalIgnoreCase))
    {
        var manager =
            TryInvokeForResult(root, "CreateSysManager15") ??
            TryInvokeForResult(root, "CreateSysManager");
        if (manager is not null)
        {
            diagnostics?.Add("TwinCAT Automation Interface: created SysManager instance through TcSysManagerRM.");
            return manager;
        }

        diagnostics?.Add("TwinCAT Automation Interface: TcSysManagerRM was available, but CreateSysManager15/CreateSysManager failed.");
    }

    return root;
}

static AutomationOperationResult RunTwinCATAutomation(
    string tsprojPath,
    string? solutionPath,
    List<string> diagnostics,
    Func<object, AutomationOperationResult> action)
{
    var resolvedProgId = ResolveAutomationProgId();
    var progIdType = resolvedProgId is not null ? Type.GetTypeFromProgID(resolvedProgId) : null;
    if (progIdType is null)
    {
        diagnostics.Add("TwinCAT Automation Interface not available.");
        return new AutomationOperationResult(false, null, diagnostics);
    }

    var finished = new ManualResetEventSlim(false);
    Exception? threadError = null;
    AutomationOperationResult? result = null;

    var thread = new Thread(() =>
    {
        object? sysManager = null;
        try
        {
            sysManager = CreateAutomationInterfaceInstance(resolvedProgId!, progIdType, diagnostics);
            if (sysManager is null)
            {
                diagnostics.Add("TwinCAT Automation Interface: failed to create SysManager instance.");
                result = new AutomationOperationResult(false, null, diagnostics);
                return;
            }

            if (!TryOpenTwinCATProject(sysManager, tsprojPath, solutionPath, diagnostics))
            {
                result = new AutomationOperationResult(false, null, diagnostics);
                return;
            }

            result = action(sysManager);
        }
        catch (Exception ex)
        {
            threadError = ex;
        }
        finally
        {
            if (sysManager is not null)
            {
                TryInvoke(sysManager, "SaveConfiguration");
                TryInvoke(sysManager, "CloseConfiguration");
                TryInvoke(sysManager, "Close");
            }
            finished.Set();
        }
    });

    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();

    if (!finished.Wait(TimeSpan.FromSeconds(45)))
    {
        diagnostics.Add("TwinCAT Automation Interface operation timed out after 45 seconds.");
        return new AutomationOperationResult(false, null, diagnostics);
    }

    if (threadError is not null)
    {
        diagnostics.Add($"TwinCAT Automation Interface operation failed: {threadError.Message}");
        return new AutomationOperationResult(false, null, diagnostics);
    }

    return result ?? new AutomationOperationResult(false, null, diagnostics);
}

static bool TryOpenTwinCATProject(object sysManager, string tsprojPath, string? solutionPath, List<string> diagnostics)
{
    // Try multiple open targets because different Automation Interface versions prefer different entry files.
    var openTargets = new List<string>();

    if (!string.IsNullOrWhiteSpace(tsprojPath))
    {
        openTargets.Add(tsprojPath);
    }

    if (!string.IsNullOrWhiteSpace(solutionPath))
    {
        openTargets.Add(solutionPath);
    }

    var tsprojDir = Path.GetDirectoryName(tsprojPath);
    if (!string.IsNullOrWhiteSpace(tsprojDir) && Directory.Exists(tsprojDir))
    {
        foreach (var siblingSolution in Directory.EnumerateFiles(tsprojDir, "*.sln", SearchOption.TopDirectoryOnly))
        {
            openTargets.Add(siblingSolution);
        }
    }

    foreach (var target in openTargets
        .Where(path => !string.IsNullOrWhiteSpace(path))
        .Distinct(StringComparer.OrdinalIgnoreCase))
    {
        if (TryInvokeWithDiagnostics(sysManager, diagnostics, "OpenConfiguration", target))
        {
            diagnostics.Add($"TwinCAT Automation Interface: opened project via OpenConfiguration -> {target}");
            return true;
        }

        if (TryInvokeWithDiagnostics(sysManager, diagnostics, "OpenProject", target))
        {
            diagnostics.Add($"TwinCAT Automation Interface: opened project via OpenProject -> {target}");
            return true;
        }

        if (TryInvokeWithDiagnostics(sysManager, diagnostics, "Open", target))
        {
            diagnostics.Add($"TwinCAT Automation Interface: opened project via Open -> {target}");
            return true;
        }
    }

    diagnostics.Add("TwinCAT Automation Interface: unable to open the TwinCAT project.");
    return false;
}

static bool TryInvokeWithDiagnostics(object instance, List<string> diagnostics, string methodName, params object[] args)
{
    try
    {
        instance.GetType().InvokeMember(
            methodName,
            System.Reflection.BindingFlags.InvokeMethod | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
            null,
            instance,
            args
        );
        diagnostics.Add($"{methodName} invoked successfully.");
        return true;
    }
    catch (Exception ex)
    {
        diagnostics.Add($"{methodName} failed: {ex.Message}");
        return false;
    }
}

static bool TryInvoke(object instance, string methodName, params object[] args)
{
    try
    {
        instance.GetType().InvokeMember(
            methodName,
            System.Reflection.BindingFlags.InvokeMethod | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
            null,
            instance,
            args
        );
        return true;
    }
    catch
    {
        return false;
    }
}

static object? TryInvokeForResult(object instance, string methodName, params object[] args)
{
    try
    {
        return instance.GetType().InvokeMember(
            methodName,
            System.Reflection.BindingFlags.InvokeMethod | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
            null,
            instance,
            args
        );
    }
    catch
    {
        return null;
    }
}

static object? TryGetProperty(object instance, string propertyName)
{
    try
    {
        return instance.GetType().InvokeMember(
            propertyName,
            System.Reflection.BindingFlags.GetProperty | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
            null,
            instance,
            Array.Empty<object>()
        );
    }
    catch
    {
        return null;
    }
}

static string? ResolvePlcProjectName(string plcprojPath)
{
    try
    {
        var doc = XDocument.Load(plcprojPath);
        var nameValue = doc.Descendants().FirstOrDefault(node => node.Name.LocalName.Equals("Name", StringComparison.OrdinalIgnoreCase))?.Value?.Trim();
        if (!string.IsNullOrWhiteSpace(nameValue))
        {
            return nameValue;
        }
    }
    catch
    {
        // Fall back to filename.
    }

    return Path.GetFileNameWithoutExtension(plcprojPath);
}

static bool AddPlaceholderReferenceToPlcProj(
    string plcprojPath,
    string libraryName,
    string? version,
    string? vendor,
    List<string> diagnostics)
{
    try
    {
        var doc = XDocument.Load(plcprojPath, LoadOptions.PreserveWhitespace);
        var root = doc.Root;
        if (root is null)
        {
            diagnostics.Add("addLibraryReference: direct .plcproj edit failed because the PLC project XML has no root element.");
            return false;
        }

        var referenceName = NormalizeReferenceToken(libraryName);
        var existingReference = root
            .Descendants()
            .FirstOrDefault(node => node.Name.LocalName.Equals("PlaceholderReference", StringComparison.OrdinalIgnoreCase) &&
                PlaceholderReferenceMatches(node, referenceName, null));
        if (existingReference is not null)
        {
            diagnostics.Add($"addLibraryReference: '{libraryName}' already exists in {Path.GetFileName(plcprojPath)}.");
            return true;
        }

        var ns = root.Name.Namespace;
        var placeholderName = ns + "PlaceholderReference";
        var targetItemGroup = root
            .Elements(ns + "ItemGroup")
            .FirstOrDefault(group => group.Elements(placeholderName).Any());
        if (targetItemGroup is null)
        {
            targetItemGroup = new XElement(ns + "ItemGroup");
            var projectExtensions = root.Element(ns + "ProjectExtensions");
            if (projectExtensions is not null)
            {
                projectExtensions.AddBeforeSelf(targetItemGroup);
            }
            else
            {
                root.Add(targetItemGroup);
            }
        }

        var referenceElement = new XElement(
            placeholderName,
            new XAttribute("Include", libraryName),
            new XElement(ns + "DefaultResolution", BuildPlaceholderDefaultResolution(libraryName, version, vendor)),
            new XElement(ns + "Namespace", libraryName));
        targetItemGroup.Add(referenceElement);

        doc.Save(plcprojPath, SaveOptions.DisableFormatting);
        diagnostics.Add($"addLibraryReference: added '{libraryName}' directly to {Path.GetFileName(plcprojPath)}.");
        return true;
    }
    catch (Exception ex)
    {
        diagnostics.Add($"addLibraryReference: direct .plcproj edit failed: {ex.Message}");
        return false;
    }
}

static bool RemovePlaceholderReferenceFromPlcProj(
    string plcprojPath,
    string referenceName,
    string? displayName,
    List<string> diagnostics)
{
    try
    {
        var doc = XDocument.Load(plcprojPath, LoadOptions.PreserveWhitespace);
        var root = doc.Root;
        if (root is null)
        {
            diagnostics.Add("removeLibraryReference: direct .plcproj edit failed because the PLC project XML has no root element.");
            return false;
        }

        var normalizedReference = NormalizeReferenceToken(referenceName);
        var normalizedDisplay = NormalizeReferenceToken(displayName);
        var matches = root
            .Descendants()
            .Where(node => node.Name.LocalName.Equals("PlaceholderReference", StringComparison.OrdinalIgnoreCase))
            .Where(node => PlaceholderReferenceMatches(node, normalizedReference, normalizedDisplay))
            .ToList();

        if (matches.Count == 0)
        {
            diagnostics.Add($"removeLibraryReference: '{referenceName}' was not found in {Path.GetFileName(plcprojPath)}.");
            return false;
        }

        foreach (var match in matches)
        {
            match.Remove();
        }

        doc.Save(plcprojPath, SaveOptions.DisableFormatting);
        diagnostics.Add($"removeLibraryReference: removed '{referenceName}' directly from {Path.GetFileName(plcprojPath)}.");
        return true;
    }
    catch (Exception ex)
    {
        diagnostics.Add($"removeLibraryReference: direct .plcproj edit failed: {ex.Message}");
        return false;
    }
}

static bool PlaceholderReferenceMatches(XElement placeholderReference, string referenceName, string? displayName)
{
    var candidateNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var candidate in ExpandReferenceCandidates(referenceName))
    {
        candidateNames.Add(candidate);
    }
    foreach (var candidate in ExpandReferenceCandidates(displayName))
    {
        candidateNames.Add(candidate);
    }

    if (candidateNames.Count == 0)
    {
        return false;
    }

    var includeValue = placeholderReference.Attribute("Include")?.Value;
    var namespaceValue = placeholderReference.Elements()
        .FirstOrDefault(node => node.Name.LocalName.Equals("Namespace", StringComparison.OrdinalIgnoreCase))
        ?.Value;
    var defaultResolution = placeholderReference.Elements()
        .FirstOrDefault(node => node.Name.LocalName.Equals("DefaultResolution", StringComparison.OrdinalIgnoreCase))
        ?.Value;

    foreach (var candidate in candidateNames)
    {
        if (string.Equals(NormalizeReferenceToken(includeValue), candidate, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(NormalizeReferenceToken(namespaceValue), candidate, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(defaultResolution) &&
            defaultResolution.IndexOf(candidate, StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return true;
        }
    }

    return false;
}

static IEnumerable<string> ExpandReferenceCandidates(string? value)
{
    var normalized = NormalizeReferenceToken(value);
    if (string.IsNullOrWhiteSpace(normalized))
    {
        yield break;
    }

    yield return normalized;

    var commaIndex = normalized.IndexOf(',');
    if (commaIndex > 0)
    {
        yield return NormalizeReferenceToken(normalized[..commaIndex]);
    }

    var bracketStart = normalized.IndexOf('[');
    var bracketEnd = normalized.IndexOf(']');
    if (bracketStart >= 0 && bracketEnd > bracketStart)
    {
        yield return NormalizeReferenceToken(normalized[(bracketStart + 1)..bracketEnd]);
    }
}

static string NormalizeReferenceToken(string? value)
{
    if (string.IsNullOrWhiteSpace(value))
    {
        return string.Empty;
    }

    return value.Trim().Trim('"').Trim();
}

static string BuildPlaceholderDefaultResolution(string libraryName, string? version, string? vendor)
{
    var normalizedVersion = string.IsNullOrWhiteSpace(version) ? "*" : version!.Trim();
    var normalizedVendor = vendor?.Trim();
    var vendorSuffix = string.IsNullOrWhiteSpace(normalizedVendor) ? string.Empty : $" ({normalizedVendor})";
    var useBracketedName = !string.IsNullOrWhiteSpace(normalizedVendor) &&
        normalizedVendor.IndexOf("Beckhoff", StringComparison.OrdinalIgnoreCase) < 0;
    var resolutionName = useBracketedName ? $"[{libraryName}]" : libraryName;
    return $"{resolutionName}, {normalizedVersion}{vendorSuffix}";
}

static object? TryLookupTreeItem(object systemManager, string path)
{
    return TryInvokeForResult(systemManager, "LookupTreeItem", path);
}

static object? FindPlcProjectTreeItem(object systemManager, string plcProjectName, List<string> diagnostics)
{
    var directCandidates = new[]
    {
        $"TIPC^{plcProjectName}^{plcProjectName} Project",
        $"TIPC^{plcProjectName} Project",
        $"TIPC^{plcProjectName}"
    };
    foreach (var candidate in directCandidates)
    {
        var item = TryLookupTreeItem(systemManager, candidate);
        if (item is not null)
        {
            diagnostics.Add($"Resolved PLC project tree item via path {candidate}.");
            return item;
        }
    }

    var plcRoot = TryLookupTreeItem(systemManager, "TIPC");
    if (plcRoot is null)
    {
        diagnostics.Add("TwinCAT PLC tree root (TIPC) was not found.");
        return null;
    }

    var desiredNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        plcProjectName,
        $"{plcProjectName} Project"
    };
    return FindTreeItemRecursive(plcRoot, item =>
    {
        var name = TryGetProperty(item, "Name")?.ToString();
        return !string.IsNullOrWhiteSpace(name) && desiredNames.Contains(name);
    });
}

static object? FindPlcReferencesTreeItem(object systemManager, string plcProjectName, List<string> diagnostics)
{
    var directCandidates = new[]
    {
        $"TIPC^{plcProjectName}^{plcProjectName} Project^References",
        $"TIPC^{plcProjectName} Project^References",
        $"TIPC^{plcProjectName}^References"
    };
    foreach (var candidate in directCandidates)
    {
        var item = TryLookupTreeItem(systemManager, candidate);
        if (item is not null)
        {
            diagnostics.Add($"Resolved PLC references tree item via path {candidate}.");
            return item;
        }
    }

    var plcProject = FindPlcProjectTreeItem(systemManager, plcProjectName, diagnostics);
    if (plcProject is null)
    {
        return null;
    }

    return FindTreeItemRecursive(plcProject, item =>
        string.Equals(TryGetProperty(item, "Name")?.ToString(), "References", StringComparison.OrdinalIgnoreCase));
}

static object? FindTreeItemRecursive(object treeItem, Func<object, bool> predicate)
{
    if (predicate(treeItem))
    {
        return treeItem;
    }

    foreach (var child in EnumerateTreeChildren(treeItem))
    {
        var match = FindTreeItemRecursive(child, predicate);
        if (match is not null)
        {
            return match;
        }
    }

    return null;
}

static IEnumerable<object> EnumerateTreeChildren(object treeItem)
{
    var childCountValue = TryGetProperty(treeItem, "ChildCount");
    if (childCountValue is null)
    {
        yield break;
    }

    var childCount = Convert.ToInt32(childCountValue);
    for (var index = 1; index <= childCount; index++)
    {
        var child = TryInvokeForResult(treeItem, "Child", index) ?? TryInvokeForResult(treeItem, "Item", index);
        if (child is not null)
        {
            yield return child;
        }
    }

    if (childCount == 0)
    {
        yield break;
    }

    // Some versions expose zero-based child accessors.
    for (var index = 0; index < childCount; index++)
    {
        var child = TryInvokeForResult(treeItem, "Child", index) ?? TryInvokeForResult(treeItem, "Item", index);
        if (child is not null)
        {
            yield return child;
        }
    }
}

static IReadOnlyList<string> ReadStringArray(JsonNode? node)
{
    if (node is not JsonArray arr) return Array.Empty<string>();
    var result = new List<string>();
    foreach (var item in arr)
    {
        var value = item?.GetValue<string>()?.Trim();
        if (!string.IsNullOrWhiteSpace(value))
        {
            result.Add(value);
        }
    }
    return result;
}

static IReadOnlyList<LibraryRef> ScanLibrariesFromFolders(string projectPath, List<string> diagnostics)
{
    var result = new List<LibraryRef>();
    var files = Directory.EnumerateFiles(projectPath, "*", SearchOption.AllDirectories)
        .Where(path =>
        {
            var lower = path.ToLowerInvariant();
            return lower.Contains($"{Path.DirectorySeparatorChar}_libraries{Path.DirectorySeparatorChar}") &&
                   (lower.EndsWith(".library") || lower.Contains(".compiled-library"));
        });

    foreach (var file in files)
    {
        result.Add(ParseLibraryPath(file));
    }

    return result;
}

static IReadOnlyList<LibraryRef> ScanLibrariesFromPlcProjReferences(string projectPath, List<string> diagnostics)
{
    var result = new List<LibraryRef>();
    var plcprojFiles = Directory.EnumerateFiles(projectPath, "*.plcproj", SearchOption.AllDirectories).ToArray();
    if (plcprojFiles.Length == 0)
    {
        return result;
    }

    foreach (var plcproj in plcprojFiles)
    {
        try
        {
            var doc = XDocument.Load(plcproj, LoadOptions.PreserveWhitespace);
            var placeholderRefs = doc.Descendants()
                .Where(e => e.Name.LocalName.Equals("PlaceholderReference", StringComparison.OrdinalIgnoreCase));
            foreach (var placeholder in placeholderRefs)
            {
                var include = (placeholder.Attribute("Include")?.Value ?? string.Empty).Trim();
                var defaultResolution = (placeholder.Elements().FirstOrDefault(e => e.Name.LocalName.Equals("DefaultResolution", StringComparison.OrdinalIgnoreCase))?.Value ?? string.Empty).Trim();
                var namespaceValue = (placeholder.Elements().FirstOrDefault(e => e.Name.LocalName.Equals("Namespace", StringComparison.OrdinalIgnoreCase))?.Value ?? string.Empty).Trim();

                var parsed = ParseLibraryReferenceValues(include, defaultResolution, namespaceValue, plcproj);
                if (parsed is not null)
                {
                    result.Add(parsed);
                }
            }

            var libraryRefs = doc.Descendants()
                .Where(e => e.Name.LocalName.Equals("LibraryReference", StringComparison.OrdinalIgnoreCase));
            foreach (var libraryRef in libraryRefs)
            {
                var include = (libraryRef.Attribute("Include")?.Value ?? string.Empty).Trim();
                var parsed = ParseLibraryReferenceValues(include, include, string.Empty, plcproj);
                if (parsed is not null)
                {
                    result.Add(parsed);
                }
            }
        }
        catch (Exception ex)
        {
            diagnostics.Add($"plcproj scan failed for {Path.GetFileName(plcproj)}: {ex.Message}");
        }
    }

    if (result.Count > 0)
    {
        diagnostics.Add($"plcproj references detected: {result.Count}");
    }
    return result;
}

static LibraryRef? ParseLibraryReferenceValues(string include, string defaultResolution, string namespaceValue, string plcprojPath)
{
    var name = !string.IsNullOrWhiteSpace(include)
        ? include
        : (!string.IsNullOrWhiteSpace(namespaceValue) ? namespaceValue : string.Empty);

    if (string.IsNullOrWhiteSpace(name))
    {
        return null;
    }

    var version = "unknown";
    var vendor = "Unknown vendor";

    // Common shape examples:
    // Tc2_Standard, * (Beckhoff Automation GmbH)
    // Tc2_Standard, 3.4.5.0 (Beckhoff Automation GmbH)
    // FO_TcBaseUtilities, 1.0
    var nameVersion = Regex.Match(defaultResolution, @"^(?<name>[A-Za-z0-9_\.]+)\s*,\s*(?<ver>\*|[0-9]+(?:\.[0-9]+){0,3})");
    if (nameVersion.Success)
    {
        name = nameVersion.Groups["name"].Value;
        var parsedVersion = nameVersion.Groups["ver"].Value;
        version = parsedVersion == "*" ? "latest" : parsedVersion;
        var vendorMatch = Regex.Match(defaultResolution, @"\((?<vendor>[^)]+)\)");
        if (vendorMatch.Success)
        {
            vendor = vendorMatch.Groups["vendor"].Value;
        }
    }

    // Filter obvious non-library values.
    var lower = name.Trim().ToLowerInvariant();
    if (lower is "true" or "false")
    {
        return null;
    }

    if (!Regex.IsMatch(name, @"^[A-Za-z_][A-Za-z0-9_\.]+$"))
    {
        return null;
    }

    return new LibraryRef(
        Name: name,
        Version: version,
        Vendor: vendor,
        Path: plcprojPath,
        Mode: "metadata_only"
    );
}

static LibraryRef ParseLibraryPath(string filePath)
{
    var normalized = filePath.Replace('/', Path.DirectorySeparatorChar);
    var parts = normalized.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
    var idx = Array.FindIndex(parts, p => p.Equals("_Libraries", StringComparison.OrdinalIgnoreCase));
    var vendor = idx >= 0 && parts.Length > idx + 1 ? parts[idx + 1] : "Unknown vendor";

    var fileName = Path.GetFileName(filePath);
    var fileStem = Regex.Replace(fileName, @"(\.compiled-library.*|\.library)$", "", RegexOptions.IgnoreCase);
    var version = "unknown";
    var name = fileStem;

    if (idx >= 0 && parts.Length > idx + 2)
    {
        name = Regex.Replace(parts[idx + 2], @"(\.compiled-library.*|\.library)$", "", RegexOptions.IgnoreCase);
        if (string.IsNullOrWhiteSpace(name))
        {
            name = fileStem;
        }
    }
    if (idx >= 0 && parts.Length > idx + 3)
    {
        version = parts[idx + 3];
    }

    return new LibraryRef(
        Name: name,
        Version: version,
        Vendor: vendor,
        Path: filePath,
        Mode: "metadata_only"
    );
}

static IReadOnlyList<BackendSymbol> BuildMetadataSymbols(IEnumerable<LibraryRef> libraries)
{
    return libraries
        .Select(lib => new BackendSymbol(
            Id: $"{lib.Name}:{lib.Version}",
            Name: lib.Name,
            Kind: "type",
            Signature: $"LIBRARY {lib.Name} {lib.Version}",
            Documentation: $"{lib.Vendor} ({lib.Mode})",
            Origin: "library_meta",
            Library: lib.Name,
            Version: lib.Version,
            Confidence: "medium"
        ))
        .ToList();
}

static IReadOnlyList<BackendSymbol> BuildLibrarySourceSymbols(
    IReadOnlyList<LibraryRef> libraries,
    IReadOnlyList<string> librarySourceRoots,
    List<string> diagnostics)
{
    if (librarySourceRoots.Count == 0)
    {
        diagnostics.Add("No library source roots configured. Returning metadata-only library symbols.");
        return Array.Empty<BackendSymbol>();
    }

    var symbols = new List<BackendSymbol>();
    var uniqueLibraries = libraries
        .GroupBy(l => l.Name, StringComparer.OrdinalIgnoreCase)
        .Select(g => g.First())
        .ToList();

    foreach (var lib in uniqueLibraries)
    {
        if (IsMetadataPreferredLibrary(lib.Name))
        {
            diagnostics.Add($"Library source skipped for metadata-preferred library: {lib.Name}");
            continue;
        }

        var sourceDirs = ResolveLibrarySourceDirectories(lib.Name, librarySourceRoots).ToArray();
        if (sourceDirs.Length == 0)
        {
            continue;
        }

        diagnostics.Add($"Library source resolved: {lib.Name} -> {sourceDirs[0]}");
        foreach (var sourceDir in sourceDirs)
        {
            foreach (var symbol in ExtractLibrarySymbolsFromDirectory(lib.Name, lib.Version, sourceDir))
            {
                symbols.Add(symbol);
            }
        }
    }

    return symbols
        .DistinctBy(s => $"{s.Library}|{s.Name}|{s.Kind}|{s.Origin}".ToUpperInvariant())
        .ToList();
}

static bool IsMetadataPreferredLibrary(string libraryName)
{
    return libraryName.Equals("Tc2_Standard", StringComparison.OrdinalIgnoreCase) ||
           libraryName.Equals("Tc2_System", StringComparison.OrdinalIgnoreCase) ||
           libraryName.Equals("Tc3_Module", StringComparison.OrdinalIgnoreCase);
}

static IReadOnlyList<BackendSymbol> BuildManagedLibraryBrowserCacheSymbols(
    IReadOnlyList<LibraryRef> libraries,
    List<string> diagnostics)
{
    var managedLibRoots = new[]
    {
        @"C:\ProgramData\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries",
        @"C:\ProgramData\Beckhoff\TwinCAT\3.1\Components\Plc\Managed Libraries"
    }.Where(Directory.Exists).ToArray();

    if (managedLibRoots.Length == 0)
    {
        return Array.Empty<BackendSymbol>();
    }

    var symbols = new List<BackendSymbol>();
    var uniqueLibraries = libraries
        .GroupBy(l => l.Name, StringComparer.OrdinalIgnoreCase)
        .Select(g => g.First())
        .ToList();

    foreach (var lib in uniqueLibraries)
    {
        var cachePaths = ResolveManagedLibraryBrowserCachePaths(lib, managedLibRoots).ToArray();
        if (cachePaths.Length == 0)
        {
            continue;
        }

        diagnostics.Add($"Library browsercache resolved: {lib.Name} -> {cachePaths[0]}");
        foreach (var cachePath in cachePaths)
        {
            foreach (var symbol in ExtractSymbolsFromBrowserCache(lib.Name, lib.Version, cachePath))
            {
                symbols.Add(symbol);
            }
        }
    }

    if (symbols.Count > 0)
    {
        diagnostics.Add($"Library browsercache symbols loaded: {symbols.Count}");
    }

    return symbols
        .DistinctBy(s => $"{s.Library}|{s.Name}|{s.Kind}|{s.Origin}".ToUpperInvariant())
        .ToList();
}

static IEnumerable<string> ResolveManagedLibraryBrowserCachePaths(LibraryRef lib, IReadOnlyList<string> roots)
{
    var versions = new List<string>();
    if (!string.IsNullOrWhiteSpace(lib.Version) &&
        !lib.Version.Equals("latest", StringComparison.OrdinalIgnoreCase) &&
        !lib.Version.Equals("unknown", StringComparison.OrdinalIgnoreCase))
    {
        versions.Add(lib.Version);
    }
    versions.Add("1.0");

    var libraryName = lib.Name;
    var vendor = lib.Vendor;

    foreach (var root in roots)
    {
        foreach (var version in versions.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!string.IsNullOrWhiteSpace(vendor) && !vendor.Equals("Unknown vendor", StringComparison.OrdinalIgnoreCase))
            {
                var vendorCandidate = Path.Combine(root, vendor, libraryName, version, "browsercache");
                if (File.Exists(vendorCandidate))
                {
                    yield return vendorCandidate;
                }
            }

            var anyVendorPattern = Path.Combine(root, "*", libraryName, version, "browsercache");
            foreach (var candidate in GlobFiles(anyVendorPattern))
            {
                yield return candidate;
            }
        }

        var fallbackPattern = Path.Combine(root, "*", libraryName, "*", "browsercache");
        foreach (var candidate in GlobFiles(fallbackPattern))
        {
            yield return candidate;
        }
    }
}

static IEnumerable<string> GlobFiles(string pattern)
{
    var dir = Path.GetDirectoryName(pattern);
    var file = Path.GetFileName(pattern);
    if (string.IsNullOrWhiteSpace(dir) || string.IsNullOrWhiteSpace(file) || !Directory.Exists(dir))
    {
        yield break;
    }

    foreach (var path in Directory.EnumerateFiles(dir, file, SearchOption.TopDirectoryOnly))
    {
        yield return path;
    }
}

static IReadOnlyList<BackendSymbol> ExtractSymbolsFromBrowserCache(string library, string version, string browserCachePath)
{
    var results = new List<BackendSymbol>();
    XDocument doc;
    try
    {
        doc = XDocument.Load(browserCachePath, LoadOptions.PreserveWhitespace);
    }
    catch
    {
        return results;
    }

    var topNodes = doc.Root?.Elements().Where(e => e.Name.LocalName.Equals("Node", StringComparison.OrdinalIgnoreCase))
        ?? Enumerable.Empty<XElement>();
    foreach (var node in topNodes)
    {
        var name = node.Attribute("Name")?.Value?.Trim();
        if (string.IsNullOrWhiteSpace(name)) continue;
        if (!Regex.IsMatch(name, @"^[A-Za-z_]\w*$")) continue;
        if (name.Equals("Library Manager", StringComparison.OrdinalIgnoreCase)) continue;

        var kind = InferKindFromName(name);
        var comment = node.Attribute("Comment")?.Value?.Trim();
        results.Add(new BackendSymbol(
            Id: $"browsercache:{library}:{name}:{kind}",
            Name: name,
            Kind: kind,
            Signature: $"{kind.ToUpperInvariant()} {name}",
            Documentation: string.IsNullOrWhiteSpace(comment) ? $"Resolved from browsercache: {browserCachePath}" : comment,
            Origin: "library_public",
            Library: library,
            Version: version,
            Confidence: "high"
        ));
    }

    return results;
}

static IReadOnlyList<BackendSymbol> BuildAutomationInterfaceSymbols(IReadOnlyList<LibraryRef> libraries, List<string> diagnostics)
{
    _ = libraries;
    _ = diagnostics;
    // Placeholder for future COM object traversal.
    return Array.Empty<BackendSymbol>();
}

static IReadOnlyList<BackendSymbol> BuildTmcSymbols(
    IReadOnlyList<LibraryRef> libraries,
    string projectPath,
    IReadOnlyList<string> tmcRoots,
    List<string> diagnostics,
    bool autoBuildTmcIfMissing)
{
    var roots = new List<string>();
    if (!string.IsNullOrWhiteSpace(projectPath))
    {
        roots.Add(projectPath);
    }
    roots.AddRange(tmcRoots.Where(Directory.Exists));
    roots.AddRange(GetDefaultTmcRoots().Where(Directory.Exists));

    var tmcFiles = roots
        .Where(Directory.Exists)
        .SelectMany(root => Directory.EnumerateFiles(root, "*.tmc", SearchOption.AllDirectories))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    if (tmcFiles.Length == 0 && autoBuildTmcIfMissing)
    {
        var built = TryBuildProjectForTmc(projectPath, diagnostics);
        if (built)
        {
            tmcFiles = roots
                .Where(Directory.Exists)
                .SelectMany(root => Directory.EnumerateFiles(root, "*.tmc", SearchOption.AllDirectories))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
    }

    if (tmcFiles.Length == 0)
    {
        return Array.Empty<BackendSymbol>();
    }

    var symbols = new List<BackendSymbol>();
    var libLookup = libraries
        .GroupBy(l => l.Name, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

    foreach (var tmc in tmcFiles)
    {
        try
        {
            var doc = XDocument.Load(tmc, LoadOptions.PreserveWhitespace);
            var stem = Path.GetFileNameWithoutExtension(tmc);
            var matchedLib = FindBestLibraryForTmc(stem, libLookup);
            var fallbackLibName = matchedLib?.Name ?? stem;
            var fallbackLibVersion = matchedLib?.Version ?? "unknown";

            var nodeCandidates = doc.Descendants().Where(e =>
                e.Name.LocalName.Contains("DataType", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Dut", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("FunctionBlock", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Pous", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Pou", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Interface", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Symbol", StringComparison.OrdinalIgnoreCase) ||
                e.Name.LocalName.Contains("Variable", StringComparison.OrdinalIgnoreCase));

            foreach (var node in nodeCandidates)
            {
                var name = ExtractNodeName(node);
                if (string.IsNullOrWhiteSpace(name)) continue;
                var kind = InferKindFromNode(node.Name.LocalName);
                var libraryHint = ExtractLibraryHintFromNode(node);
                var resolvedLib = ResolveLibraryFromHint(libraryHint, libLookup);
                var libName = resolvedLib?.Name ?? fallbackLibName;
                var libVersion = resolvedLib?.Version ?? fallbackLibVersion;

                symbols.Add(new BackendSymbol(
                    Id: $"tmc:{libName}:{name}:{kind}",
                    Name: name,
                    Kind: kind,
                    Signature: $"{kind.ToUpperInvariant()} {name}",
                    Documentation: $"Resolved from TMC: {tmc}",
                    Origin: "tmc",
                    Library: libName,
                    Version: libVersion,
                    Confidence: "high"
                ));
            }
        }
        catch (Exception ex)
        {
            diagnostics.Add($"TMC parse failed for {Path.GetFileName(tmc)}: {ex.Message}");
        }
    }

    if (symbols.Count > 0)
    {
        diagnostics.Add($"TMC symbols loaded: {symbols.Count}");
    }

    return symbols
        .DistinctBy(s => $"{s.Library}|{s.Name}|{s.Kind}|{s.Origin}".ToUpperInvariant())
        .ToList();
}

static string? ExtractLibraryHintFromNode(XElement node)
{
    var ns = node.Attribute("Namespace")?.Value?.Trim();
    if (!string.IsNullOrWhiteSpace(ns)) return NormalizeLibraryHint(ns);

    var nameElement = node.Elements().FirstOrDefault(e => e.Name.LocalName.Equals("Name", StringComparison.OrdinalIgnoreCase));
    var nameNs = nameElement?.Attribute("Namespace")?.Value?.Trim();
    if (!string.IsNullOrWhiteSpace(nameNs)) return NormalizeLibraryHint(nameNs);

    var baseTypeElement = node.Elements().FirstOrDefault(e => e.Name.LocalName.Equals("BaseType", StringComparison.OrdinalIgnoreCase));
    var baseNs = baseTypeElement?.Attribute("Namespace")?.Value?.Trim();
    if (!string.IsNullOrWhiteSpace(baseNs)) return NormalizeLibraryHint(baseNs);

    var typeElement = node.Elements().FirstOrDefault(e => e.Name.LocalName.Equals("Type", StringComparison.OrdinalIgnoreCase));
    var typeNs = typeElement?.Attribute("Namespace")?.Value?.Trim();
    if (!string.IsNullOrWhiteSpace(typeNs)) return NormalizeLibraryHint(typeNs);

    return null;
}

static string NormalizeLibraryHint(string value)
{
    var clean = value.Trim();
    if (clean.Contains('.'))
    {
        // e.g. FO_TcBaseUtilities.Tc2_Utilities -> FO_TcBaseUtilities
        clean = clean.Split('.', StringSplitOptions.RemoveEmptyEntries)[0];
    }
    return clean;
}

static LibraryRef? ResolveLibraryFromHint(string? hint, Dictionary<string, LibraryRef> libLookup)
{
    if (string.IsNullOrWhiteSpace(hint))
    {
        return null;
    }

    if (libLookup.TryGetValue(hint, out var exact))
    {
        return exact;
    }

    foreach (var kvp in libLookup)
    {
        if (kvp.Key.Equals(hint, StringComparison.OrdinalIgnoreCase)) return kvp.Value;
        if (hint.IndexOf(kvp.Key, StringComparison.OrdinalIgnoreCase) >= 0) return kvp.Value;
        if (kvp.Key.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) return kvp.Value;
    }

    return null;
}

static IReadOnlyList<string> GetDefaultTmcRoots()
{
    var defaults = new[]
    {
        @"C:\ProgramData\Beckhoff\TwinCAT\3.1\Repository",
        @"C:\ProgramData\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries",
        @"C:\Program Files (x86)\Beckhoff\TwinCAT\3.1\Components"
    };
    return defaults.Where(Directory.Exists).ToArray();
}

static bool TryBuildProjectForTmc(string projectPath, List<string> diagnostics)
{
    if (string.IsNullOrWhiteSpace(projectPath) || !Directory.Exists(projectPath))
    {
        return false;
    }

    var tsproj = Directory.EnumerateFiles(projectPath, "*.tsproj", SearchOption.AllDirectories).FirstOrDefault();
    if (string.IsNullOrWhiteSpace(tsproj))
    {
        diagnostics.Add("TMC auto-build skipped: no .tsproj found.");
        return false;
    }

    var progId = ResolveAutomationProgId();
    var progIdType = progId is not null ? Type.GetTypeFromProgID(progId) : null;
    if (progIdType is null)
    {
        diagnostics.Add("TMC auto-build skipped: Automation Interface ProgID unavailable.");
        return false;
    }

    var finished = new ManualResetEventSlim(false);
    var success = false;
    Exception? threadError = null;

    var thread = new Thread(() =>
    {
        try
        {
            var sysManager = CreateAutomationInterfaceInstance(progId, progIdType, diagnostics);
            if (sysManager is null) return;

            if (!TryInvoke(sysManager, "OpenConfiguration", tsproj) &&
                !TryInvoke(sysManager, "OpenProject", tsproj) &&
                !TryInvoke(sysManager, "Open", tsproj))
            {
                return;
            }

            var attempted =
                TryInvoke(sysManager, "Build") ||
                TryInvoke(sysManager, "BuildProject") ||
                TryInvoke(sysManager, "Compile") ||
                TryInvoke(sysManager, "GenerateCode");

            if (attempted)
            {
                success = true;
                diagnostics.Add("TMC auto-build attempted through Automation Interface.");
            }

            TryInvoke(sysManager, "SaveConfiguration");
            TryInvoke(sysManager, "CloseConfiguration");
        }
        catch (Exception ex)
        {
            threadError = ex;
        }
        finally
        {
            finished.Set();
        }
    });

    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();

    if (!finished.Wait(TimeSpan.FromSeconds(30)))
    {
        diagnostics.Add("TMC auto-build timed out after 30 seconds.");
        return false;
    }

    if (threadError is not null)
    {
        diagnostics.Add($"TMC auto-build failed: {threadError.Message}");
        return false;
    }

    return success;
}

static LibraryRef? FindBestLibraryForTmc(string tmcStem, Dictionary<string, LibraryRef> libLookup)
{
    if (libLookup.TryGetValue(tmcStem, out var exact))
    {
        return exact;
    }

    foreach (var kvp in libLookup)
    {
        if (tmcStem.IndexOf(kvp.Key, StringComparison.OrdinalIgnoreCase) >= 0 ||
            kvp.Key.IndexOf(tmcStem, StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return kvp.Value;
        }
    }
    return null;
}

static string InferKindFromNode(string localName)
{
    if (localName.Contains("Function", StringComparison.OrdinalIgnoreCase)) return "function";
    if (localName.Contains("Block", StringComparison.OrdinalIgnoreCase)) return "function_block";
    if (localName.Contains("Variable", StringComparison.OrdinalIgnoreCase) || localName.Contains("Symbol", StringComparison.OrdinalIgnoreCase)) return "variable";
    return "type";
}

static string InferKindFromName(string name)
{
    if (name.StartsWith("FB_", StringComparison.OrdinalIgnoreCase)) return "function_block";
    if (name.StartsWith("FN_", StringComparison.OrdinalIgnoreCase) || name.StartsWith("F_", StringComparison.OrdinalIgnoreCase)) return "function";
    if (name.StartsWith("GVL_", StringComparison.OrdinalIgnoreCase)) return "variable";
    return "type";
}

static string? ExtractNodeName(XElement node)
{
    var attrs = new[] { "Name", "name", "Identifier", "identifier", "TypeName", "typeName" };
    foreach (var attr in attrs)
    {
        var val = node.Attribute(attr)?.Value?.Trim();
        if (!string.IsNullOrWhiteSpace(val) && Regex.IsMatch(val, @"^[A-Za-z_]\w*$"))
        {
            return val;
        }
    }

    foreach (var childName in attrs)
    {
        var child = node.Elements().FirstOrDefault(e => e.Name.LocalName.Equals(childName, StringComparison.OrdinalIgnoreCase));
        var val = child?.Value?.Trim();
        if (!string.IsNullOrWhiteSpace(val) && Regex.IsMatch(val, @"^[A-Za-z_]\w*$"))
        {
            return val;
        }
    }

    return null;
}

static IReadOnlyList<BackendSymbol> MergeLibrarySymbolsByPrecedence(
    IReadOnlyList<BackendSymbol> metadataSymbols,
    IReadOnlyList<BackendSymbol> browserCacheSymbols,
    IReadOnlyList<BackendSymbol> sourceSymbols,
    IReadOnlyList<BackendSymbol> tmcSymbols,
    IReadOnlyList<BackendSymbol> aiSymbols)
{
    var byKey = new Dictionary<string, BackendSymbol>(StringComparer.OrdinalIgnoreCase);

    foreach (var symbol in metadataSymbols)
    {
        var key = $"{symbol.Library}|{symbol.Name}|{symbol.Kind}";
        byKey[key] = symbol;
    }

    foreach (var symbol in browserCacheSymbols)
    {
        var key = $"{symbol.Library}|{symbol.Name}|{symbol.Kind}";
        byKey[key] = symbol;
    }

    foreach (var symbol in sourceSymbols)
    {
        var key = $"{symbol.Library}|{symbol.Name}|{symbol.Kind}";
        byKey[key] = symbol;
    }
    foreach (var symbol in tmcSymbols)
    {
        var key = $"{symbol.Library}|{symbol.Name}|{symbol.Kind}";
        byKey[key] = symbol;
    }
    foreach (var symbol in aiSymbols)
    {
        var key = $"{symbol.Library}|{symbol.Name}|{symbol.Kind}";
        byKey[key] = symbol;
    }

    return byKey.Values.ToList();
}

static IEnumerable<string> ResolveLibrarySourceDirectories(string libraryName, IReadOnlyList<string> roots)
{
    var normalizedName = libraryName.Trim();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (var root in roots)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            continue;
        }

        var direct = Path.Combine(root, normalizedName);
        if (Directory.Exists(direct) && seen.Add(direct))
        {
            yield return direct;
        }

        var plcprojCandidates = Directory.EnumerateFiles(root, $"{normalizedName}.plcproj", SearchOption.AllDirectories);
        foreach (var plcproj in plcprojCandidates)
        {
            var dir = Path.GetDirectoryName(plcproj);
            if (!string.IsNullOrWhiteSpace(dir) && seen.Add(dir))
            {
                yield return dir;
            }
        }

        var dirCandidates = Directory.EnumerateDirectories(root, normalizedName, SearchOption.AllDirectories);
        foreach (var dir in dirCandidates)
        {
            if (seen.Add(dir))
            {
                yield return dir;
            }
        }
    }
}

static IEnumerable<BackendSymbol> ExtractLibrarySymbolsFromDirectory(string libraryName, string libraryVersion, string sourceDir)
{
    var supportedExts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ".tcpou", ".tcprg", ".tcapp", ".tccom", ".tcdut", ".tcgvl", ".tcitf", ".tcvar"
    };

    var files = Directory.EnumerateFiles(sourceDir, "*.*", SearchOption.AllDirectories)
        .Where(file => supportedExts.Contains(Path.GetExtension(file)));

    foreach (var file in files)
    {
        var ext = Path.GetExtension(file).ToLowerInvariant();
        var content = string.Empty;
        try
        {
            content = File.ReadAllText(file);
        }
        catch
        {
            // Ignore unreadable files.
        }

        foreach (var symbol in ExtractSymbolsFromFile(libraryName, libraryVersion, file, ext, content))
        {
            yield return symbol;
        }
    }
}

static IEnumerable<BackendSymbol> ExtractSymbolsFromFile(
    string libraryName,
    string libraryVersion,
    string filePath,
    string ext,
    string content)
{
    var fileStem = Path.GetFileNameWithoutExtension(filePath);
    string? declarationName = null;
    string kind = "type";
    string signature;

    switch (ext)
    {
        case ".tcpou":
        case ".tcprg":
        case ".tcapp":
        case ".tccom":
            declarationName = MatchDeclarationName(content, @"\b(FUNCTION_BLOCK|FUNCTION|PROGRAM)\s+([A-Za-z_]\w*)");
            if (content.IndexOf("FUNCTION ", StringComparison.OrdinalIgnoreCase) >= 0) kind = "function";
            else kind = "function_block";
            break;
        case ".tcdut":
        case ".tcitf":
            declarationName = MatchDeclarationName(content, @"\b(TYPE|INTERFACE)\s+([A-Za-z_]\w*)");
            kind = "type";
            break;
        case ".tcgvl":
        case ".tcvar":
            declarationName = MatchDeclarationName(content, @"\b(GLOBAL\s+VARIABLE\s+LIST|GVL)\s*:?\s*([A-Za-z_]\w*)");
            kind = "variable";
            break;
    }

    var name = string.IsNullOrWhiteSpace(declarationName) ? fileStem : declarationName!;
    signature = $"{kind.ToUpperInvariant()} {name}";

    yield return new BackendSymbol(
        Id: $"{libraryName}:{name}:{ext}",
        Name: name,
        Kind: kind,
        Signature: signature,
        Documentation: $"Resolved from source root: {filePath}",
        Origin: "source",
        Library: libraryName,
        Version: libraryVersion,
        Confidence: "high"
    );
}

static string? MatchDeclarationName(string content, string pattern)
{
    if (string.IsNullOrWhiteSpace(content))
    {
        return null;
    }

    var match = Regex.Match(content, pattern, RegexOptions.IgnoreCase);
    if (!match.Success || match.Groups.Count < 3)
    {
        return null;
    }

    var value = match.Groups[2].Value.Trim();
    return string.IsNullOrWhiteSpace(value) ? null : value;
}

internal sealed record LibraryRef(
    string Name,
    string Version,
    string Vendor,
    string Path,
    string Mode
);

internal sealed record BackendSymbol(
    string Id,
    string Name,
    string Kind,
    string Signature,
    string Documentation,
    string Origin,
    string Library,
    string Version,
    string Confidence
);

internal sealed record ScanResult(
    IReadOnlyList<LibraryRef> Libraries,
    IReadOnlyList<BackendSymbol> Symbols,
    IReadOnlyList<BackendSymbol> LibrarySymbols,
    IReadOnlyList<string> Diagnostics
);

internal sealed record AutomationOperationResult(
    bool Success,
    string? InstalledLibraryPath,
    IReadOnlyList<string> Diagnostics
);
