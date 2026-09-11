const escapeText=value=>String(value??'').slice(0,1200).replace(/[&<>*_[\]()`#~]/g,c=>`&#${c.charCodeAt(0)};`);
const md=text=>({tag:'markdown',content:text});
const group=(elements,color='grey-50')=>({tag:'column_set',flex_mode:'none',background_style:color,columns:[{tag:'column',width:'weighted',weight:1,padding:'8px',elements}]});
const label={follow:'建议跟进',review:'暂缓，待核实',reject:'不建议投标'};
const human={follow:'已确认跟进',defer:'暂缓',decline:'不投'};
const {buildDecisionBrief}=require('./decision-brief.cjs');
const writingPortalBehavior=()=>({type:'open_url',default_url:'https://yibiao.pro',pc_url:'yibiao://new-bid'});
const writingPortalButton=()=>({tag:'button',type:'default',text:{tag:'plain_text',content:'生成其他标书'},behaviors:[writingPortalBehavior()]});
function baseCard(title,template,elements){return{schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},header:{title:{tag:'plain_text',content:title.slice(0,120)},template},body:{direction:'vertical',vertical_spacing:'12px',padding:'12px',elements}};}
function buildCard(p,writing,page=0,options={}){
  const h=p.input.handoff,a=p.assessment,decision=a.decision;const cardKey=require('./store.cjs').key(p.input,p.assessment);
  const button=(action,text,type='default',disabled=false)=>({tag:'button',type,text:{tag:'plain_text',content:text},disabled,behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action}}]});
  const brief=buildDecisionBrief(p,options);
  const links=[];for(const [name,url] of [['预读报告',p.input.reportUrl],['招标原文件',p.input.sourceUrl]]){try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password)links.push({tag:'button',text:{tag:'plain_text',content:name},behaviors:[{type:'open_url',default_url:u.href}]});}catch{}}
  const writingText=writing?`\n编写进度：${escapeText(({queued:'排队中',running:'处理中',not_ready:'配置未就绪',waiting_confirmation:'等待确认',completed:'初稿已生成',failed:'失败，待处理',interrupted:'上次运行中断，请核对后重试',cancelled:'已取消'})[writing.status]??writing.status)}`:'';
  const writingElements=[];const c=writing?.result?.confirmation;
  if(writing?.status==='waiting_confirmation'&&c){
    const titles={outline_selection:'请确认采用建议的章节范围',outline:'请确认目录后生成正文',global_facts:'请核对事实清单；缺失信息将保留待补占位，不代表已核实',source_file:'缺少完整招标原文件，请由接入管理员补充',content_decision:'部分正文小节未完成，请查看清单后重试'};
    writingElements.push(md(`**${titles[c.type]??'需要人工确认'}**\n完整清单以群内附件为准。`));
    if(c.challenge&&['outline_selection','outline','global_facts','content_decision'].includes(c.type))writingElements.push({tag:'button',type:'primary_filled',disabled:!writing.previewDelivered,text:{tag:'plain_text',content:c.type==='global_facts'?'保留待补项，继续生成':c.type==='content_decision'?'重试失败小节':'确认以上内容并继续'},behaviors:[{type:'callback',value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey,action:'continue',challenge:c.challenge}}]});
  }
  if(['failed','not_ready','interrupted'].includes(writing?.status))writingElements.push(button('retry','修复配置后重试'));
  const bullet=values=>values.map(value=>'• '+escapeText(value)).join('\n');
  return baseCard(`${label[decision]??label.review} · ${h.task.title}`,decision==='follow'?'green':decision==='reject'?'red':'orange',[
    group([md(`**${escapeText(brief.title)}**\n判标主体：${escapeText(brief.company)}\n**资格结论：${escapeText(brief.eligibility)}**\n**商务判断：${escapeText(brief.commercial)}**\n投标截止：${escapeText(brief.deadline)}`)],decision==='follow'?'green-50':decision==='reject'?'red-50':'orange-50'),
    group([md(`**一票否决检查**\n🔴 明确不满足 ${brief.gateCounts.notSatisfied}\n🟠 待核验 ${brief.gateCounts.review}\n🟢 已核验满足 ${brief.gateCounts.satisfied}\n\n**关键参数**\n${bullet(brief.facts.map(fact=>`${fact.label}：${fact.value}`))}`)]),
    group([md(`**主要风险**\n${bullet(brief.risks)}\n\n**下一步（最多3项）**\n${bullet(brief.actions)}`)]),
    group([md(`处理决定：${human[p.humanDecision]??'等待员工判断'}${writingText}\n文件版本：${escapeText(p.version)}；结论含待核实项时，不能视为已具备投标资格。`),...links]),
    group([button('follow','确认跟进','primary_filled'),button('defer','暂缓'),button('decline','不投','danger'),button('write','生成标书初稿','default',p.humanDecision!=='follow'||decision!=='follow'),writingPortalButton(),...writingElements])
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
      group([md('**使用步骤**\n1. 点击下方按钮打开易标\n2. 上传招标文件\n3. 选择本标书使用的模型\n4. 核对待核实项后开始生成')],'grey-50'),
      group([md('**生成规则**\n模型选择固定到当前标书任务；证据不足保留“待核实”。报价、签章和投标提交仍由员工确认。')],'green-50'),
      {tag:'button',type:'primary_filled',width:'fill',text:{tag:'plain_text',content:'打开易标新建标书'},behaviors:[writingPortalBehavior()]},
    ]},
  };
}
module.exports={buildCard,buildSummary,buildWritingPortalCard,escapeText};
