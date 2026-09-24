const escapeText=value=>String(value??'').slice(0,1200).replace(/[&<>*_[\]()`#~]/g,c=>`&#${c.charCodeAt(0)};`);
const md=text=>({tag:'markdown',content:text});
const bullet=values=>values.map(value=>'• '+escapeText(value)).join('\n');
const group=(elements,color='grey-50')=>({tag:'column_set',flex_mode:'none',background_style:color,columns:[{tag:'column',width:'weighted',weight:1,padding:'8px',elements}]});
const label={follow:'建议跟进',review:'暂缓，待核实',reject:'不建议投标'};
const human={follow:'已确认跟进',defer:'暂缓',decline:'不投'};
const {buildDecisionBrief}=require('./decision-brief.cjs');
const {canGenerateDraft,canGenerateReviewedDraft}=require('./writing-policy.cjs');
const {cardAction}=require('./card-actions.cjs');
const writingPortalBehavior=bidType=>({type:'open_url',default_url:'https://yibiao.pro',pc_url:`yibiao://new-bid${bidType?`?type=${bidType}`:''}`});
const writingPortalFeedback=()=>({
  hover_tips:{tag:'plain_text',content:'将打开联智标客户端，首次启动约需 5 秒'},
  confirm:{title:{tag:'plain_text',content:'打开联智标客户端'},text:{tag:'plain_text',content:'首次启动约需 5 秒；若窗口未到前台，请查看任务栏。'}},
});
const writingPortalButton=()=>({tag:'button',type:'default',text:{tag:'plain_text',content:'生成其他标书'},behaviors:[writingPortalBehavior()],...writingPortalFeedback()});
const companyMarker=identity=>'company-match:'+Buffer.from(JSON.stringify(identity)).toString('base64url');
function companyMatchGroup(p,cardKey,review){
 const state=p.input?.companyMatchCard,audit=p.input?.handoff?.companyMatch;
 const companies=Array.isArray(state?.companies)?state.companies.filter(company=>company?.enabled!==false&&company?.companyId&&company?.companyName&&company?.profileVersion):[];
 if(!state||!companies.length||!p.messageId)return null;
 const selected=companies.find(company=>company.companyId===state.selectedCompanyId)??(companies.length===1?companies[0]:null);
 const base={projectId:p.id,version:p.version,cardKey,taskId:state.taskId,runId:state.runId,documentVersion:state.documentVersion,scopeType:state.scopeType,scopeId:state.scopeId,sourceCardMessageId:p.messageId};
 const counts=audit?.counts??{};
 const summary=`**🏢 匹配公司**\n当前公司：${escapeText(selected?.companyName??'待选择')}\n档案版本：${escapeText(selected?.profileVersion??'待选择')}\n同步状态：${audit?.syncStatus==='synced'?'已同步':'待核验'}；资格匹配 ${Number(counts.profileEvidenceSatisfied??0)+Number(counts.humanConfirmedCurrent??0)+Number(counts.humanConfirmedReused??0)}/${Number(audit?.qualificationCount??0)}；待核验 ${Number(counts.pendingReview??0)}；明确缺口 ${Number(counts.gaps??0)}`;
 const elements=[md(summary)];
 if(companies.length>1){
  const options=companies.map(company=>({text:{tag:'plain_text',content:String(company.companyName).slice(0,100)},value:companyMarker({...base,companyId:company.companyId,companyProfileVersion:company.profileVersion})}));
  const selector={tag:'select_static',name:'selected_company',required:true,width:'fill',placeholder:{tag:'plain_text',content:'选择匹配公司'},options,...(selected?{initial_option:options.find(option=>option.value===companyMarker({...base,companyId:selected.companyId,companyProfileVersion:selected.profileVersion}))}:{})};
  elements.push({tag:'form',name:'company_match_form',direction:'vertical',vertical_spacing:'8px',elements:[selector,{tag:'button',name:'company_match.select',text:{tag:'plain_text',content:'确认匹配公司'},type:'primary_filled',width:'fill',form_action_type:'submit'}]});
 }
 const currentReview=review?.taskId===state.taskId&&review?.runId===state.runId&&review?.companyId===selected?.companyId&&review?.companyProfileVersion===selected?.profileVersion?review:null;
 if(currentReview){
  const status={confirmed_met:'🟢 已核验',gap:'🔴 明确缺口',not_applicable:'⚪ 不适用',unconfirmed:'🟠 待核验',company_profile_missing:'🟠 待核验',pending_manual_confirmation:'🟠 待核验',pending_match:'🟠 待核验'};
  const ordered=[...(currentReview.items??[])].sort((a,b)=>({gap:0,unconfirmed:1,company_profile_missing:1,pending_manual_confirmation:1,pending_match:1,confirmed_met:2,not_applicable:3}[a.matchStatus]??4)-({gap:0,unconfirmed:1,company_profile_missing:1,pending_manual_confirmation:1,pending_match:1,confirmed_met:2,not_applicable:3}[b.matchStatus]??4)).slice(0,6);
  const rows=ordered.map(item=>`${status[item.matchStatus]??'🟠 待核验'}｜${item.requirement}${item.page?`（第${item.page}页）`:''}${item.evidenceRequirement?`\n材料：${item.evidenceRequirement}`:''}`);
  elements.push(md(`**公司匹配复核**\n已核验 ${Number(currentReview.counts?.confirmed??0)}；待核验 ${Number(currentReview.counts?.pending??0)}；明确缺口 ${Number(currentReview.counts?.gaps??0)}；不适用 ${Number(currentReview.counts?.notApplicable??0)}\n\n${bullet(rows)}${(currentReview.items?.length??0)>ordered.length?'\n• 其余项目请在预读报告中查看。':''}`));
 }
 if(selected)elements.push({tag:'button',type:currentReview?'primary_filled':'default',text:{tag:'plain_text',content:currentReview?'刷新公司匹配复核':'查看公司匹配复核'},behaviors:[{type:'callback',value:cardAction('company_match.review',{...base,companyId:selected.companyId,companyProfileVersion:selected.profileVersion})}]});
 return group(elements,audit?.syncStatus==='synced'?'blue-50':'orange-50');
}
function baseCard(title,template,elements){return{schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},header:{title:{tag:'plain_text',content:title.slice(0,120)},template},body:{direction:'vertical',vertical_spacing:'12px',padding:'12px',elements}};}
function buildCard(p,writing,page=0,options={}){
  const h=p.input.handoff,a=p.assessment,decision=a.decision;const cardKey=require('./store.cjs').key(p.input,p.assessment);
  const actionNames={follow:'company_match.follow',defer:'company_match.defer',decline:'company_match.decline',write:'writing.start',continue:'writing.continue',retry:'writing.retry'};
  const button=(action,text,type='default',disabled=false,width)=>({tag:'button',type,text:{tag:'plain_text',content:text},disabled,...(width?{width}:{}),behaviors:[{type:'callback',value:cardAction(actionNames[action],{projectId:p.id,version:p.version,cardKey})}]});
  const brief=buildDecisionBrief(p,options);
  const links=[];for(const [name,url] of [['预读报告',p.input.reportUrl],['招标原文件',p.input.sourceUrl]]){try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password)links.push({tag:'button',text:{tag:'plain_text',content:name},behaviors:[{type:'open_url',default_url:u.href}]});}catch{}}
  const writingText=writing?`\n编写进度：${escapeText(({queued:'排队中',running:'处理中',not_ready:'配置未就绪',waiting_confirmation:'等待确认',completed:'初稿已生成',failed:'失败，待处理',interrupted:'上次运行中断，请核对后重试',cancelled:'已取消'})[writing.status]??writing.status)}`:'';
  const writingElements=[];const c=writing?.result?.confirmation;
  if(writing?.status==='waiting_confirmation'&&c){
    const titles={outline_selection:'请确认采用建议的章节范围',outline:'请确认目录后生成正文',global_facts:'请核对事实清单；缺失信息将保留待补占位，不代表已核实',source_file:'缺少完整招标原文件，请由接入管理员补充',content_decision:'部分正文小节未完成，请查看清单后重试'};
    writingElements.push(md(`**${titles[c.type]??'需要人工确认'}**\n完整清单请查看飞书确认文档。`));
    if(c.challenge&&p.input.writingConfirmation?.challenge===c.challenge){try{const u=new URL(p.input.writingConfirmationUrl);if(u.protocol==='https:'&&!u.username&&!u.password)writingElements.push({tag:'button',type:'default',text:{tag:'plain_text',content:'查看确认文档'},behaviors:[{type:'open_url',default_url:u.href}]});}catch{}}
    if(c.challenge&&['outline_selection','outline','global_facts','content_decision'].includes(c.type))writingElements.push({tag:'button',type:'primary_filled',disabled:!writing.confirmationPublished,text:{tag:'plain_text',content:c.type==='global_facts'?'保留待补项，继续生成':c.type==='content_decision'?'重试失败小节':'确认以上内容并继续'},behaviors:[{type:'callback',value:cardAction('writing.continue',{projectId:p.id,version:p.version,cardKey,challenge:c.challenge})}]});
  }
  if(['failed','not_ready','interrupted'].includes(writing?.status)){
    const code=writing?.result?.code;
    if(code==='codex_fact_generation_timeout')writingElements.push(md('**失败阶段：全局事实合并**\n模型生成超时，原文件、目录和人工确认均已保留；调整服务后可重新尝试生成。'));
    const retryLabel=code==='worker_timeout'?'继续生成未完成内容':writing.status==='interrupted'?'继续生成':code==='model_not_configured'?'配置模型后重试':'重新尝试生成';
    writingElements.push(button('retry',retryLabel));
  }
  const now=options.now??Date.now();
  const draftReady=canGenerateDraft(p,now);
  const reviewedDraft=canGenerateReviewedDraft(p,now);
  const needsFollow=p.humanDecision!=='follow';
  const draftLabel=needsFollow?'确认跟进后可生成初稿':reviewedDraft?'复核后生成待补初稿':decision==='review'?'生成待补初稿':'生成标书初稿';
  const draftAction=button('write',draftLabel,reviewedDraft?'primary_filled':'default',!draftReady);
  if(!draftReady)draftAction.disabled_tips={tag:'plain_text',content:needsFollow?'请先点击“确认跟进”，再生成标书初稿':'当前项目尚未满足初稿生成条件，请先处理卡片中的待核实项'};
  else draftAction.confirm={title:{tag:'plain_text',content:'确认生成标书初稿'},text:{tag:'plain_text',content:'提交后卡片将在约 5 秒内刷新为排队中或处理中；生成目录后还需完成人工目录确认，不会自动投标。'}};
  const reviewHelp=reviewedDraft?[md('**🔎 复核处理**\n先打开预读报告核对待核实项；若接受所有未核实内容保留为占位，再点击“复核后生成待补初稿”。系统不会把待核实的资格、参数或证明材料写成已满足。')]:[];
  const decisionStatus=human[p.humanDecision]??'等待员工判断';
  const decisionStyle={follow:['✅','green-50'],defer:['⏸️','orange-50'],decline:['⛔','red-50']}[p.humanDecision]??['🟠','orange-50'];
  const companyGroup=companyMatchGroup(p,cardKey,options.companyMatchReview);
  return baseCard(`${label[decision]??label.review} · ${h.task.title}`,decision==='follow'?'green':decision==='reject'?'red':'orange',[
    group([md(`**${escapeText(brief.title)}**\n判标主体：${escapeText(brief.company)}\n**资格结论：${escapeText(brief.eligibility)}**\n**商务判断：${escapeText(brief.commercial)}**\n投标截止：${escapeText(brief.deadline)}`)],decision==='follow'?'green-50':decision==='reject'?'red-50':'orange-50'),
    group([md(`**一票否决检查**\n🔴 明确不满足 ${brief.gateCounts.notSatisfied}\n🟠 待核验 ${brief.gateCounts.review}\n🟢 已核验满足 ${brief.gateCounts.satisfied}\n\n**关键参数**\n${bullet(brief.facts.map(fact=>`${fact.label}：${fact.value}`))}`)]),
    group([md(`**主要风险**\n${bullet(brief.risks)}\n\n**下一步（最多3项）**\n${bullet(brief.actions)}`)]),
    ...(companyGroup?[companyGroup]:[]),
    group([md(`**📌 处理决定**\n${decisionStyle[0]} **${decisionStatus}**`),button('follow','确认跟进','primary_filled',false,'fill'),button('defer','暂缓','default',false,'fill'),button('decline','不投','danger',false,'fill')],decisionStyle[1]),
    group([md(`**辅助信息**${writingText}\n文件版本：${escapeText(p.version)}；结论含待核实项时，不能视为已具备投标资格。`),...reviewHelp,...links,draftAction,writingPortalButton(),...writingElements])
  ]);
}
function buildSummary(day,projects,watches=0){const rows=[['新增标讯',projects.filter(p=>new Date(p.created+8*3600000).toISOString().slice(0,10)===day).length],['已预读',projects.length],['待补件或核实',projects.filter(p=>p.assessment.decision==='review').length+watches],['待决策',projects.filter(p=>!p.humanDecision).length],['临近截止',projects.filter(p=>{const n=Date.parse(p.input.deadline)-Date.parse(day+'T00:00:00+08:00');return n>=0&&n<3*86400000;}).length]];return baseCard(`判标日报 · ${day}`,'blue',[group(rows.map(([k,v])=>md(`**${k}**　${v}`)),'blue-50'),md('请在对应项目卡片确认跟进、暂缓或不投。未核实资料不计为已满足。')]);}
function buildWritingPortalCard(){
  return {
    schema:'2.0',
    config:{update_multi:true,width_mode:'default',enable_forward:false,summary:{content:'易标 · 生成其他标书'}},
    header:{
      title:{tag:'plain_text',content:'易标 · 生成其他标书'},
      subtitle:{tag:'plain_text',content:'适用于未进入预读报告的标项'},
      template:'green',
      icon:{tag:'standard_icon',token:'ai-common_colorful'},
      text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:'长期入口'},color:'green'}],
    },
    body:{direction:'vertical',vertical_spacing:'12px',padding:'12px 12px 20px 12px',elements:[
      group([md('**没有预读报告，也可以直接生成标书**\n在易标中上传招标文件，按现有完整流程完成解析、目录、事实核对和正文生成。')],'green-50'),
      group([md('**使用步骤**\n1. 选择生成技术标或商务标\n2. 上传招标文件\n3. 选择本标书使用的模型\n4. 核对待核实项后开始生成')],'grey-50'),
      group([md('**生成规则**\n模型选择固定到当前标书任务；证据不足保留“待核实”。报价、签章和投标提交仍由员工确认。')],'green-50'),
      {tag:'button',type:'primary_filled',width:'fill',text:{tag:'plain_text',content:'生成技术标'},behaviors:[writingPortalBehavior('technical')],...writingPortalFeedback()},
      {tag:'button',type:'primary_filled',width:'fill',text:{tag:'plain_text',content:'生成商务标'},behaviors:[writingPortalBehavior('business')],...writingPortalFeedback()},
    ]},
  };
}
function buildRelocatedCard(p){
 const title=escapeText(p?.input?.handoff?.task?.title??'招标项目');
 return baseCard(`已迁移 · ${String(p?.input?.handoff?.task?.title??'招标项目')}`,'grey',[
  group([md(`**此卡已迁移**\n${title} 已根据群内最新招标文件生成新的项目卡。`)],'grey-50'),
  group([md('**操作说明**\n请使用最新项目卡完成确认跟进、复核和初稿生成；此旧卡已关闭操作。')],'blue-50'),
 ]);
}
module.exports={buildCard,buildRelocatedCard,buildSummary,buildWritingPortalCard,escapeText,companyMarker};
