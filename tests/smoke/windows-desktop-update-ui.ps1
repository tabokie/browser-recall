$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$process = Get-Process -Id ([int]$env:BROWSER_RECALL_UPDATE_PID)
$window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
if (!$window) { throw 'Browser Recall test window is unavailable' }
$elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
if ($env:BROWSER_RECALL_UPDATE_UI_ACTION -eq 'dump') {
  foreach ($element in $elements) { $element.Current.Name }
  exit 0
}
$target = $null
foreach ($element in $elements) {
  if ($element.Current.Name -eq $env:BROWSER_RECALL_UPDATE_UI_LABEL -and
      $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
    $target = $element
    break
  }
}
if (!$target) {
  $visibleNames = @($elements | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName): $($_.Current.Name)" }) -join '; '
  throw "Missing accessible button: $env:BROWSER_RECALL_UPDATE_UI_LABEL. Process $($process.Id), window $($process.MainWindowHandle). Accessible elements: $visibleNames"
}
$pattern = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) {
  $pattern.ScrollIntoView()
}
$pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$pattern.Invoke()
