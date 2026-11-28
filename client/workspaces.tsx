import { useState, type FormEvent } from 'react';
import { api } from './api';
import { useFormAction, useLoad } from './lib';
import { Button, ErrorNote, Field, Loading, Sheet } from './ui';

export type Place = {
  id: number; code: string; name: string; kind: 'CAMPUS' | 'RETAIL'; status: 'ACTIVE' | 'PAUSED'; timezone: string;
  contact_name?: string; contact_phone?: string; contract_from?: string; contract_until?: string; monthly_value?: number; notes?: string;
  students?: number; unclaimed?: number; staff_count?: number; today_orders?: number;
};
export const officeScopes: Place[] = [
  { id:-1, code:'ALL', name:'All business', kind:'CAMPUS', status:'ACTIVE', timezone:'Asia/Kolkata' },
  { id:-2, code:'CAMPUSES', name:'All campuses', kind:'CAMPUS', status:'ACTIVE', timezone:'Asia/Kolkata' },
];
export const officeLink = (place: Place, page='') => '#/w/' + place.code + '/' + page;

export function ScopePicker({ places, selected, change, specific=false }: {places:Place[]; selected:Place; change:(w:Place)=>void; specific?:boolean}) {
  const [filter,setFilter] = useState('');
  const campuses = places.filter(w => w.kind==='CAMPUS');
  return <div className="scope-picker">
    {campuses.length>6 && <input aria-label="Find campus" type="search" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Find campus" />}
    <select aria-label="Office workspace" value={selected.id} onChange={e=>{
      const next=[...officeScopes,...places].find(w=>String(w.id)===e.target.value);
      if(next) change(next);
    }}>
      {specific && <option value={selected.id} disabled>Choose a workspace</option>}
      {!specific && <optgroup label="Business">{officeScopes.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>}
      <optgroup label="Campuses">{campuses.filter(w=>w.id===selected.id || w.name.toLowerCase().includes(filter.toLowerCase())).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>
      <optgroup label="B2C">{places.filter(w=>w.kind==='RETAIL').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>
    </select>
  </div>;
}

export function Campuses({ onChanged }: {onChanged:()=>void}) {
  const list=useLoad(()=>api<{rows:Place[]}>('/admin/workspaces'),[]);
  const [edit,setEdit]=useState<Place | 'new' | null>(null);
  if(!list.data) return list.error ? <ErrorNote error={list.error} retry={list.reload}/> : <Loading/>;
  return <div className="stack">
    <div><Button tone="primary" icon="plus" onClick={()=>setEdit('new')}>Add campus</Button></div>
    {list.data.rows.map(w=><section className="ad-card" key={w.id}>
      <div className="row-between"><h2><a href={officeLink(w)}>{w.name}</a></h2><Button size="sm" onClick={()=>setEdit(w)}>Edit</Button></div>
      <p>{w.code} · {w.status==='ACTIVE'?'Active':'Paused'} · {w.timezone}</p>
      <div className="workspace-facts">
        {w.kind==='CAMPUS' && <><span>{w.students} students</span><span>{Number(w.students)-Number(w.unclaimed)} claimed</span><span>{w.unclaimed} unclaimed</span></>}
        <span>{w.today_orders} orders today</span><span>{w.staff_count} staff assigned</span>
      </div>
    </section>)}
    {edit && <CampusForm place={edit==='new'?undefined:edit} places={list.data.rows} close={()=>setEdit(null)} done={async w=>{
      setEdit(null); await list.reload(); onChanged(); if(w) window.location.hash=officeLink(w);
    }}/>}
  </div>;
}

function CampusForm({place,places,close,done}:{place?:Place; places:Place[]; close:()=>void; done:(w?:Place)=>void}) {
  const [step,setStep]=useState(0);
  const [draft,setDraft]=useState({name:place?.name||'',code:place?.code||'',timezone:place?.timezone||'Asia/Kolkata',status:place?.status||'ACTIVE',
    contact_name:place?.contact_name||'',contact_phone:place?.contact_phone||'',contract_from:place?.contract_from||'',contract_until:place?.contract_until||'',
    monthly_value:place?.monthly_value?.toString()||'',notes:place?.notes||'',copy_from:1,hostels:''});
  const {busy,error,submit}=useFormAction();
  const input=(key:'name'|'code'|'timezone'|'contact_name'|'contact_phone'|'contract_from'|'contract_until'|'monthly_value',label:string,type='text',required=false)=>
    <Field label={label}><input type={type} value={draft[key]} required={required} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></Field>;
  const last=place?1:2;
  async function save(e:FormEvent) {
    e.preventDefault(); if(step<last){setStep(step+1);return;}
    const body={...draft,monthly_value:draft.monthly_value===''?null:Number(draft.monthly_value),hostels:Array.from(new Set(draft.hostels.split('\n').map(x=>x.trim()).filter(Boolean)))};
    const result=await submit(()=>api<{id?:number}>(place?'/admin/workspaces/'+place.id:'/admin/workspaces',{method:place?'PATCH':'POST',body}),place?'Workspace saved':'Campus created');
    if(result) done(place?undefined:{...draft,id:result.id!,kind:'CAMPUS',code:draft.code.trim().toUpperCase(),monthly_value:body.monthly_value??undefined});
  }
  return <Sheet title={place?'Edit '+place.name:'Add campus'} onClose={close}><form className="stack" onSubmit={save}>
    <h2>{['Workspace details','Contact and contract','Copy settings and add hostels'][step]}</h2>
    {step===0 && <>{input('name','Display name','text',true)}{input('code','Short code','text',true)}{input('timezone','Timezone','text',true)}
      <Field label="Status"><select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value as Place['status']})}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></select></Field></>}
    {step===1 && <>{input('contact_name','Contact person')}{input('contact_phone','Contact phone','tel')}
      {place?.kind!=='RETAIL' && <>{input('contract_from','Contract starts','date')}{input('contract_until','Contract ends','date')}{input('monthly_value','Monthly contract value (₹)','number')}</>}
      <Field label="Notes"><textarea value={draft.notes} onChange={e=>setDraft({...draft,notes:e.target.value})}/></Field></>}
    {step===2 && <><Field label="Copy rules and prices from"><select value={draft.copy_from} onChange={e=>setDraft({...draft,copy_from:Number(e.target.value)})}>
      {places.filter(w=>w.kind==='CAMPUS').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
      <Field label="Hostels, one per line"><textarea value={draft.hostels} onChange={e=>setDraft({...draft,hostels:e.target.value})}/></Field></>}
    {error && <ErrorNote error={error}/>}
    <div className="field-row">{step>0 && <Button type="button" onClick={()=>setStep(step-1)}>Back</Button>}<Button type="submit" tone="primary" busy={busy}>{step<last?'Next':place?'Save':'Create campus'}</Button></div>
  </form></Sheet>;
}
