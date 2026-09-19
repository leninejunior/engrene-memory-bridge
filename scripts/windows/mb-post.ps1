[CmdletBinding()]
param(
  [string]$Tool = "codex",
  [Parameter(Mandatory = $true)][string]$Intent,
  [Parameter(Mandatory = $true)][string]$Summary,
  [string]$Actions = "",
  [string]$Artifacts = "",
  [string]$Tags = "",
  [string]$TaskId = "",
  [string]$ParentTaskId = "",
  [string]$Workspace = ""
)

$logArgs = @(
  "log",
  "--tool", $Tool,
  "--intent", $Intent,
  "--summary", $Summary
)

if ($Actions -ne "") {
  $logArgs += @("--actions", $Actions)
}
if ($Artifacts -ne "") {
  $logArgs += @("--artifacts", $Artifacts)
}
if ($Tags -ne "") {
  $logArgs += @("--tags", $Tags)
}
if ($TaskId -ne "") {
  $logArgs += @("--task-id", $TaskId)
}
if ($ParentTaskId -ne "") {
  $logArgs += @("--parent-task-id", $ParentTaskId)
}
if ($Workspace -ne "") {
  $logArgs += @("--workspace", $Workspace)
}

& memory-bridge @logArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$handoffArgs = @("handoff", "build")
if ($Workspace -ne "") {
  $handoffArgs += @("--workspace", $Workspace)
}

& memory-bridge @handoffArgs
exit $LASTEXITCODE

