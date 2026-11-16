const $=id=>document.getElementById(id);
const filters={record:{period:'month',start:'',end:''},cash:{period:'month',start:'',end:''}};
const dateString=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export function periodBounds(filter, now=new Date()) {
  const end=dateString(now),begin=new Date(now.getFullYear(),now.getMonth(),1);
  if(filter.period==='custom') return {start:filter.start||'9999-01-01',end:filter.end||'0000-01-01'};
  if(filter.period==='week') begin.setTime(new Date(now.getFullYear(),now.getMonth(),now.getDate()-6).getTime());
  return {start:dateString(begin),end};
}
function text(id,value){$(id).textContent=value;}
function line(label,value){const row=document.createElement('div');row.className='money-line';const a=document.createElement('span'),b=document.createElement('strong');a.textContent=label;b.textContent=value;row.append(a,b);return row;}
export function drawCumulative(container,rows,money) {
  const ns='http://www.w3.org/2000/svg',make=(tag,attrs={})=>{const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
  const svg=make('svg',{viewBox:'0 0 340 180',role:'img','aria-label':'累计投注净结果，包含零线'});
  let total=0;const values=[0,...rows.map(row=>total+=row.net)];const lo=Math.min(0,...values),hi=Math.max(0,...values),span=Math.max(100,hi-lo),y=v=>145-(v-lo)/span*110;
  for(const value of [...new Set([lo,0,hi])]){svg.append(make('line',{x1:48,x2:328,y1:y(value),y2:y(value),stroke:value===0?'#7e8883':'#e5e8e6'}));const label=make('text',{x:2,y:y(value)+4,'font-size':10,fill:'#6b746f'});label.textContent=money(value);svg.append(label);}
  svg.append(make('polyline',{points:values.map((v,i)=>`${48+i/Math.max(1,values.length-1)*280},${y(v)}`).join(' '),fill:'none',stroke:'#168675','stroke-width':2.5}));
  if(rows.length){const label=make('text',{x:48,y:172,'font-size':10,fill:'#6b746f'});label.textContent=rows[0].day+' — '+rows.at(-1).day;svg.append(label);}
  container.replaceChildren(svg);
}
export function setupDesign(api) {
  let detailId=null;
  const range=kind=>periodBounds(filters[kind]);
  for(const kind of ['record','cash']){
    document.querySelectorAll(`[data-${kind}-period]`).forEach(button=>button.addEventListener('click',()=>{filters[kind].period=button.dataset[kind+'Period'];$(kind+'-custom').classList.toggle('hidden',filters[kind].period!=='custom');document.querySelectorAll(`[data-${kind}-period]`).forEach(b=>b.classList.toggle('selected',b===button));api.redraw();}));
    for(const key of ['start','end'])$(kind+'-'+key).addEventListener('change',e=>{filters[kind][key]=e.target.value;api.redraw();});
  }
  for(const id of ['record-status','record-combo','record-platform'])$(id).addEventListener('change',api.redraw);
  document.querySelectorAll('[data-dimension]').forEach(button=>button.addEventListener('click',()=>{$('analysis-dimension').value=button.dataset.dimension;$('analysis-dimension').dispatchEvent(new Event('change'));}));
  $('analysis-time-shortcut').addEventListener('click',()=>document.querySelector('[data-period="custom"]').click());
  for(const id of ['analysis-odds-shortcut','category-odds'])$(id).addEventListener('click',()=>{$('analysis-dimension').value='odds';api.go('categories');});
  $('detail-edit').addEventListener('click',()=>api.edit(detailId));$('detail-settle').addEventListener('click',()=>api.edit(detailId));$('detail-delete').addEventListener('click',async()=>{await api.remove(detailId);if(!api.state()?.wagers.some(w=>w.id===detailId))api.go('records');});
  $('settings-lock').addEventListener('click',()=>document.getElementById('lock-button').click());
  $('settings-defaults').addEventListener('click',()=>{api.newWager();const control=$('defaults-save').closest('details');control.open=true;control.scrollIntoView();});
  $('settings-models').addEventListener('click',()=>{api.newWager();$('intake-panel').open=true;$('intake-download').scrollIntoView();});
  $('settings-currency').addEventListener('click',()=>api.info('币种与精度','当前账本使用 CNY、整数分。三位小数仅接受无损尾零；其他精度需核对，不能静默舍入。'));
  $('settings-basis').addEventListener('click',()=>api.preference(api.state()?.preferences?.analysisDateBasis==='settled'?'placed':'settled'));
  $('settings-help').addEventListener('click',()=>api.info('计算口径','投注净结果＝实际返还（含本金）−本金。旧记录若含手续费仍保留其计算。ROI＝已结算且非作废投注净结果÷已结算本金。胜率按有明确净赢或净输的订单计算；持平、作废不计分母。串关整单与分项分开，未知结算日期不纳入结算日统计。'));
  $('settings-import').addEventListener('click',()=>api.info('从加密备份恢复','现有版本只允许在空账本导入加密备份，以避免覆盖已有记录。可在另一浏览器的首次创建页选择“从加密备份导入”。当前账本可使用“本机快照”恢复上一版。请先保管独立备份，不要清除网站数据。'));
  function openDetail(id){detailId=id;api.go('detail');}
  function filterRecord(w){const r=range('record'),day=api.date(w.placedAt);return day>=r.start&&day<=r.end&&($('record-status').value==='all'||($('record-status').value==='open'?w.status==='open':w.status!=='open'))&&($('record-combo').value==='all'||w.combo===$('record-combo').value)&&($('record-platform').value==='all'||w.platform===$('record-platform').value);}
  function render(){
    const state=api.state();if(!state)return;
    $('settings-basis').lastElementChild.textContent=(state.preferences?.analysisDateBasis==='settled'?'按结算日':'按投注日')+' ›';
    const budget=state.riskSettings.budgetMinor,used=api.budgetUsed();
    $('design-budget-progress').value=budget?Math.min(100,used/budget*100):0;
    const options=[...new Set(state.wagers.map(w=>w.platform).filter(Boolean))],select=$('record-platform'),selected=select.value;
    select.replaceChildren(...['all',...options].map(value=>{const o=document.createElement('option');o.value=value;o.textContent=value==='all'?'全部平台':value;return o;}));if(options.includes(selected))select.value=selected;
    const r=range('cash'),cash=state.records.filter(x=>x.date>=r.start&&x.date<=r.end);let deposits=0,withdrawals=0,other=0;
    for(const x of cash){if(x.kind==='deposit')deposits+=x.amountMinor;else if(x.kind==='withdrawal')withdrawals+=x.amountMinor;else other+=x.deltaMinor;}
    const bets=api.cashChange(state.wagers,r.start,r.end),net=deposits-withdrawals;
    for(const[id,value]of Object.entries({'cash-deposits':deposits,'cash-withdrawals':withdrawals,'cash-net':net,'cash-net-copy':net,'cash-bets':bets,'cash-other':other,'cash-change':net+bets+other}))text(id,api.money(value));
    const w=state.wagers.find(w=>w.id===detailId);if(!w)return;
    text('detail-status',(w.combo==='parlay'?`${w.legs?.length||'—'}串1`:'单注')+' · '+(w.status==='open'?'未结算':'已结算'));
    text('detail-stake',api.money(w.stakeMinor));text('detail-return',w.status==='open'?'—':api.money(w.actualReturnMinor));text('detail-net',w.status==='open'?'—':api.money(api.net(w)));
    $('detail-net').classList.toggle('negative',w.status!=='open'&&api.net(w)<0);
    $('detail-fields').replaceChildren(...[['比赛',w.event],['投注选择',w.selection||'未填写'],['投注时间',new Date(w.placedAt).toLocaleString('zh-CN')],['平台',w.platform||'未填写'],['币种','CNY'],['赔率',w.oddsMilli==null?'未显示':String(w.oddsMilli/1000)],['结算时间',w.settledAt?new Date(w.settledAt).toLocaleString('zh-CN'):'待补充']].map(([a,b])=>line(a,b)));
    text('detail-legs-heading',w.combo==='parlay'?`串关分项 · ${w.legs?.length||0}项`:'单注信息');
    $('detail-legs').replaceChildren(...(w.legs?.length?w.legs:[{event:w.event,selection:w.selection,market:w.market,odds:w.oddsMilli==null?'':String(w.oddsMilli/1000)}]).map((leg,index)=>{const card=document.createElement('div');card.className='leg-summary';const title=document.createElement('strong'),sub=document.createElement('p');title.textContent=`${index+1}  ${leg.event}`;sub.textContent=[leg.sport,leg.selection,leg.market,leg.stage,leg.odds?'@'+leg.odds:'',leg.startText].filter(Boolean).join(' · ');card.append(title,sub);return card;}));
    $('detail-audit').replaceChildren(...state.auditLog.filter(x=>x.entityId===w.id).map(x=>line(new Date(x.at).toLocaleString('zh-CN'),({create:'新增',edit:'修改',delete:'删除'})[x.action]||x.action)));
  }
  return {render,openDetail,filterRecord,cashFilter:record=>{const r=range('cash');return record.date>=r.start&&record.date<=r.end;}};
}

