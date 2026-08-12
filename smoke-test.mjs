const base=(process.argv[2]||'http://localhost:3000').replace(/\\+$/,'');
let failed=false;
for (const path of ['/health','/api','/files']) {
  try {
    const r=await fetch(base+path);
    const t=await r.text();
    console.log(`GET ${path} -> ${r.status} ${t.slice(0,200)}`);
    if(!r.ok) failed=true;
  } catch(e) { console.error(`GET ${path} -> FAILED ${e.message}`); failed=true; }
}
process.exit(failed?1:0);
