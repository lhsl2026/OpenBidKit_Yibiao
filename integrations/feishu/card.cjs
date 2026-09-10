const escapeText=value=>String(value??'').slice(0,1200).replace(/[&<>*_[\]()`#~]/g,c=>`&#${c.charCodeAt(0)};`);
const md=text=>({tag:'markdown',content:text});
const group=(elements,color='grey-50')=>({tag:'column_set',flex_mode:'none',background_style:color,columns:[{tag:'column',width:'weighted',weight:1,padding:'8px',elements}]});
const label={follow:'建议跟进',review:'暂缓，待核实',reject:'不建议投标'};
const human={follow:'已确认跟进',defer:'暂缓',decline:'不投'};
const {fieldLabel}=require('./handoff-fields.cjs');
function explain(code,assessment){const labels=require('./assessment.cjs').ASSESSMENT_LABELS??{};const parts=String(code).split(':');const label=labels[parts.at(-1)]??labels[code]??'该项需要人工核实';const item=assessment.items?.find(i=>i.requirementId===parts[0]);return(item?item.key+'：':'')+label;}
function baseCard(title,template,elements){return{schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},header:{title:{tag:'plain_text',content:title.slice(0,120)},template},body:{direction:'vertical',vertical_spacing:'12px',padding:'12px',elements}};}
function buildCard(p,writing,page=0){
  const h=p.input.handoff,a=p.assessment,decision=a.decision;const cardKey=require('./store.cjs').key(p.input,p.assessment);
  const button=(action,text,type='default',disabled=false)=>({tag:'button',type,text:{tag:'plain_text',content:text},disabled,behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action}}]});
  const facts=(h.requirements??[]).filter(r=>r.category==='basic').filter(r=>/预算|限价|评标|评审|截止/.test(fieldLabel(r))).slice(0,4).map(r=>`${escapeText(fieldLabel(r))}：${escapeText(r.value)}（${escapeText(r.coordinate)}）`);
  const requirements=h.requirements??[];const pageCount=Math.max(1,Math.ceil(requirements.length/4));page=Math.max(0,Math.min(pageCount-1,Number.isInteger(page)?page:0));
  const clauses=requirements.slice(page*4,page*4+4).map(r=>`${escapeText(fieldLabel(r))}：${escapeText(String(r.value??'').slice(0,900))}${String(r.value??'').length>900?'…（长条款请核对原件）':''}\n来源：${escapeText(r.coordinate||'待核实')}`);
  const pagination=pageCount>1?[{tag:'button',text:{tag:'plain_text',content:'上一页条款'},disabled:page===0,behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action:'page',page:page-1}}]},{tag:'button',text:{tag:'plain_text',content:'下一页条款'},disabled:page===pageCount-1,behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action:'page',page:page+1}}]}]:[];
  const links=[];for(const [name,url] of [['预读报告',p.input.reportUrl],['招标原文件',p.input.sourceUrl]]){try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password)links.push({tag:'button',text:{tag:'plain_text',content:name},behaviors:[{type:'open_url',default_url:u.href}]});}catch{}}
  const writingText=writing?`\n编写进度：${escapeText(({queued:'排队中',running:'处理中',not_ready:'配置未就绪',waiting_confirmation:'等待确认',completed:'初稿已生成',failed:'失败，待处理',interrupted:'上次运行中断，请核对后重试',cancelled:'已取消'})[writing.status]??writing.status)}`:'';
  const writingElements=[];const c=writing?.result?.confirmation;
  if(writing?.status==='waiting_confirmation'&&c){
    const titles={outline_selection:'请确认采用建议的章节范围',outline:'请确认目录后生成正文',global_facts:'请核对事实清单；缺失信息将保留待补占位，不代表已核实',source_file:'缺少完整招标原文件，请由接入管理员补充',content_decision:'部分正文小节未完成，请查看清单后重试'};
    writingElements.push(md(`**${titles[c.type]??'需要人工确认'}**\n完整清单以群内附件为准。`));
    if(c.challenge&&['outline_selection','outline','global_facts','content_decision'].includes(c.type))writingElements.push({tag:'button',type:'primary_filled',disabled:!writing.previewDelivered,text:{tag:'plain_text',content:c.type==='global_facts'?'保留待补项，继续生成':c.type==='content_decision'?'重试失败小节':'确认以上内容并继续'},behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action:'continue',challenge:c.challenge}}]});
  }
  if(['failed','not_ready','interrupted'].includes(writing?.status))writingElements.push(button('retry','修复配置后重试'));
  return baseCard(`${label[decision]??label.review} · ${h.task.title}`,decision==='follow'?'green':decision==='reject'?'red':'orange',[
    group([md(`**${escapeText(h.task.title)}**\n判标主体：${escapeText(p.companyId)}\n投标截止：${escapeText(p.input.deadline||'未核实')}\n${facts.join('\n')}`)]),
    group([md(`**预读条款摘录 · 第 ${page+1}/${pageCount} 页**\n${clauses.join('\n\n')||'尚无可引用条款，需要完整文件预读。'}\n\n**关键阻塞**\n${(a.blockers.length?a.blockers.map(v=>explain(v,a)):['未发现已核实的硬门槛阻塞，仍需人工决定']).slice(0,5).map(v=>'• '+escapeText(v)).join('\n')}\n\n**下一步动作**\n${(a.actions.length?a.actions.map(v=>explain(v,a)):['查看原文及材料后确认是否跟进']).slice(0,5).map(v=>'• '+escapeText(v)).join('\n')}`),...pagination],decision==='follow'?'green-50':decision==='reject'?'red-50':'orange-50'),
    group([md(`处理决定：${human[p.humanDecision]??'等待员工判断'}${writingText}\n文件版本：${escapeText(p.version)}；结论含待核实项时，不能视为已具备投标资格。`),...links]),
    group([button('follow','确认跟进','primary_filled'),button('defer','暂缓'),button('decline','不投','danger'),button('write','生成标书初稿','default',p.humanDecision!=='follow'||decision!=='follow'),...writingElements])
  ]);
}
function buildSummary(day,projects,watches=0){const rows=[['新增标讯',projects.filter(p=>new Date(p.created+8*3600000).toISOString().slice(0,10)===day).length],['已预读',projects.length],['待补件或核实',projects.filter(p=>p.assessment.decision==='review').length+watches],['待决策',projects.filter(p=>!p.humanDecision).length],['临近截止',projects.filter(p=>{const n=Date.parse(p.input.deadline)-Date.parse(day+'T00:00:00+08:00');return n>=0&&n<3*86400000;}).length]];return baseCard(`判标日报 · ${day}`,'blue',[group(rows.map(([k,v])=>md(`**${k}**　${v}`)),'blue-50'),md('请在对应项目卡片确认跟进、暂缓或不投。未核实资料不计为已满足。')]);}
module.exports={buildCard,buildSummary,escapeText};
