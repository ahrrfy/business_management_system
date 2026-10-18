// Split the finite laboratory DDL/fixture scripts. Keep quoted semicolons and
// complete trigger bodies together; D1.exec splits at newlines inside CHECKs.
function completeTrigger(sql){
 let visible='',quoted='';
 for(let i=0;i<sql.length;i++){const c=sql[i];if(quoted){if(c===quoted){if(sql[i+1]===quoted)i++;else quoted='';}continue;}if(c==="'"||c==='"'||c==='`'){quoted=c;visible+=' ';}else visible+=c;}
 let depth=0;for(const token of visible.match(/\b(?:BEGIN|CASE|END)\b/gi)??[])depth+=token.toUpperCase()==='END'?-1:1;
 return depth===0&&/\bEND\s*$/i.test(visible);
}
export function sqlStatements(source){
 const result=[];let current='',quote='',comment=false;
 for(let i=0;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(comment){if(c==='\n'){comment=false;current+='\n';}continue;}
  if(quote){current+=c;if(c===quote){if(next===quote){current+=next;i++;}else quote='';}continue;}
  if(c==='-'&&next==='-'){comment=true;i++;continue;}
  if(c==="'"||c==='"'||c==='`'){quote=c;current+=c;continue;}
  if(c===';'){
   if(/^\s*CREATE\s+TRIGGER\b/i.test(current)&&!completeTrigger(current)){current+=c;continue;}
   if(current.trim())result.push(current.trim());current='';continue;
  }
  current+=c;
 }
 if(quote)throw Error('Unclosed SQL fixture quote');
 if(current.trim())result.push(current.trim());
 return result;
}
