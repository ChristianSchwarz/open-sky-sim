# One-off: move assets/planet to E: and leave a junction (untracked helper).
$ErrorActionPreference = 'Stop'
$src = 'C:\Users\chris\Projects\retroflightsim\assets\planet'
$dst = 'E:\retroflightsim-data\planet'
$log = 'E:\retroflightsim-data\move-planet.log'
function Say($m) { Add-Content $log "$(Get-Date -Format s) $m" }

Say "start: copying $src -> $dst"
robocopy $src $dst /E /XJ /COPY:DAT /DCOPY:DAT /MT:16 /R:2 /W:2 /NFL /NDL /NP /LOG+:E:\retroflightsim-data\move-planet.robocopy.log | Out-Null
$rc = $LASTEXITCODE
Say "robocopy exit $rc"
if ($rc -ge 8) { Say 'ABORT: robocopy reported failures'; exit 1 }

function Tally($root) {
    $files = Get-ChildItem $root -Recurse -File -Force | Where-Object { $_.FullName -notlike "$root\tex_cache\*" }
    [pscustomobject]@{ n = $files.Count; bytes = ($files | Measure-Object Length -Sum).Sum }
}
$a = Tally $src; $b = Tally $dst
Say "C: $($a.n) files $($a.bytes) B | E: $($b.n) files $($b.bytes) B (tex_cache excluded)"
if ($a.n -ne $b.n -or $a.bytes -ne $b.bytes) { Say 'ABORT: copy does not match, C: left untouched'; exit 1 }

# The tex_cache junction first, on its own: a recursive delete would follow it.
[System.IO.Directory]::Delete("$src\tex_cache", $false)
Remove-Item -LiteralPath $src -Recurse -Force
New-Item -ItemType Junction -Path $src -Target $dst | Out-Null
$c = (Get-ChildItem "$src\tex_cache" -Recurse -File | Measure-Object).Count
Say "DONE: $src is a junction to $dst; tex_cache shows $c files; C: free $([math]::Round((Get-PSDrive C).Free/1GB,1)) GB"
