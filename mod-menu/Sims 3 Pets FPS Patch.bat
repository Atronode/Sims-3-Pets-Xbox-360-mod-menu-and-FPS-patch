@echo off
setlocal
title The Sims 3 Pets - frame rate
set "HERE=%~dp0"
for %%I in ("%HERE%..\xenia") do set "XENIA=%%~fI"
set "TARGET=%XENIA%\patches\45410962 - The Sims 3 Pets.patch.toml"
set "SMART=%XENIA%\patches\45410962 - Smart screen copies.patch.toml"
set "SMARTSRC=%HERE%fps-patch\Smart screen copies.toml"
set "COUNTER=%HERE%fps-patch\fps-counter-on.txt"
set "PETFIX=%HERE%fps-patch\pet-fix-on.txt"
set "MSG1="
set "MSG2="
set "MSG3="

if not exist "%XENIA%\xenia_canary.exe" (
  echo Could not find Xenia at:
  echo   %XENIA%
  echo Keep this folder next to your xenia folder, then run this again.
  echo.
  pause
  exit /b
)
tasklist /fi "imagename eq xenia_canary.exe" 2>nul | find /i "xenia_canary.exe" >nul
if not errorlevel 1 (
  echo Xenia is open. Close the game first, then run this again.
  echo.
  pause
  exit /b
)

:menu
cls
set "NOW=30 FPS (the game's normal limit)"
if exist "%TARGET%" set "NOW=a patch file this tool did not install"
if exist "%TARGET%" fc /b "%TARGET%" "%HERE%fps-patch\60 FPS.toml" >nul 2>nul && set "NOW=60 FPS patch"
if exist "%TARGET%" fc /b "%TARGET%" "%HERE%fps-patch\Unlocked FPS.toml" >nul 2>nul && set "NOW=Unlocked FPS patch"
set "COPIES=off"
if exist "%SMART%" set "COPIES=on (an older version: press 4 twice to update it)"
if exist "%SMART%" fc /b "%SMART%" "%SMARTSRC%" >nul 2>nul && set "COPIES=on"
set "SHOWN=off"
if exist "%COUNTER%" set "SHOWN=on"
set "PETS=off (recommended)"
if exist "%PETFIX%" set "PETS=on (lower FPS while pets are on screen)"
echo THE SIMS 3 PETS - FRAME RATE
echo.
echo   Frame rate now:           %NOW%
echo   Smart screen copies now:  %COPIES%
echo   FPS counter now:          %SHOWN%
echo   Pet safe mode now:        %PETS%
echo.
echo   1  60 FPS              (recommended)
echo   2  Unlocked FPS        (as fast as your PC can go; the picture can tear)
echo   3  Back to 30 FPS      (removes the frame rate patch)
echo   4  Smart screen copies on or off  (recommended on: lets slower PCs reach 60)
echo   5  FPS counter on or off
echo   6  Pet safe mode on or off  (only if a pet ever looks wrong; lower FPS)
echo   7  Close
echo.
if not defined MSG1 goto :ask
echo %MSG1%
if defined MSG2 echo %MSG2%
if defined MSG3 echo %MSG3%
echo.
:ask
set "MSG1="
set "MSG2="
set "MSG3="
choice /c 1234567 /n /m "Press 1 to 7: "
if errorlevel 7 goto :eof
if errorlevel 6 goto :petfix
if errorlevel 5 goto :counter
if errorlevel 4 goto :smart
if errorlevel 3 goto :remove
if errorlevel 2 goto :unlocked
goto :sixty

:sixty
set "SOURCE=%HERE%fps-patch\60 FPS.toml"
set "MSG1=Done. The game will run at up to 60 FPS next time you start it."
goto :install

:unlocked
set "SOURCE=%HERE%fps-patch\Unlocked FPS.toml"
set "MSG1=Done. The game will run as fast as your PC allows next time you start it."
goto :install

:remove
if exist "%TARGET%" del "%TARGET%"
set "MSG1=Done. The game is back to its normal 30 FPS."
goto :menu

:smart
if exist "%SMART%" goto :smartoff
if not exist "%XENIA%\patches" mkdir "%XENIA%\patches"
copy /y "%SMARTSRC%" "%SMART%" >nul
if not exist "%SMART%" (
  set "MSG1=Could not copy Smart screen copies into %XENIA%\patches"
  goto :menu
)
set "MSG1=Smart screen copies are on. They work when you start the game with"
set "MSG2="Play Sims 3 Pets (Mod Menu).bat". Portraits still come out right."
goto :patchesswitch
:smartoff
del "%SMART%"
set "MSG1=Smart screen copies are off. Xenia copies every picture back again (slower)."
goto :menu

:petfix
if exist "%PETFIX%" goto :petfixoff
> "%PETFIX%" echo Pet safe mode is on. Turn it off with "Sims 3 Pets FPS Patch.bat", or delete this file.
set "MSG1=Pet safe mode is on: Xenia copies pet fur back every frame, so pets always look right."
set "MSG2=The frame rate is lower while pets are on screen. It works when you start the game with the mod menu .bat."
goto :menu
:petfixoff
del "%PETFIX%"
set "MSG1=Pet safe mode is off: fastest. The Pets look right patch in Smart screen copies keeps pets right."
goto :menu

:counter
if exist "%COUNTER%" goto :counteroff
> "%COUNTER%" echo The FPS counter is on. Turn it off with "Sims 3 Pets FPS Patch.bat", or delete this file.
set "MSG1=The FPS counter is on. It shows in the top-left corner of the game"
set "MSG2=when you start it with "Play Sims 3 Pets (Mod Menu).bat"."
goto :menu
:counteroff
del "%COUNTER%"
set "MSG1=The FPS counter is off."
goto :menu

:install
if not exist "%XENIA%\patches" mkdir "%XENIA%\patches"
copy /y "%SOURCE%" "%TARGET%" >nul
if not exist "%TARGET%" (
  set "MSG1=Could not copy the patch into %XENIA%\patches"
  goto :menu
)
set "MSG2=Xenia's title bar shows [Patches Applied] when it is working."

:patchesswitch
rem Xenia only reads patches when apply_patches is on. It is on by default; switch it back on if it was turned off.
findstr /b /c:"apply_patches = false" "%XENIA%\xenia-canary.config.toml" >nul 2>nul || goto :menu
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Join-Path $env:XENIA 'xenia-canary.config.toml'; $t = Get-Content -LiteralPath $c -Raw; [IO.File]::WriteAllText($c, ($t -replace '(?m)^apply_patches = false', 'apply_patches = true'))" >nul
set "MSG3=Patches were switched off in Xenia's settings, so they were switched back on."
goto :menu
