export function conditionMatches(cond:Record<string,unknown>|undefined,attrs:Record<string,unknown>):boolean {
  if(!cond || Object.keys(cond).length===0) return true;
  if(Array.isArray(cond.any)) {
    return cond.any.some(k=>{
      const key=String(k).replace(/^attributes\./,"");
      return Boolean(attrs[key]);
    });
  }
  for(const [rawKey,expected] of Object.entries(cond)) {
    const key=rawKey.replace(/^attributes\./,"");
    if(attrs[key]!==expected) return false;
  }
  return true;
}
