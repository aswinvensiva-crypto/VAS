# The address of the page you are looking at in Chrome.
#
# The Claude extension only sees the tabs in its own group, so "what's on this
# page?" cannot ask it which tab is yours. This reads the address bar of the
# front-most Chrome window instead, through Windows UI Automation — read-only,
# the same information a screen reader gets. Prints the URL, or nothing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$isChrome = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
# Children of the desktop come back front-most first.
foreach ($win in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $isChrome)) {
  try {
    $proc = Get-Process -Id $win.Current.ProcessId -ErrorAction Stop
    if ($proc.ProcessName -ne 'chrome') { continue }
    $isEdit = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)
    foreach ($edit in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isEdit)) {
      $pattern = $null
      if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = $pattern.Current.Value
        if ($value) { Write-Output $value; exit 0 }
      }
    }
  } catch { continue }
}
