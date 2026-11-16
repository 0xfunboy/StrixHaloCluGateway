import { startRunner } from './runner.ts';
startRunner().catch(error=>{
  process.stdout.write(JSON.stringify({type:'error',error:error instanceof Error?error.message:'Runner failed.'})+'\n',()=>process.exit(1));
});
