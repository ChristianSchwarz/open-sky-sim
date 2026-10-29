@echo off
rem One-off (untracked): the lidar for southern Brandenburg and Berlin only, then the DACH
rem re-import on from the bridges (grade, far land, buildings) under its guard.
cd /d C:\Users\chris\Projects\retroflightsim
set PYTHON=python
rem Temp files on E: - the lidar step held 7 GB of them on C: and the guard stopped it.
set TEMP=E:\retroflightsim-data\tmp
etroflightsim-data	mp
set TMP=E:\retroflightsim-data\tmp
etroflightsim-data	mp
set CPL_TMPDIR=E:\retroflightsim-data\tmp
etroflightsim-data	mp
set CLIP_PBF_WORKERS=8
set LOG=E:\retroflightsim-data\reimport-dach.log
echo === lidar for southern Brandenburg and Berlin only %DATE% %TIME% >> %LOG%
python tools/measure_lidar.py --bbox=11.26,51.35,14.77,52.70 >> %LOG% 2>&1
echo [lidar Berlin/Brandenburg] exit %ERRORLEVEL% >> %LOG%
set START_TAIL=baking bridges
call tools\.reimport_dach_run.cmd
