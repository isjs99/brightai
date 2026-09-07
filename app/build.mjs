import fs from 'fs';
const dir=new URL('.',import.meta.url).pathname;
const files=['a','b','c'].map(k=>dir+'data/cruva-'+k+'.json').filter(f=>fs.existsSync(f));
const shops=files.flatMap(f=>JSON.parse(fs.readFileSync(f,'utf8')).shops||[]);
const data={generated:'2026-09-07',range:['2026-08-08','2026-09-06'],shops};
const tpl=fs.readFileSync(dir+'src/app.html','utf8');
const json=JSON.stringify(data).replace(/<\/script/gi,'<\\/script');
fs.writeFileSync(dir+'index.html',tpl.replace('/*__CRUVA__*/null',json));
console.log('built index.html with',shops.length,'shops,',(fs.statSync(dir+'index.html').size/1024).toFixed(0)+'KB');
