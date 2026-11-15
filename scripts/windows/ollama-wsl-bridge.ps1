# Libera o Ollama do Windows (que continua escutando só em 127.0.0.1:11434) para o WSL2, sem expô-lo à rede.
# - portproxy escutando SOMENTE no IP do Windows na interface virtual do WSL (vEthernet (WSL...));
# - regra de firewall de entrada restrita a esse IP local e à sub-rede do WSL.
# Idempotente: remove o proxy/regra anteriores (ex.: IP do WSL mudou após reiniciar o Windows) e recria.
# Uso (PowerShell como Administrador):  powershell -ExecutionPolicy Bypass -File scripts\windows\ollama-wsl-bridge.ps1
# Remover:                               powershell -ExecutionPolicy Bypass -File scripts\windows\ollama-wsl-bridge.ps1 -Remove
param([int]$Port = 11434, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$ruleName = 'Ollama (somente WSL2)'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Execute este script como Administrador.' }

# Remove proxies antigos desta porta que apontam para o Ollama local.
foreach ($line in (netsh interface portproxy show v4tov4) -split "`r?`n") {
  if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+127\.0\.0\.1\s+(\d+)\s*$' -and [int]$Matches[2] -eq $Port) {
    netsh interface portproxy delete v4tov4 listenaddress=$($Matches[1]) listenport=$Port | Out-Null
  }
}
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Output 'Ponte Ollama <-> WSL2 removida.'; exit 0 }

$wsl = Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -like 'vEthernet (WSL*' | Select-Object -First 1
if (-not $wsl) { throw 'Interface vEthernet (WSL) não encontrada. Inicie o WSL (ex.: wsl -d Ubuntu) e execute de novo.' }
$ip = $wsl.IPAddress
# Endereço de rede da sub-rede do WSL (ex.: 172.29.48.0/20).
$bytes = ([Net.IPAddress]::Parse($ip)).GetAddressBytes(); [Array]::Reverse($bytes)
$mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $wsl.PrefixLength))
$net = [BitConverter]::GetBytes([BitConverter]::ToUInt32($bytes, 0) -band $mask); [Array]::Reverse($net)
$subnet = "$(([Net.IPAddress]::new($net)).ToString())/$($wsl.PrefixLength)"

if ((Get-Service iphlpsvc).Status -ne 'Running') { Start-Service iphlpsvc }
netsh interface portproxy add v4tov4 listenaddress=$ip listenport=$Port connectaddress=127.0.0.1 connectport=$Port | Out-Null
New-NetFirewallRule -DisplayName $ruleName -Description 'Permite que containers do WSL2 acessem o Ollama local via portproxy.' `
  -Direction Inbound -Protocol TCP -LocalAddress $ip -LocalPort $Port -RemoteAddress $subnet -Action Allow -Profile Any | Out-Null

Write-Output "Ponte criada: $ip`:$Port (WSL2, sub-rede $subnet) -> 127.0.0.1:$Port"
Write-Output "Na tela Configuracoes da aplicacao, use a URL:  http://$ip`:$Port  (ou clique em Detectar / Configurar automaticamente)"
