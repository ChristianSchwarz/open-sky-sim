@echo off
rem One-off (untracked): northern Brandenburg re-bake with lidar, temp files on E:.
cd /d C:\Users\chris\Projects\retroflightsim
set PYTHON=python
set TEMP=E:\retroflightsim-data\tmp
set TMP=E:\retroflightsim-data\tmp
set CPL_TMPDIR=E:\retroflightsim-data\tmp
echo === start %DATE% %TIME% >> E:\retroflightsim-data\rebake-nbb.log
node --import tsx tools/.rebake_nbb.mjs >> E:\retroflightsim-data\rebake-nbb.log 2>&1
echo === driver exited with %ERRORLEVEL% >> E:\retroflightsim-data\rebake-nbb.log
