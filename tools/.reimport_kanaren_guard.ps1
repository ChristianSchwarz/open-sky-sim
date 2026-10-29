# Kills the detached Kanaren re-import (cmd PID given) when C: runs out: under
# 3 GB free for 3 minutes running, or under 1 GB at once. Writes to its own log
# (the re-import's is held open by the cmd), before it kills anything, and
# notes every sample under 5 GB, so a kill can be told from something else
# ending the run.
param([int]$RootPid)
$log = 'E:\retroflightsim-data\reimport-kanaren-guard.log'
$low = 0
Add-Content $log "=== guard watching $RootPid $(Get-Date -Format s)"
while (Get-Process -Id $RootPid -ErrorAction SilentlyContinue) {
    $free = (Get-PSDrive C).Free
    if ($free -lt 5GB) { Add-Content $log "$(Get-Date -Format s) C: $([math]::Round($free/1GB,2)) GB free" }
    if ($free -lt 3GB) { $low++ } else { $low = 0 }
    if ($free -lt 1GB -or $low -ge 18) {
        Add-Content $log "=== GUARD: C: at $([math]::Round($free/1GB,2)) GB free ($($low * 10) s under 3 GB), killing $RootPid $(Get-Date -Format s)"
        & taskkill.exe /F /T /PID $RootPid | Out-Null
        break
    }
    Start-Sleep 10
}
Add-Content $log "=== guard done: $RootPid is gone $(Get-Date -Format s)"
