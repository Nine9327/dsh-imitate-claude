#!/usr/bin/env pwsh
# 一键跑完所有测试与端到端验收。
# 用法：pwsh ./verify.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$testFiles = @(
  'packages/core/test/core.test.mjs',
  'packages/core/test/preset.test.mjs',
  'packages/instructions/test/load.test.mjs',
  'packages/instructions/test/plugin.test.mjs',
  'packages/command-init/test/init.test.mjs'
)

$totalPass = 0
$totalFail = 0

Write-Host '=== 单元测试 ===' -ForegroundColor Cyan
foreach ($file in $testFiles) {
  $output = node $file 2>&1
  $pass = [int](($output | Select-String -Pattern '^# pass (\d+)').Matches.Groups[1].Value)
  $fail = [int](($output | Select-String -Pattern '^# fail (\d+)').Matches.Groups[1].Value)
  $name = Split-Path $file -Leaf
  if ($fail -eq 0) {
    Write-Host ("  ok   {0,-28} {1} passed" -f $name, $pass) -ForegroundColor Green
  } else {
    Write-Host ("  FAIL {0,-28} {1} failed" -f $name, $fail) -ForegroundColor Red
    $output | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
  }
  $totalPass += $pass
  $totalFail += $fail
}

Write-Host ''
Write-Host '=== 端到端验收 ===' -ForegroundColor Cyan
node test/acceptance.mjs
$acceptanceOk = $LASTEXITCODE -eq 0

Write-Host ''
Write-Host ("单元测试：{0} 通过，{1} 失败" -f $totalPass, $totalFail)
if ($acceptanceOk -and $totalFail -eq 0) {
  Write-Host '整体结果：通过' -ForegroundColor Green
  exit 0
}
Write-Host '整体结果：失败' -ForegroundColor Red
exit 1
