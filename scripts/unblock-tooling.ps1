# Removes Mark-of-the-Web (Zone.Identifier) from every file under a directory.
#
# Toolchains downloaded from the internet (portable Node, npm caches, agent
# binaries) carry MOTW; Windows SmartScreen/UAC then gates their first run
# with a consent dialog that stalls unattended OpenCode sessions. Unblock
# trusted tooling ONCE after downloading it:
#
#   powershell -ExecutionPolicy Bypass -File scripts\unblock-tooling.ps1 -Path C:\tools\node20
#   ... add -WhatIf to preview, -Confirm to be prompted per file.
#
# Only run this on directories you trust - it strips the OS's download provenance.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "path not found: $Path"
  exit 1
}

$unblocked = 0
Get-ChildItem -LiteralPath $Path -Recurse -File -Force |
  ForEach-Object {
    if ($PSCmdlet.ShouldProcess($_.FullName, "Unblock")) {
      try {
        Unblock-File -LiteralPath $_.FullName -ErrorAction Stop
        $unblocked += 1
      } catch {
        Write-Verbose "skipped $($_.TargetObject): $($_.Exception.Message)"
      }
    }
  }

Write-Host "Unblocked $unblocked files under $Path (use -WhatIf to preview first)."
