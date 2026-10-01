const fs=require('fs'),path=require('path'),solc=require('solc');
const sources=Object.fromEntries(['TaskEscrow','MockUSDC'].map(n=>[n+'.sol',{content:fs.readFileSync(path.join(__dirname,n+'.sol'),'utf8')}]))
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input),{import:n=>({contents:fs.readFileSync(require.resolve(n),'utf8')})}));
for(const e of output.errors||[])if(e.severity==='error')throw Error(e.formattedMessage);
for(const n of ['TaskEscrow','MockUSDC']){
 const p=n==='TaskEscrow'?path.join(__dirname,'../../src/envarpay/tasks/escrow.json'):path.join(__dirname,'MockUSDC.json');
 fs.writeFileSync(p,JSON.stringify({compiler:solc.version(),...output.contracts[n+'.sol'][n]},null,2)+'\n');
}
