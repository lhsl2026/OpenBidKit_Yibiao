const basicLabels = new Map(Object.entries({projectName:'项目名称',tenderCode:'采购/招标编号',projectCode:'交易项目编号',platformProjectCode:'交易项目编号',ownerName:'招标人',agencyName:'招标代理',location:'实施地点',scope:'采购范围',projectScale:'采购范围/项目规模',budget:'预算/最高限价',budgetOrCeiling:'预算/最高限价',maximumPrice:'最高限价',duration:'工期/服务期',bidDeadline:'投标截止',openingTime:'开标时间',tenderMethod:'采购方式',evaluationMethod:'评审办法'}));
function fieldLabel(r){const name=String(r.id??'').replace(/^basic:/,'');return r.category==='basic'&&basicLabels.has(name)?basicLabels.get(name):r.key;}
function isDeadline(r){return r.category==='basic'&&r.id==='basic:bidDeadline'||/投标截止|递交.*截止/.test(r.key);}
function parseDeadline(value){
 value=String(value??'').trim();let iso=value;
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(iso)){
  const m=value.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s+(\d{1,2})(?:[:：](\d{2})(?::(\d{2}))?|时(\d{2})分(?:(\d{2})秒)?)$/);
  if(!m)return '';iso=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]??m[7]}:${m[6]??m[8]??'00'}+08:00`;
 }
 const parts=iso.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
 const [year,month,day,hour,minute,second]=parts.slice(1).map(v=>Number(v??0));
 const date=new Date(Date.UTC(year,month-1,day));
 return Number.isFinite(Date.parse(iso))&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day&&hour<24&&minute<60&&second<60?iso:'';
}
function deadlineFrom(h){
 const rows=(h.requirements??[]).filter(isDeadline);if(!rows.length||rows.some(r=>r.requiresConfirmation!==false||!Number.isFinite(r.confidence)||r.confidence<0.8||r.confidence>1))return '';
 const values=rows.map(r=>parseDeadline(r.value));return values.every(Boolean)&&new Set(values.map(Date.parse)).size===1?values[0]:'';
}
function resolveDeadline(input,previous={}){
 if((input.handoff.requirements??[]).some(isDeadline))return deadlineFrom(input.handoff);
 const sameReport=JSON.stringify(input.handoff.snapshot)===JSON.stringify(previous.handoff?.snapshot);
 return input.deadline??(sameReport?previous.deadline:undefined)??'';
}
module.exports={fieldLabel,deadlineFrom,resolveDeadline};
