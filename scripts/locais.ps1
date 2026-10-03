# Lista as pastas conhecidas do usuario (Area de Trabalho, Downloads, Documentos,
# Imagens, Videos) e as unidades prontas para uso.
# Saida: JSON codificado em base64 (UTF-8), para nao depender da pagina de codigo do console.

$ErrorActionPreference = 'SilentlyContinue'

$shellFolders = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
$downloads = $shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
if (-not $downloads) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }

$places = [ordered]@{
    desktop   = [Environment]::GetFolderPath('Desktop')
    downloads = $downloads
    documents = [Environment]::GetFolderPath('MyDocuments')
    pictures  = [Environment]::GetFolderPath('MyPictures')
    videos    = [Environment]::GetFolderPath('MyVideos')
    home      = $env:USERPROFILE
}

$drives = New-Object System.Collections.ArrayList
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    try {
        if (-not $d.IsReady) { continue }
        [void]$drives.Add([ordered]@{
            path  = $d.Name
            label = $d.VolumeLabel
            type  = [string]$d.DriveType
            total = $d.TotalSize
            free  = $d.AvailableFreeSpace
        })
    } catch { }
}

$result = [ordered]@{ places = $places; drives = @($drives) }
$json = ConvertTo-Json -InputObject $result -Depth 4 -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
