# One-off: when the gate has stopped the DACH re-import before the grade,
# resume it there (now with the simplifying grade) under its disk guard (untracked helper).
$log = 'E:\retroflightsim-data\reimport-dach.log'
$start = (Get-Item $log).Length
while ($true) {
    $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    try {
        $fs.Seek($start, 'Begin') | Out-Null
        $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd()
    } finally { $fs.Close() }
    if ($text -match '=== GATE: stopped before the grade') { break }
    if ($text -match '=== GUARD:|=== driver exited with [1-9]') {
        Add-Content $log "=== NOT resumed after the gate: the import stopped another way ($(Get-Date -Format s))"
        exit 1
    }
    Start-Sleep 20
}
Start-Sleep 10
$env:START_TAIL = 'grading road and railway beds'
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','C:\Users\chris\Projects\retroflightsim\tools\.reimport_dach_run.cmd' -WindowStyle Hidden -PassThru
Start-Process powershell.exe -ArgumentList '-NoProfile','-File','C:\Users\chris\Projects\retroflightsim\tools\.reimport_dach_guard.ps1','-RootPid',"$($p.Id)" -WindowStyle Hidden
Set-Content 'E:\retroflightsim-data\reimport-dach.pid' $p.Id
Add-Content $log "=== resumed at the grade, driver $($p.Id) ($(Get-Date -Format s))"
