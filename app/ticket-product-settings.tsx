"use client";
import {useState,type FormEvent} from 'react';
import {t} from '@/lib/client-language';
import type {TicketDevelopmentProduct,TicketRepository} from '@/lib/ticket-automation';
type Props={products:TicketDevelopmentProduct[];canManage:boolean;busy:boolean;onSave:(p:Record<string,unknown>)=>Promise<{products?:TicketDevelopmentProduct[]}|null>};
export default function TicketProductSettings({products,canManage,busy,onSave}:Props) {
  const [selected,setSelected]=useState('');
  const product=products.find(p=>p.id===selected);
  return <><h2>{t('제품·저장소')}</h2><p>{t('제품별 기본 명세와 개발 환경을 설정하면 연결 문구와 모든 개발 작업에 반영됩니다.')}</p>
    <div className="ticket-fields"><label>{t('제품')}<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{t('새 제품')}</option>{products.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label></div>
    <ProductEditor key={`${product?.id||'new'}:${product?.revision||0}`} value={product} disabled={!canManage||busy} onSave={async p=>{const result=await onSave(p);if(result?.products){const saved=result.products.find(v=>v.name===p.name);if(saved)setSelected(saved.id);}}}/>
  </>;
}
function ProductEditor({value,disabled,onSave}:{value?:TicketDevelopmentProduct;disabled:boolean;onSave:(p:Record<string,unknown>)=>Promise<void>}) {
  const [name,setName]=useState(value?.name||''),[specification,setSpecification]=useState(value?.specification||''),[setup,setSetup]=useState(value?.setup_instructions||'');
  const [repositories,setRepositories]=useState<TicketRepository[]>(value?JSON.parse(value.repositories_json):[{id:'',name:'',remote:''}]);
  const update=(index:number,p:Partial<TicketRepository>)=>setRepositories(values=>values.map((v,i)=>i===index?{...v,...p}:v));
  async function save(e:FormEvent){e.preventDefault();await onSave({operation:'product',id:value?.id,revision:value?.revision,name,specification,setupInstructions:setup,repositories});}
  return <form onSubmit={save}><fieldset disabled={disabled}><label>{t('제품명')}<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
    <label>{t('기본 명세')}<textarea required maxLength={16000} rows={9} value={specification} onChange={e=>setSpecification(e.target.value)}/></label><p>{t('목적, 주요 기능, 용어, 제약과 검증 기준을 적어 주세요. 비밀번호와 토큰은 넣지 마세요.')}</p>
    <label>{t('개발 환경 준비 지침')}<textarea maxLength={8000} rows={6} value={setup} onChange={e=>setSetup(e.target.value)}/></label><p>{t('필요한 런타임·도구·설정은 처음 연결할 때 준비합니다. 고객 요청이 PC 보안 설정을 바꿀 수는 없습니다.')}</p>
    <h3>{t('Git 저장소')}</h3>{repositories.map((repo,index)=><div className="ticket-fields" key={repo.id||index}><label>{t('저장소 이름')}<input required value={repo.name} onChange={e=>update(index,{name:e.target.value})}/></label><label>{t('저장소 HTTPS 주소')}<input type="url" required value={repo.remote} onChange={e=>update(index,{remote:e.target.value})}/></label><label>{t('의존성 준비 경로')}<input value={(repo.installRoots||['.']).join(',')} onChange={e=>update(index,{installRoots:e.target.value.split(',').map(v=>v.trim())})}/></label>{repositories.length>1&&<button type="button" className="secondary" onClick={()=>setRepositories(v=>v.filter((_,i)=>i!==index))}>{t('제외')}</button>}</div>)}
    <div className="ticket-fields"><button className="secondary" type="button" disabled={repositories.length>=10} onClick={()=>setRepositories(v=>[...v,{id:'',name:'',remote:''}])}>{t('저장소 추가')}</button><button className="primary-action" disabled={!name.trim()||!specification.trim()}>{t('제품 설정 저장')}</button></div>
  </fieldset></form>;
}
