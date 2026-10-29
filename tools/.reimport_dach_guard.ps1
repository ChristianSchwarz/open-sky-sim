# Kills the detached DACH re-import (cmd PID given) when C: runs out: under
# 3 GB free for 3 minutes running, or under 1 GB at once. Another session's
# headless Chrome profiles (%TEMP%\cdp-*) dip C: under 3 GB for a minute or
# two and give it back; stopping the grade for those cost an hour each time.
param([int]$RootPid)
$log = 'E:\retroflightsim-data\reimport-dach.log'
$low = 0
while (Get-Process -Id $RootPid -ErrorAction SilentlyContinue) {
    $free = (Get-PSDrive C).Free
    if ($free -lt 3GB) { $low++ } else { $low = 0 }
    if ($free -lt 1GB -or $low -ge 18) {
        & taskkill.exe /F /T /PID $RootPid | Out-Null
        Add-Content $log "=== GUARD: C: at $([math]::Round($free/1GB,1)) GB free ($($low * 10) s under 3 GB), killed the re-import $(Get-Date -Format s)"
        break
    }
    Start-Sleep 10
}
