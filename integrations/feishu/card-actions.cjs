'use strict';

const NAMESPACED=Object.freeze({
 'selection.select':{route:'selection',agent:'openbidkit-selection',action:'select'},
 'selection.decline':{route:'selection',agent:'openbidkit-selection',action:'decline'},
 'preread.select_task':{route:'preread',agent:'openbidkit-group-file',action:'select_task'},
 'company_match.follow':{route:'company_match',agent:'openbidkit',action:'follow'},
 'company_match.defer':{route:'company_match',agent:'openbidkit',action:'defer'},
 'company_match.decline':{route:'company_match',agent:'openbidkit',action:'decline'},
 'writing.start':{route:'writing',agent:'openbidkit',action:'write'},
 'writing.continue':{route:'writing',agent:'openbidkit',action:'continue'},
 'writing.retry':{route:'writing',agent:'openbidkit',action:'retry'},
});

function legacyDescriptor(value){
 if(value?.agent==='openbidkit-selection'&&['select','decline'].includes(value.action))return {route:'selection',agent:value.agent,action:value.action};
 if(value?.agent==='openbidkit-group-file'&&value.action==='select_task')return {route:'preread',agent:value.agent,action:value.action};
 if(value?.agent==='openbidkit'&&['follow','defer','decline'].includes(value.action))return {route:'company_match',agent:value.agent,action:value.action};
 if(value?.agent==='openbidkit'&&['write','continue','retry'].includes(value.action))return {route:'writing',agent:value.agent,action:value.action};
 if(value?.agent==='openbidkit'&&value.action==='page')return {route:'workflow',agent:value.agent,action:value.action};
 return null;
}

function normalizeCardAction(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.action!=='string')return null;
 const namespaced=Object.prototype.hasOwnProperty.call(NAMESPACED,value.action)?NAMESPACED[value.action]:null;
 return namespaced??legacyDescriptor(value);
}

function cardAction(action,fields={}){
 if(!NAMESPACED[action])throw Error('card_action_invalid');
 return {action,...fields};
}

module.exports={cardAction,normalizeCardAction};
