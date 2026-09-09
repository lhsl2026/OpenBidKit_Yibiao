// Human-facing attachment: retain the full content without exposing callback IDs.
function confirmationText(c){
 const lines=['标书生成确认清单','缺失的企业事实保持待补，不代表已核实。请核对后在项目卡片继续。',''];
 if(c.type==='outline_selection'){
  lines.push('建议章节范围','');const selected=new Set(c.selectedIds??[]);
  for(const [i,item] of (c.items??[]).entries())lines.push(`${i+1}. ${item.title}（${selected.has(item.id)?'拟采用':'暂不采用'}）`,item.description||'','');
 }else if(c.type==='outline'){
  lines.push('完整目录','');
  function walk(items,depth=0){for(const item of items??[]){lines.push('  '.repeat(Math.min(depth,12))+'• '+(item.title??item.name??'未命名章节'));if(item.description)lines.push('  '.repeat(Math.min(depth+1,12))+item.description);walk(item.children,depth+1);}}
  walk(c.outlineData?.outline);
 }else if(c.type==='global_facts'){
  lines.push('全局事实与待补项','');for(const g of c.groups??[])lines.push(g.title||'待核对事项',g.content||'【待补充】','');
 }else if(c.type==='content_decision'){
  lines.push('正文尚未完成','');for(const section of c.failedSections??[])lines.push(section.title||'待重试章节','该小节尚未成功生成；详细诊断由接入管理员在本机核对。','');
  lines.push('请在卡片点击“重试失败小节”。未完成小节不会作为成功初稿交付。');
 }else lines.push('当前步骤需要补充材料或人工处理，请联系接入管理员。');
 return lines.join('\n');
}
module.exports={confirmationText};
