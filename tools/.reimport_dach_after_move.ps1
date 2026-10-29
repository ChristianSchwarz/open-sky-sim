# One-off: once the assets/planet move (PID given) has finished cleanly, resume
# the DACH re-import at chunk 20 with its disk guard (untracked helper).
param([int]$MovePid)
$log = 'E:\retroflightsim-data\reimport-dach.log'
while (Get-Process -Id $MovePid -ErrorAction SilentlyContinue) { Start-Sleep 30 }
if (-not (Select-String -Path 'E:\retroflightsim-data\move-planet.log' -Pattern 'DONE:' -Quiet)) {
    Add-Content $log "=== NOT resumed: the assets/planet move did not finish ($(Get-Date -Format s))"
    exit 1
}
$env:START_CHUNK = '20'
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','C:\Users\chris\Projects\retroflightsim\tools\.reimport_dach_run.cmd' -WindowStyle Hidden -PassThru
Start-Process powershell.exe -ArgumentList '-NoProfile','-File','C:\Users\chris\Projects\retroflightsim\tools\.reimport_dach_guard.ps1','-RootPid',"$($p.Id)" -WindowStyle Hidden
Set-Content 'E:\retroflightsim-data\reimport-dach.pid' $p.Id
