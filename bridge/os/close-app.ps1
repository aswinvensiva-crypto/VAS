<#
  Ask an app's windows to close, the way clicking X does.

  CloseMainWindow sends the window an ordinary close request, so an editor with
  unsaved work still gets to ask "save changes?". Nothing here kills a process
  or forces anything: an app that ignores the request stays open, and the
  count tells the caller how many windows were asked.

  Names arrive comma-joined in one argument, because powershell -File binds
  only one value to an array parameter. The bridge has already checked them;
  they are checked again here because this script can be run by hand.

  File Explorer is the exception. Its windows usually live in the same
  explorer.exe as the taskbar and desktop, and that process's "main window" can
  be the taskbar itself, where a close request opens the Shut Down dialog. So
  Explorer's folder windows are closed one by one through the Shell instead.

  Prints one integer: how many windows were asked to close.
#>
param([string[]]$ProcessName)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$names = @($ProcessName | ForEach-Object { $_ -split ',' } | Where-Object { $_ -match '^\w[\w.+ -]{0,63}$' } | Select-Object -Unique)
$count = 0

foreach ($name in $names) {
  if ($name -ieq 'explorer') {
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in @($shell.Windows())) {
      $path = [string]$window.FullName
      if ($path -and [IO.Path]::GetFileName($path) -ieq 'explorer.exe') {
        $window.Quit()
        $count++
      }
    }
    continue
  }

  foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.CloseMainWindow()) {
      $count++
    }
  }
}

Write-Output $count
