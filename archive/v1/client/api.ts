export type Session = { token:string; user:{id:number;name:string;role:'ADMIN'|'STAFF'|'STUDENT';permissions:string[];studentId?:number} };
export async function api<T>(path:string, session?:Session|null, options:RequestInit={}) : Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  if (session?.token) headers.set('Authorization',`Bearer ${session.token}`);
  const res=await fetch(`/api${path}`,{...options,headers});
  if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(data.error||'Request failed.');}
  const type=res.headers.get('content-type')||''; return (type.includes('application/json')?res.json():res.blob()) as Promise<T>;
}
export function money(value:unknown){return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(value||0));}
export function date(value:unknown){return value?new Date(String(value)).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';}
