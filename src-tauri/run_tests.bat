@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
echo [cargo test] PATH=%PATH%
echo [cargo test] LIB=%LIB%
echo [cargo test] Running cargo test --lib...
cargo test --lib > test_output.log 2>&1
echo Exit code: %ERRORLEVEL%
type test_output.log
