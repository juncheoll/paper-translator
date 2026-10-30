# Pinned official uv release asset; ExecutionPolicy is changed only for this process by the .cmd launcher.
$ErrorActionPreference = 'Stop'
try {
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') {
        throw 'This beta bootstrap supports Windows x64. Windows ARM is not verified.'
    }
    $mttTools = Split-Path -Parent $MyInvocation.MyCommand.Path
    $mttHome = if ($env:PAPER_DOCLING_HOME) { $env:PAPER_DOCLING_HOME } else { Join-Path $env:LOCALAPPDATA 'PaperTranslator\Docling' }
    $mttTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('mtt-docling-setup-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $mttTemp -Force | Out-Null
    Write-Host 'Preparing a private Python runtime and Docling environment. Initial setup may take several minutes.'
    $mttArchive = Join-Path $mttTemp 'uv.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' -OutFile $mttArchive
    $mttExpected = 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
    if ((Get-FileHash -Algorithm SHA256 $mttArchive).Hash.ToLowerInvariant() -ne $mttExpected) {
        throw 'uv checksum verification failed. Nothing was executed.'
    }
    Expand-Archive -Path $mttArchive -DestinationPath (Join-Path $mttTemp 'unpacked')
    $mttUvSource = @(Get-ChildItem (Join-Path $mttTemp 'unpacked') -Filter uv.exe -Recurse)
    if ($mttUvSource.Count -ne 1) { throw 'The verified uv archive has an unexpected layout.' }
    $mttBootstrap = Join-Path $mttHome 'bootstrap'
    New-Item -ItemType Directory -Path $mttBootstrap -Force | Out-Null
    $mttUv = Join-Path $mttBootstrap 'uv.exe'
    Copy-Item $mttUvSource[0].FullName $mttUv -Force
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $mttHome 'python'
    $env:UV_PYTHON_BIN_DIR = Join-Path $mttBootstrap 'bin'
    $env:UV_CACHE_DIR = Join-Path $mttHome 'uv-cache'
    $env:UV_NO_MODIFY_PATH = '1'
    $env:PYTHONUTF8 = '1'
    & $mttUv python install --no-config --no-bin --no-registry 3.12.14
    if ($LASTEXITCODE -ne 0) { throw 'The private Python download failed.' }
    $mttPython = (& $mttUv python find --no-config --managed-python 3.12.14 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mttPython)) { throw 'The private Python executable was not found.' }
    & $mttPython (Join-Path $mttTools 'install_docling_helper.py') --home $mttHome @args
    if ($LASTEXITCODE -ne 0) { throw 'Docling helper installation failed. See the output above.' }
    exit 0
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($mttTemp -and (Test-Path -LiteralPath $mttTemp)) { Remove-Item -LiteralPath $mttTemp -Recurse -Force }
}
