param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appPort = if ($env:PORT) { [int]$env:PORT } else { 43110 }
$appUrl = "http://127.0.0.1:$appPort"
$createdNew = $false
$mutex = [Threading.Mutex]::new($true, 'Local\ArxivFollowUp.Tray.v1', [ref]$createdNew)

if (-not $createdNew) {
  Start-Process $appUrl
  $mutex.Dispose()
  exit 0
}

$notifyIcon = $null
$backend = $null
$context = $null
$runtimeState = @{ Closing = $false }

try {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
  } else {
    $portableNode = Join-Path $appRoot '.runtime\node-v24.19.0-win-x64\node.exe'
    if (Test-Path -LiteralPath $portableNode) { $nodePath = $portableNode }
  }

  if (-not $nodePath) {
    [Windows.Forms.MessageBox]::Show(
      'Node.js 24 or newer is required. Download it from https://nodejs.org/',
      'ArxivFollowUp could not start',
      [Windows.Forms.MessageBoxButtons]::OK,
      [Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
  }

  $trayToken = [Guid]::NewGuid().ToString('N')
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodePath
  $startInfo.Arguments = '"{0}"' -f (Join-Path $appRoot 'src\server.js')
  $startInfo.WorkingDirectory = $appRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables['AFU_TRAY_TOKEN'] = $trayToken

  $backend = [Diagnostics.Process]::new()
  $backend.StartInfo = $startInfo
  $backend.EnableRaisingEvents = $true
  if (-not $backend.Start()) { throw 'The ArxivFollowUp backend process could not be started.' }

  $bootstrap = $null
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($backend.HasExited) { throw "The ArxivFollowUp backend exited with code $($backend.ExitCode)." }
    try {
      $bootstrap = Invoke-RestMethod -Uri "$appUrl/api/bootstrap" -Method Get -TimeoutSec 1
      break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $bootstrap) { throw 'The ArxivFollowUp backend did not become ready within 15 seconds.' }

  if ($bootstrap.settings.open_browser_on_start -ne '0') { Start-Process $appUrl }

  $context = [Windows.Forms.ApplicationContext]::new()
  $menu = [Windows.Forms.ContextMenuStrip]::new()
  $openItem = $menu.Items.Add('Open ArxivFollowUp')
  $exitItem = $menu.Items.Add('Exit ArxivFollowUp')

  $notifyIcon = [Windows.Forms.NotifyIcon]::new()
  $notifyIcon.Icon = [Drawing.SystemIcons]::Application
  $notifyIcon.Text = 'ArxivFollowUp (AFU) - arXiv tracker'
  $notifyIcon.ContextMenuStrip = $menu
  $notifyIcon.Visible = $true

  $openHandler = {
    if ($backend -and -not $backend.HasExited) { Start-Process $appUrl }
  }.GetNewClosure()
  $openItem.add_Click($openHandler)
  $notifyIcon.add_DoubleClick($openHandler)

  $backend.add_Exited({
    if (-not $runtimeState.Closing -and $notifyIcon) {
      $notifyIcon.BalloonTipTitle = 'ArxivFollowUp stopped'
      $notifyIcon.BalloonTipText = 'The backend exited unexpectedly.'
      $notifyIcon.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Error
      $notifyIcon.ShowBalloonTip(5000)
    }
  }.GetNewClosure())

  $exitItem.add_Click({
    $runtimeState.Closing = $true
    if ($notifyIcon) { $notifyIcon.Visible = $false }
    if ($backend -and -not $backend.HasExited) {
      try {
        Invoke-RestMethod -Uri "$appUrl/api/runtime/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -Headers @{
          'X-AFU-Request' = '1'
          'X-AFU-Tray-Token' = $trayToken
        } -TimeoutSec 2 | Out-Null
      } catch {}
      if (-not $backend.WaitForExit(5000)) { $backend.Kill() }
    }
    if ($context) { $context.ExitThread() }
  }.GetNewClosure())

  [Windows.Forms.Application]::Run($context)
} catch {
  [Windows.Forms.MessageBox]::Show(
    $_.Exception.Message,
    'ArxivFollowUp could not start',
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
} finally {
  if ($notifyIcon) { $notifyIcon.Visible = $false; $notifyIcon.Dispose() }
  if ($backend -and -not $backend.HasExited) {
    try {
      Invoke-RestMethod -Uri "$appUrl/api/runtime/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -Headers @{
        'X-AFU-Request' = '1'
        'X-AFU-Tray-Token' = $trayToken
      } -TimeoutSec 2 | Out-Null
    } catch {}
    if (-not $backend.WaitForExit(5000)) { $backend.Kill() }
  }
  if ($backend) { $backend.Dispose() }
  if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
