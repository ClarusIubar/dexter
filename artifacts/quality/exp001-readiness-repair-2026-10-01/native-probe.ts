import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { buildCodexOutputSchema, serializeCodexPrompt, parseCodexModelOutput } from '../../../src/agent/codex-exec-protocol.ts';

const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const schemaPath = `${import.meta.dir}/probe.schema.json`;
await writeFile(schemaPath, JSON.stringify(buildCodexOutputSchema([])));
const disabled = ['hooks', 'plugins', 'apps', 'memories', 'multi_agent', 'shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'image_generation', 'skill_search', 'skill_mcp_dependency_install', 'computer_use', 'remote_plugin', 'workspace_dependencies', 'request_permissions_tool', 'tool_call_mcp_elicitation', 'in_app_local_automation', 'in_app_browser', 'standalone_web_search', 'realtime_conversation', 'auth_elicitation', 'enable_mcp_apps', 'code_mode', 'code_mode_host', 'code_mode_only', 'unified_exec_tty'];
const env: NodeJS.ProcessEnv = {};
for (const key of ['PATH','HOME','CODEX_HOME','LANG','LC_ALL','TERM','USER','LOGNAME','XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key];
env.CODEX_HOME ??= `${env.HOME}/.codex`;
env.TMPDIR = import.meta.dir; env.TMP = import.meta.dir; env.TEMP = import.meta.dir; env.CI = '1';
const args = ['exec','--model','gpt-6-sol','-c','model_reasoning_effort="medium"','--json','--sandbox','read-only','--ignore-user-config','--ephemeral','--skip-git-repo-check','--enable','skip_host_skill_discovery',...disabled.flatMap(f => ['--disable',f]),'--cd',import.meta.dir,'-c','project_doc_max_bytes=0','-c','web_search="disabled"','-c','suppress_unstable_features_warning=true','--output-schema',schemaPath,'-'];
const child = spawn('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny process-fork)',binary,...args],{cwd:import.meta.dir,env,stdio:['pipe','pipe','pipe']});
const events: Record<string,unknown>[] = [];
let buffer = ''; let bytes = 0; let finalText: string | null = null; let usage: unknown = null; let turnStarted = false; let rejected: string | null = null;
const startedAt = new Date().toISOString();
const timeout = setTimeout(()=>{ rejected = 'diagnostic_timeout'; child.kill('SIGTERM'); },60_000);
function accept(line: string) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    events.push({type:event.type,itemType:event.item?.type ?? null,message:event.item?.message ?? event.message ?? event.error?.message ?? null});
    if (event.type === 'turn.started') turnStarted = true;
    if (event.type.startsWith('item.') && !['error','reasoning','agent_message'].includes(event.item?.type)) {rejected='native_action';child.kill('SIGTERM');}
    if (event.item?.type === 'error') {
      const known = !turnStarted && event.type === 'item.completed' && event.item.message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
      if (!known) { rejected='unknown_diagnostic';child.kill('SIGTERM'); }
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalText = event.item.text;
    if (event.type === 'turn.completed') usage = event.usage;
    if (event.type === 'turn.failed' || event.type === 'error') {rejected='cli_failure';child.kill('SIGTERM');}
  } catch {rejected='malformed'; child.kill('SIGTERM');}
}
child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024){rejected='output_limit';child.kill('SIGTERM');return;}buffer+=chunk.toString();let n=buffer.indexOf('\n');while(n>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);accept(line);n=buffer.indexOf('\n');}});
child.stderr.on('data',()=>undefined);
child.stdin.on('error',()=>{rejected='stdin_error';});
child.stdin.end(serializeCodexPrompt([{role:'user',content:'This is a synthetic compatibility check. Return EXP001_READY as the final answer content.'}],[]));
const code = await new Promise<number|null>(resolve=>child.once('close',resolve));
clearTimeout(timeout);accept(buffer);
let validEnvelope = false; let exactExpectedContent = false;
if(finalText){try{const parsed=parseCodexModelOutput(finalText,[]);validEnvelope=true;exactExpectedContent=parsed.kind==='final' && parsed.content==='EXP001_READY';}catch{}}
const report={scope:'Diagnostic native observation, not production ModelPort acceptance or pilot',startedAt,finishedAt:new Date().toISOString(),exitCode:code,rejected,events,validEnvelope,exactExpectedContent,usage,usageStatus:usage?'observed':'unavailable',responseSha256:finalText?createHash('sha256').update(finalText).digest('hex'):null,args};
await writeFile(`${import.meta.dir}/native-probe.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
process.exitCode=code===0 && !rejected && exactExpectedContent && usage ? 0:1;
