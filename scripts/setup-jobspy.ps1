param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$environmentDirectory = Join-Path $projectDirectory '.venv-jobspy'
& $Python -m venv $environmentDirectory
if ($LASTEXITCODE -ne 0) { throw '创建 JobSpy 环境失败；请使用 Python 3.10 或更新版本。' }
$jobspyPython = Join-Path $environmentDirectory 'Scripts/python.exe'
& $jobspyPython -X utf8 -m pip install -r (Join-Path $PSScriptRoot 'requirements-jobspy.txt')
if ($LASTEXITCODE -ne 0) { throw '安装 JobSpy 失败。官网来源仍可独立工作。' }
& $jobspyPython -c "import importlib.metadata; print('JobSpy ' + importlib.metadata.version('python-jobspy') + ' ready')"
Write-Output '职航会自动使用项目内 .venv-jobspy。也可通过 JOBSPY_PYTHON 指定其他已安装 JobSpy 的解释器。'
