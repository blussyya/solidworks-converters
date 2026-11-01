#!/usr/bin/env node
'use strict';
/* npm run setup — optional extras. Never runs on install.
 *
 * The converter and `sldprt inspect` need nothing beyond Node. The only optional extra is the
 * validation suite (tools/validate.js, tools/validate-step.py), which loads our STEP output into
 * OpenCascade and checks it. That needs one Python package: cadquery-ocp (the OCP bindings).
 *
 *   npm run setup            asks
 *   npm run setup -- --yes   install without asking
 *   npm run setup -- --no    skip without asking
 */
const readline=require('readline'),{spawnSync}=require('child_process');

const PACKAGE='cadquery-ocp';
const argv=process.argv.slice(2);

function ask(q){
  return new Promise(resolve=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    let answered=false;
    rl.question(q,a=>{answered=true;rl.close();resolve(a);});
    rl.on('close',()=>{if(!answered)resolve('');});   // no terminal / EOF: the default, which is no
  });
}
function run(cmd,args){return spawnSync(cmd,args,{stdio:'inherit'});}
function find(cmds,probe){for(const c of cmds){const r=spawnSync(c,probe,{stdio:'ignore'});if(!r.error&&r.status===0)return c;}return null;}

function coreOnly(){
  console.log('\nSkipped. The core converter and `sldprt inspect` work as they are (Node only).');
  console.log('Run `npm run setup` again any time to add the validation suite.');
}

function afterInstall(py){
  const ok=spawnSync(py,['-c','import OCP'],{stdio:'ignore'}).status===0;
  console.log('\nWhat is available now:');
  console.log('  sldprt convert / info / brep / serve / inspect   (Node, as before)');
  if(ok){
    console.log('  node tools/validate.js --python '+py+' [filter]  STEP output checked with OpenCascade');
    console.log('  tools/validate-step.py                           the checker it drives (JSON lines on stdin)');
    console.log('\n  validate.js looks for its Python in ../kz-build/venv-sldprt unless you pass --python or set SLDPRT_OCP_PYTHON.');
  }else{
    console.log('  the validation suite is NOT ready: `import OCP` still fails with '+py+'.');
    console.log('  Try: '+py+' -m pip install --user '+PACKAGE+'   and read the error it prints.');
  }
}

async function main(){
  let yes;
  if(argv.includes('--yes')||argv.includes('-y'))yes=true;
  else if(argv.includes('--no'))yes=false;
  else{
    console.log('sldprt optional setup\n');
    console.log('The converter and `sldprt inspect` need only Node and are ready now.');
    console.log('The validation suite re-opens our STEP files in OpenCascade to check them. It needs one');
    console.log('Python package ('+PACKAGE+'), used by tools/validate.js and tools/validate-step.py.\n');
    yes=/^y(es)?$/i.test((await ask('Do you want the full validation suite? (y/N) ')).trim());
  }
  if(!yes)return coreOnly();

  const py=find(process.platform==='win32'?['python','py']:['python3','python'],['--version']);
  if(!py){
    console.log('\nNo Python found on PATH (tried python3 and python). Install Python 3 from https://www.python.org/,');
    console.log('then run `npm run setup` again. Nothing was changed; the core converter and `sldprt inspect` still work.');
    process.exitCode=1;return;
  }
  if(spawnSync(py,['-m','pip','--version'],{stdio:'ignore'}).status!==0){
    console.log('\nPython is there ('+py+') but pip is not. Either:');
    console.log('  '+py+' -m ensurepip --user      (then run `npm run setup` again), or');
    console.log('  install pip with your system package manager (for example `apt install python3-pip`).');
    console.log('Nothing was changed; the core converter and `sldprt inspect` still work.');
    process.exitCode=1;return;
  }
  const cmd=[py,'-m','pip','install','--user',PACKAGE];
  console.log('\nRunning: '+cmd.join(' ')+'\n');
  const r=run(cmd[0],cmd.slice(1));
  if(r.status!==0){
    console.log('\npip failed (exit '+r.status+'). Common causes: no network, or an "externally managed" Python.');
    console.log('In that case use a virtual environment instead:');
    console.log('  python3 -m venv venv && venv/bin/pip install '+PACKAGE);
    console.log('  node tools/validate.js --python venv/bin/python');
    console.log('The core converter and `sldprt inspect` still work.');
    process.exitCode=1;return;
  }
  afterInstall(py);
}
main();
