Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-WaveIcon([int]$size, [string]$dest) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

  $scale = $size / 128.0
  $pad = [Math]::Max(1, [int][Math]::Round(6 * $scale))
  $radius = [Math]::Max(2, [int][Math]::Round(28 * $scale))
  $side = $size - (2 * $pad)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($pad, $pad, $diameter, $diameter, 180, 90)
  $path.AddArc($pad + $side - $diameter, $pad, $diameter, $diameter, 270, 90)
  $path.AddArc($pad + $side - $diameter, $pad + $side - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($pad, $pad + $side - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.Point $pad, $pad),
    (New-Object System.Drawing.Point ($pad + $side), ($pad + $side)),
    ([System.Drawing.Color]::FromArgb(255, 8, 47, 73)),
    ([System.Drawing.Color]::FromArgb(255, 14, 116, 144))
  )
  $g.FillPath($brush, $path)

  $cx = [single]($size * 0.40)
  $cy = [single]($size * 0.50)
  $body = [Math]::Max(2, [int][Math]::Round(10 * $scale))
  $speaker = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 254, 255))
  $g.FillEllipse($speaker, $cx - $body, $cy - $body, $body * 2, $body * 2)

  $penColor = [System.Drawing.Color]::FromArgb(255, 103, 232, 249)
  $widths = @(5.5, 5.5, 5.5)
  $radii = @(22, 36, 50)
  for ($i = 0; $i -lt $radii.Count; $i++) {
    $r = [single]($radii[$i] * $scale)
    $w = [Math]::Max(1.4, $widths[$i] * $scale)
    $pen = New-Object System.Drawing.Pen $penColor, $w
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, $cx - $r, $cy - $r, $r * 2, $r * 2, -55, 110)
    $pen.Dispose()
  }

  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen = $null
  $speaker.Dispose()
  $brush.Dispose()
  $path.Dispose()
  $g.Dispose()
  $bmp.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  New-WaveIcon $size (Join-Path $iconDir "icon$size.png")
}
