// Layout parsing produces an editable draft; never invent missing receipt values.
export function parseReceipt(text, baseline = {}) {
  const lines = text.normalize('NFKC').replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g,'$1').replace(/(\d)[ \t]*([年月日])[ \t]*/g,'$1$2').replace(/日(?=\d{1,2}:)/g,'日 ').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const raw = lines.join('\n');
  const cardStarts = lines.map((line,index)=> /单局\s*[-–—一]?\s*获胜/.test(line) ? index : -1).filter(index=>index>=0);
  if (/DB\s*电竞/i.test(raw) && cardStarts.length > 1) {
    const first = parseReceipt('DB电竞\n' + lines.slice(cardStarts[0],cardStarts[1]).join('\n'));
    first.warnings.unshift('当前先填入第一张完整订单，后面的截断订单未导入；顶部汇总不入账。');
    first.firstOrderOnly = true;
    return first;
  }
  const fields = {...baseline};
  const warnings = [];
  const unique = (pattern) => {
    const values = [...raw.matchAll(pattern)].map(m => m[1].trim());
    return new Set(values).size === 1 ? values[0] : undefined;
  };
  const money = (labels,key) => {
    const value = unique(new RegExp('(?:^|\\n)\\s*(?:' + labels + ')\\s*[:：]?\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?)', 'g'));
    if (value !== undefined) {
      if (/^\d+(?:\.\d{1,2}|\.\d{2}0+)?$/.test(value)) fields[key] = Number(value).toFixed(2);
      else { delete fields[key]; warnings.push('金额精度超过当前账本支持范围，请核对原值：' + value); }
    }
  };
  money('投注金额|下注金额|本金','stake');
  money('返还金额|实际返还|返还','return');
  const labeledOdds=unique(/(?:十进制赔率|赔率|odds)\s*[:：]?\s*(\d+(?:\.\d+)?)/gi);
  if(labeledOdds && Number(labeledOdds)>=1 && Number(labeledOdds)<=1000)fields.odds=labeledOdds;
  const datetime = labels => {
    const value = unique(new RegExp('(?:' + labels + ')\\s*[:：]?\\s*(\\d{4}[年/-]\\d{1,2}[月/-]\\d{1,2}日?\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)','g'));
    if (!value) return undefined;
    const match = value.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const [,y,m,d,h,min,sec='00'] = match;
    const date = new Date(+y,+m-1,+d,+h,+min,+sec);
    if (date.getFullYear() !== +y || date.getMonth()+1 !== +m || date.getDate() !== +d || date.getHours() !== +h || +min>59 || +sec>59) { warnings.push('日期无效，请手工核对'); return undefined; }
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${min}:${sec}`;
  };
  const placed = datetime('投注时间|下单时间');
  if (placed) fields['placed-at'] = placed;
  const settled = datetime('结算时间');
  if (settled) fields['settled-at'] = settled;
  const parlay = raw.match(/([2-9]|\d{2})\s*串\s*1/);
  if (parlay) fields.combo = 'parlay';
  else if (/单注/.test(raw)) fields.combo = 'single';
  const matches = lines.map((line,index) => ({line,index})).filter(({line}) => /\S\s*(?:\bVS\b|\bvs\b)\s*\S/.test(line));
  if (matches.length > 1 && !parlay) {
    return {fields:{},warnings:['图片包含多笔或截断订单，请每次裁剪一张完整订单后识别，避免把汇总金额记成本金。'],legs:[]};
  }
  const legs = matches.map(({line,index},n) => {
    const previous = n ? matches[n-1].index : -1;
    const before = lines.slice(previous+1,index).filter(s => !/开赛时间|开始时间|\d{4}[年/-]/.test(s));
    const oddsMatch = before.join('\n').match(/[@@]\s*(\d+(?:\.\d+)?)/);
    let selection = before.find(s => /@\s*\d/.test(s))?.replace(/@\s*\d+(?:\.\d+)?/,'').trim()
      || before.find(s => /^[A-Za-z][A-Za-z0-9 ._-]*(?:让分[+−-]?\d+(?:\.\d+)?)?$/.test(s) && !/DB电竞/i.test(s));
    const market = before.filter(s => /获胜者|首先|杀敌|让分|大小|回合/.test(s) && s !== selection).join(' · ');
    const stage = before.find(s => /赛前|滚球|滚盘/.test(s)) || '';
    const teams = line.replace(/^(?:战队|比赛|事件)\s*[:：]?\s*/,'').split(/\s*-?\s*VS\s*-?\s*/i).map(s=>s.trim());
    const selectionSource = selection || before.join(' ');
    const selectedTeams = teams.filter(team => team && selectionSource.toLowerCase().includes(team.toLowerCase()));
    if (selectedTeams.length === 1) selection = selectedTeams[0] + (selectionSource.match(/让分\s*[+−-]?\s*\d+(?:\.\d+)?/)?.[0] || '');
    else { const fromHeader=teams.filter(team=>team && before.join(' ').toLowerCase().includes(team.toLowerCase())); if(fromHeader.length===1) selection=fromHeader[0]; }
    const startLine = lines.slice(index+1,index+3).join(' ');
    const start = startLine.match(/(?:开赛时间|开始时间)\s*[:：]?\s*(\d{4}[年/-].*)/);
    return {event:line.replace(/^(?:战队|比赛|事件)\s*[:：]?\s*/,'').replace(/\s*-?\s*VS\s*-?\s*/i,' vs '),selection:selection || '',market,stage,odds:oddsMatch ? oddsMatch[1] : '',startText:start?.[1] || ''};
  });
  if (legs.length === 1) {
    fields.event = legs[0].event;
    fields.selection = legs[0].selection;
    if (legs[0].startText) fields['start-text'] = legs[0].startText;
    fields.market = [...new Set([legs[0].market,legs[0].stage].filter(Boolean))].join(' · ') || fields.market;
    if (legs[0].odds && Number(legs[0].odds)>=1 && Number(legs[0].odds)<=1000) fields.odds = legs[0].odds;
  }
  if (parlay) {
    fields.event = `${parlay[1]}串1`;
    delete fields.odds; // Never multiply displayed rounded leg odds into a claimed total.
    fields.legs = JSON.stringify(legs,null,2);
    if (legs.length !== Number(parlay[1])) warnings.push('串关分项不完整，请补齐或重新裁剪截图');
  }
  if (/已结算/.test(raw)) fields.status = 'cashout'; // No inference of win/loss from icon colors.
  else if (/未结算/.test(raw)) fields.status = 'open';
  if (/DB\s*电竞/i.test(raw)) fields.platform = 'DB电竞';
  const league = unique(/赛事\s*[:：]?\s*([^\n]+)/g);
  if (league) fields.league = league;
  if (/最高可赢/.test(raw) && fields.return === undefined) warnings.push('最高可赢不是实际返还，返还金额留空');
  for (const [key,label] of [['stake','投注金额'],['odds','整单赔率'],['placed-at','投注时间'],['settled-at','结算时间']]) if (fields[key] === undefined) warnings.push(label + '未识别，需核对或补充');
  const sport = raw.match(/(?:篮球|足球|\bDOTA\s*2?\b|\bCS\s*2?\b)/i)?.[0];
  if (sport) fields.sport = /^dota/i.test(sport) ? 'Dota 2' : /^cs/i.test(sport) ? 'CS' : sport;
  warnings.push('币种、游戏类别和赛果请核对；不根据图标猜测。');
  return {fields:Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==undefined && v!=='')),warnings,legs};
}

