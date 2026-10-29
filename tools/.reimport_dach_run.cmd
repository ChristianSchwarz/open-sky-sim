@echo off
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
echo === resume chunk %START_CHUNK% piece %START_PIECE% at "%START_STEP%" %DATE% %TIME% >> E:\retroflightsim-data\reimport-dach.log
node --import tsx tools/.reimport_dach.mjs >> E:\retroflightsim-data\reimport-dach.log 2>&1
echo === driver exited with %ERRORLEVEL% >> E:\retroflightsim-data\reimport-dach.log
