import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);

export function localUrl(port, suffix) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid-port');
  if (!/^\/(?:v1\/models|v0\/management\/(?:auth-files|codex-auth-url\?is_webui=true|get-auth-status\?state=[A-Za-z0-9_-]+|oauth-callback))$/.test(suffix)) throw Error('invalid-endpoint');
  return `http://127.0.0.1:${port}${suffix}`;
}

export function normalizeCatalog(data) {
  if (!Array.isArray(data?.data)) throw Error('invalid-model-list');
  return data.data.filter(m => typeof m?.id === 'string' && m.id.length <= 128).map(m => m.id).sort();
}

export function normalizeAccounts(data) {
  if (!Array.isArray(data?.files)) throw Error('invalid-account-list');
  return data.files.filter(x => (x.provider ?? x.type) === 'codex').map(x => ({
    label: typeof x.email === 'string' ? x.email : (typeof x.name === 'string' ? x.name : 'Codex'),
    status: typeof x.status === 'string' ? x.status : 'unknown',
    disabled: x.disabled === true,
    quota: normalizeQuota(x.quota),
    modelQuotas: Object.entries(x.model_quotas ?? {}).filter(([id])=>/^gpt-[\w.-]+$/.test(id)).map(([model,value])=>({model,...normalizeQuota(value)})),
  }));
}

export function normalizeQuota(value) {
  const s=value?.signals ?? {};
  const windows=[];
  for(const name of ['Primary','Secondary']) {
    const raw=s[`X-Codex-${name}-Used-Percent`], minutes=Number(s[`X-Codex-${name}-Window-Minutes`]);
    const used=Number(raw), reset=Number(s[`X-Codex-${name}-Reset-At`]);
    if(raw !== undefined && raw !== '' && Number.isFinite(used) && used>=0 && used<=100 && Number.isFinite(minutes) && minutes>0)
      windows.push({name,used,remaining:100-used,minutes,resetAt:Number.isFinite(reset)&&reset>0?reset:null});
  }
  return {observedAt:typeof value?.observed_at==='string'?value.observed_at:null, plan:typeof s['X-Codex-Plan-Type']==='string'?s['X-Codex-Plan-Type']:null, windows};
}

export async function installation(root = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'CLIProxyAPI')) {
  const c = JSON.parse(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'));
  const port = Number(c.server?.port);
  localUrl(port, '/v1/models');
  const apiKey = c.access?.['api-keys']?.[0];
  if (typeof apiKey !== 'string' || !apiKey) throw Error('missing-local-api-key');
  return {port, apiKey, keyPath: path.join(root, 'metrics-key.dpapi')};
}

export async function managementKey(file) {
  if (process.platform !== 'win32') throw Error('management-key-unavailable');
  // The fixed script reads a same-user DPAPI-protected file; no secret is passed as an argument.
  const script = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'); $s=(Get-Content -LiteralPath $env:DSH_CPA_KEYFILE -Raw).Trim() | ConvertTo-SecureString; [Console]::Out.Write((New-Object Net.NetworkCredential('', $s)).Password)";
  const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide:true, timeout:5000, maxBuffer:8192, env:{...process.env, DSH_CPA_KEYFILE:file}});
  if (!stdout) throw Error('management-key-unavailable');
  return stdout;
}

export async function focusDesktop() {
  if (process.platform !== 'win32') return false;
  // Best effort only: Windows may refuse a foreground request from a background process.
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DshWindow { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); }'; $p=@(Get-Process -Name 'DeepSeek Harness' | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Path -eq (Join-Path $env:LOCALAPPDATA 'Programs\\DeepSeek Harness\\DeepSeek Harness.exe')}); if($p.Count -eq 1 -and [DshWindow]::SetForegroundWindow($p[0].MainWindowHandle)){[Console]::Out.Write('1')}else{[Console]::Out.Write('0')}";
  try {const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:1024});return stdout==='1'} catch{return false}
}

export async function request(port, suffix, key, {method='GET', body, fetcher=fetch} = {}) {
  const response = await fetcher(localUrl(port, suffix), {method, redirect:'error', headers:{authorization:`Bearer ${key}`, ...(body ? {'content-type':'application/json'} : {})}, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error(`cpa-http-${response.status}`);
  return response.json();
}
