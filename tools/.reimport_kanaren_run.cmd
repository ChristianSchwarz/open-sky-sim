@echo off
rem Scratch launcher (untracked) for tools/.reimport_kanaren.mjs, as the DACH one:
rem temp files on E: (C: is nearly full), log beside the data.
cd /d C:\Users\chris\Projects\retroflightsim
set PYTHON=python
set PYTHONIOENCODING=utf-8
set TEMP=E:\retroflightsim-data\tmp
set TMP=E:\retroflightsim-data\tmp
set CPL_TMPDIR=E:\retroflightsim-data\tmp
set CLIP_PBF_WORKERS=8
set SATELLITES=1
echo === start chunk %START_CHUNK% piece %START_PIECE% step "%START_STEP%" tail "%START_TAIL%" %DATE% %TIME% >> E:\retroflightsim-data\reimport-kanaren.log
node --import tsx tools/.reimport_kanaren.mjs >> E:\retroflightsim-data\reimport-kanaren.log 2>&1
echo === driver exited with %ERRORLEVEL% %DATE% %TIME% >> E:\retroflightsim-data\reimport-kanaren.log
