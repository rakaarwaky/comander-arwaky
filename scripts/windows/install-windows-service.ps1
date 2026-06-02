#!/usr/bin/env powershell
# DesktopCommanderMCP Windows Service Installation Script
#
# This script installs and configures Windows Scheduled Tasks for DesktopCommanderMCP,
# allowing it to run silently in the background at logon.
# Supports both HTTP (recommended) and Unix Socket modes.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-windows-service.ps1 [-Mode Http|Socket] [-Port 8080] [-SocketPath C:\tmp\dc.sock]
#   powershell -ExecutionPolicy Bypass -File install-windows-service.ps1 -Uninstall

param(
    [ValidateSet("Http", "Socket")]
    [string]$Mode = "Http",

    [int]$Port = 8080,

    [string]$SocketPath = "C:\tmp\dc.sock",

    [switch]$Uninstall,

    [switch]$Help
)

# Colors and output functions
function Write-Success { param($Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Warning { param($Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }

function Write-Header {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Blue
    Write-Host "                     DESKTOP COMMANDER MCP                      " -ForegroundColor Blue
    Write-Host "                   Windows Service Installer                    " -ForegroundColor Blue
    Write-Host "================================================================" -ForegroundColor Blue
    Write-Host ""
}

# Show help if requested
if ($Help) {
    Write-Header
    Write-Host "Usage:"
    Write-Host "  .\install-windows-service.ps1 [-Mode Http|Socket] [-Port <port>] [-SocketPath <path>]"
    Write-Host "  .\install-windows-service.ps1 -Uninstall"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Mode <Http|Socket>     Service execution mode (default: Http)"
    Write-Host "  -Port <number>          Port to listen on in HTTP mode (default: 8080)"
    Write-Host "  -SocketPath <path>      Path to Unix socket file in Socket mode (default: C:\tmp\dc.sock)"
    Write-Host "  -Uninstall              Stop and completely remove the installed service"
    Write-Host "  -Help                   Show this help message"
    Write-Host ""
    exit 0
}

Write-Header

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator (Run PowerShell as Administrator)"
    Write-Host ""
    exit 1
}

# Resolve paths
$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) {
    $ScriptDir = Get-Location
}
$DcDir = Resolve-Path (Join-Path $ScriptDir "..\..")
$VbsLauncherPath = Join-Path $ScriptDir "run-desktop-commander.vbs"
$TaskName = "DesktopCommanderMCP"

# Uninstall procedure
if ($Uninstall) {
    Write-Info "Uninstalling DesktopCommanderMCP Windows background task..."
    
    $taskExists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($taskExists) {
        Write-Info "Stopping scheduled task..."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        
        Write-Info "Unregistering scheduled task..."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Success "Scheduled task unregistered successfully."
    } else {
        Write-Warning "No registered scheduled task '$TaskName' found."
    }
    
    if (Test-Path $VbsLauncherPath) {
        Remove-Item $VbsLauncherPath -Force
        Write-Success "Removed launcher script: $VbsLauncherPath"
    }

    # Clean up socket file if in Socket mode
    if ($Mode -eq "Socket" -and (Test-Path $SocketPath)) {
        Remove-Item $SocketPath -Force
        Write-Info "Removed socket file: $SocketPath"
    }
    
    Write-Success "DesktopCommanderMCP uninstalled successfully."
    exit 0
}

# Check Node.js installation
try {
    $nodeVersion = node -v 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($nodeVersion)) {
        throw "Node.js not in path"
    }
    Write-Success "Node.js is installed: $nodeVersion"
} catch {
    Write-Error "Node.js is not installed or not found in system PATH."
    Write-Info "Please install Node.js (version 18 or higher) from https://nodejs.org/"
    exit 1
}

# Check if project is built
$indexPath = Join-Path $DcDir "dist\index.js"
if (-not (Test-Path $indexPath)) {
    Write-Warning "DesktopCommander MCP is not built yet. Building..."
    Push-Location $DcDir
    try {
        Write-Info "Running npm install..."
        npm install
        Write-Info "Running npm run build..."
        npm run build
        Write-Success "Build complete."
    } catch {
        Write-Error "Failed to build DesktopCommander MCP."
        Pop-Location
        exit 1
    }
    Pop-Location
}

# Create socket directory if in Socket mode
if ($Mode -eq "Socket") {
    $socketDir = Split-Path $SocketPath -Parent
    if (-not (Test-Path $socketDir)) {
        Write-Info "Creating socket directory: $socketDir"
        New-Item -ItemType Directory -Path $socketDir -Force | Out-Null
    }
}

# Remove any existing task first to ensure clean updates
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Info "Updating existing service configuration. Stopping and removing older task..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Generate VBS launcher script to run node process silently (without popup console)
Write-Info "Generating VBScript launcher..."
$nodePath = (Get-Command node).Source

$argsString = ""
if ($Mode -eq "Http") {
    $argsString = "--port $Port"
} else {
    $argsString = "--socket-mode --socket-path=""""$SocketPath"""" "
}

$vbsContent = @"
' Automatically generated by DesktopCommanderMCP Windows Service Installer
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$nodePath"" ""$indexPath"" $argsString", 0, false
"@

[System.IO.File]::WriteAllText($VbsLauncherPath, $vbsContent, [System.Text.Encoding]::ASCII)
Write-Success "Generated VBS launcher script at: $VbsLauncherPath"

# Register Windows Scheduled Task
Write-Info "Registering Windows Scheduled Task..."
$currentPrincipal = "$env:USERDOMAIN\$env:USERNAME"

# Set up Scheduled Task Actions
$wscriptPath = "C:\Windows\System32\wscript.exe"
$actionArgs = "//B //Nologo ""$VbsLauncherPath"""
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $actionArgs -WorkingDirectory $DcDir.Path

# Set up Scheduled Task Trigger: Run at Logon
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Set up Settings: Allow running on battery power, never time out
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0 -Hours 0 -Minutes 0)

# Set up Principal: Run under current user with interactive logon
$principal = New-ScheduledTaskPrincipal -UserId $currentPrincipal -LogonType Interactive

# Register the Scheduled Task
try {
    $null = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    Write-Success "Windows Scheduled Task '$TaskName' registered successfully."
} catch {
    Write-Error "Failed to register Windows Scheduled Task: $_"
    exit 1
}

# Start the task
Write-Info "Starting service..."
Start-ScheduledTask -TaskName $TaskName

Write-Info "Waiting 3 seconds for service to initialize..."
Start-Sleep -Seconds 3

# Verify service status
if ($Mode -eq "Http") {
    Write-Info "Testing HTTP endpoint on port $Port..."
    $connectionTest = Test-NetConnection -Port $Port -ComputerName 127.0.0.1 -WarningAction SilentlyContinue
    if ($connectionTest.TcpTestSucceeded) {
        Write-Success "✓ DesktopCommanderMCP HTTP service is active and listening on port $Port!"
    } else {
        Write-Warning "⚠ Service started but port $Port is not responding yet. It might take a moment to initialize completely."
        Write-Warning "You can check Task Manager for the active 'node' process."
    }
} else {
    Write-Info "Verifying Unix Socket at $SocketPath..."
    if (Test-Path $SocketPath) {
        Write-Success "✓ DesktopCommanderMCP Unix Socket service is active and listening at $SocketPath!"
    } else {
        Write-Warning "⚠ Service started but Unix Socket file was not detected at $SocketPath."
        Write-Warning "You can check Task Manager for the active 'node' process."
    }
}

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Green
Write-Host ""
if ($Mode -eq "Http") {
    Write-Host "HTTP Endpoint: http://localhost:$Port/execute"
    Write-Host "To configure MCP clients, set env variable:"
    Write-Host "  DESKTOP_COMMANDER_URL = `"http://localhost:$Port/execute`""
} else {
    Write-Host "Unix Socket: $SocketPath"
    Write-Host "To configure MCP clients, set env variable:"
    Write-Host "  DESKTOP_COMMANDER_URL = `"$SocketPath`""
}
Write-Host ""
Write-Success "Done!"
