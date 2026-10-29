# One-off: stop the DACH re-import (cmd PID given) the moment it reaches the
# grade, so the beds are graded later with the leaner grade (untracked helper).
param([int]$RootPid)
$log = 'E:\retroflightsim-data\reimport-dach.log'
$start = (Get-Item $log).Length
while (Get-Process -Id $RootPid -ErrorAction SilentlyContinue) {
    $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    try {
        $fs.Seek($start, 'Begin') | Out-Null
        $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd()
    } finally { $fs.Close() }
    if ($text -match '\[grading road and railway beds\]') {
        & taskkill.exe /F /T /PID $RootPid | Out-Null
        Add-Content $log "=== GATE: stopped before the grade, resume with START_TAIL='grading road and railway beds' ($(Get-Date -Format s))"
        break
    }
    Start-Sleep 2
}
