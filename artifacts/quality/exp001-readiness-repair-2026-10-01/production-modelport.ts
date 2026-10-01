import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { HumanMessage } from '@langchain/core/messages';
import { CodexExecModelPort, CodexModelPortError } from '../../../src/model/codex-exec-model-port.ts';

const native='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const expectedBinarySha256='50ac633af64851511f9bbc71032cdae7f1ba20b3234c189687d61ba846c354c5';
const sourceBase=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDiff=execFileSync('git',['diff','HEAD','--','src'],{encoding:'utf8'});
const sourceDiffSha256=createHash('sha256').update(sourceDiff).digest('hex');
writeFileSync(`${import.meta.dir}/tested-source-diff.json`,JSON.stringify({rawText:sourceDiff,rawSha256:sourceDiffSha256},null,2)+"\n");
const report: Record<string,unknown>={scope:'Production ModelPort synthetic readiness, no pilot/market',sourceBase,sourceDiffSha256,binarySha256:expectedBinarySha256,model:'gpt-6-sol',reasoningEffort:'medium',startedAt:new Date().toISOString()};
try{
 const port=new CodexExecModelPort({binaryPath:native,expectedBinarySha256,workRoot:import.meta.dir,timeoutMs:60_000,reasoningEffort:'medium'});
 const result=await port.invoke({messages:[new HumanMessage('This is a synthetic compatibility check. Return EXP001_READY as the final answer content.')],tools:[],model:'gpt-6-sol'});
 report.status='completed';report.exactExpectedContent=result.response.content==='EXP001_READY';report.usage=result.usage??null;report.usageStatus=result.usage?'observed':'unavailable';report.metadata=result.response.response_metadata;
 process.exitCode=report.exactExpectedContent && result.usage ? 0:1;
}catch(error){report.status='failed';report.failureKind=error instanceof CodexModelPortError?error.kind:'unknown';report.failureMessage=error instanceof Error?error.message:'unknown';report.usage=null;report.usageStatus='unavailable';process.exitCode=1;}
report.finishedAt=new Date().toISOString();
report.binaryDigestStillMatches=createHash('sha256').update(readFileSync(native)).digest('hex')===expectedBinarySha256;
writeFileSync(`${import.meta.dir}/production-modelport.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
