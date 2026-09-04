// ================= 核心缓存与状态 =================
let heroDict = {}, idToName = {}, qqIdToName = {};
let posCache = {}, wrCache = {}, anaCache = {}, periodCache = {}, equipCache = {}, hashLib = {};
const POSITIONS = ["对抗路", "中路", "发育路", "打野", "辅助"];
let myTeam = [], enemyTeam = [], myPositions = [], userPosition = "", isCalculating = false;

function log(msg) {
  const el = document.getElementById('log-output');
  el.textContent += msg === '' ? '' : msg + '\n';
  el.scrollTop = el.scrollHeight;
}

// ================= 高精度前端特征识别引擎 (含 Phase 2 兜底抢救) =================
const BP_PARAMS = {
  PICK_Y: [0.171, 0.330, 0.491, 0.652, 0.814],
  PICK_X_L: 0.192, PICK_X_R: 0.194, SIDE: 0.118,
  MASK: [[0.00, 0.00, 0.19, 0.32], [0.26, 0.72, 0.71, 1.00]],
  MATCH_THRESHOLD: 14, // 最终容错阈值
  PHASE1_PASS: 10      // 小于等于10直接通过，大于10触发 Phase2 抢救
};

function calcDHash(ctx, imgW, imgH, isLeft, index, isPhase2 = false) {
  let side = Math.max(24, Math.round(imgH * BP_PARAMS.SIDE));
  let cx = isLeft ? Math.round(imgH * BP_PARAMS.PICK_X_L) : imgW - Math.round(imgH * BP_PARAMS.PICK_X_R);
  let cy = Math.round(imgH * BP_PARAMS.PICK_Y[index]);

  // 【核心修复】：Phase 2 兜底抢救，向内缩小取景框 0.75，并向上平移 0.12，完美避开 UI 污染
  if (isPhase2) {
    side = Math.round(side * 0.75);
    cy = cy - Math.round(side * 0.12);
  }

  const rect = { l: Math.max(0, cx - Math.floor(side/2)), t: Math.max(0, cy - Math.floor(side/2)), w: side, h: side };
  const oData = ctx.getImageData(rect.l, rect.t, rect.w, rect.h);
  
  BP_PARAMS.MASK.forEach(([ml, mt, mr, mb]) => {
    const sl = Math.floor(rect.w * ml), sr = Math.floor(rect.w * mr);
    const st = Math.floor(rect.h * mt), sb = Math.floor(rect.h * mb);
    for (let y = st; y < sb; y++) {
      for (let x = sl; x < sr; x++) {
        const i = (y * rect.w + x) * 4;
        oData.data[i] = oData.data[i+1] = oData.data[i+2] = 128;
      }
    }
  });

  const px = new Uint8ClampedArray(9 * 8 * 4);
  const blockW = rect.w / 9; const blockH = rect.h / 8;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const startY = Math.floor(r * blockH), endY = Math.floor((r + 1) * blockH);
      const startX = Math.floor(c * blockW), endX = Math.floor((c + 1) * blockW);
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const i = (y * rect.w + x) * 4;
          rSum += oData.data[i]; gSum += oData.data[i+1]; bSum += oData.data[i+2];
          count++;
        }
      }
      const outIdx = (r * 9 + c) * 4;
      px[outIdx] = rSum / count; px[outIdx+1] = gSum / count; px[outIdx+2] = bSum / count;
    }
  }

  let hex = "";
  for (let r = 0; r < 8; r++) {
    let bits = "";
    for (let c = 0; c < 8; c++) {
      const i1 = (r * 9 + c) * 4, i2 = (r * 9 + c + 1) * 4;
      const g1 = px[i1]*0.299 + px[i1+1]*0.587 + px[i1+2]*0.114;
      const g2 = px[i2]*0.299 + px[i2+1]*0.587 + px[i2+2]*0.114;
      bits += g1 > g2 ? "1" : "0";
    }
    hex += parseInt(bits, 2).toString(16).padStart(2, '0');
  }
  return hex;
}

function hamming(h1, h2) {
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const val = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    dist += val.toString(2).split('1').length - 1;
  }
  return dist;
}

async function recognizeImg(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const leftNames = [], rightNames = [];
  log("--- 开始图像特征诊断 ---");
  
  for (let i = 0; i < 5; i++) {
    const matchSlot = (isLeft) => {
      let hashP1 = calcDHash(ctx, img.width, img.height, isLeft, i, false);
      let bestId = null, minD = 999;
      for (const [name, variants] of Object.entries(hashLib)) {
        variants.forEach(vh => { const d = hamming(hashP1, vh); if (d < minD) { minD = d; bestId = name; } });
      }
      // Phase 2 兜底抢救触发
      if (minD > BP_PARAMS.PHASE1_PASS) {
        let hashP2 = calcDHash(ctx, img.width, img.height, isLeft, i, true);
        let bestId2 = null, minD2 = 999;
        for (const [name, variants] of Object.entries(hashLib)) {
          variants.forEach(vh => { const d = hamming(hashP2, vh); if (d < minD2) { minD2 = d; bestId2 = name; } });
        }
        if (minD2 < minD) { minD = minD2; bestId = bestId2; }
      }
      return { id: bestId, dist: minD };
    };

    const lRes = matchSlot(true), rRes = matchSlot(false);
    log(`左${i+1} 最佳匹配: ${lRes.id} (误差 ${lRes.dist}) -> ${lRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? '✅通过' : '❌丢弃'}`);
    log(`右${i+1} 最佳匹配: ${rRes.id} (误差 ${rRes.dist}) -> ${rRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? '✅通过' : '❌丢弃'}`);

    leftNames.push(lRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? lRes.id : null);
    rightNames.push(rRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? rRes.id : null);
  }
  log("------------------------");
  return { leftNames, rightNames };
}

// ================= 数据推演与胜率核心 =================
function assignPos(teamNames) {
  const team = [];
  const prefs = teamNames.filter(n => n).map(name => {
    return { name, p: posCache[heroDict[name]] || {} };
  }).sort((a, b) => Math.max(0, ...Object.values(b.p)) - Math.max(0, ...Object.values(a.p)));

  const avail = [...POSITIONS];
  prefs.forEach(h => {
    const sortedP = Object.entries(h.p).sort((x, y) => y[1] - x[1]);
    const found = sortedP.find(([pos]) => avail.includes(pos));
    const finalPos = found ? found[0] : (avail.shift() || "未知");
    if(found) avail.splice(avail.indexOf(finalPos), 1);
    team.push([h.name, finalPos]);
  });
  return team;
}

// 获取胜率 (支持白板 Dummy 控制变量法)
function getWr(idStr, pos, period) {
  if (idStr === "__DUMMY__") return 0.5;
  if (period) {
    const pData = periodCache[idStr] || [];
    const match = pData.find(p => (period==='e' && p.durationRange.includes('0-12')) || 
                                  (period==='m' && p.durationRange.includes('12-18')) || 
                                  (period==='l' && p.durationRange.includes('18') && !p.durationRange.includes('12')));
    return match ? Math.max(0.01, Math.min(0.99, match.winRate / 100)) : 0.5;
  }
  let wr = (wrCache[idStr] || {})[pos];
  return wr ? Math.max(0.01, Math.min(0.99, (wr > 1 ? wr/100 : wr))) : 0.5;
}

// 获取原始数值 (用于输出展示)
function getRawIndex(name, targetName, type) {
  if (name === "__DUMMY__" || targetName === "__DUMMY__") return 0;
  const ana = anaCache[heroDict[name]] || { counters: [], counteredBy: [], goodSynergies: [], badSynergies: [] };
  if (type === 'counter') {
    let v = ana.counters.find(i => i.heroName === targetName);
    if (v) return v.advantageIndex;
    v = ana.counteredBy.find(i => i.heroName === targetName);
    return v ? -v.advantageIndex : 0;
  } else {
    let v = ana.goodSynergies.find(i => i.heroName === targetName);
    if (v) return v.synergyIndex;
    v = ana.badSynergies.find(i => i.heroName === targetName);
    return v ? -v.synergyIndex : 0;
  }
}

// 计算底层加权特征 (用于预测算法)
function calcFeatures(name, pos, wr, myT, enT) {
  if (name === "__DUMMY__") return [0, 0];
  let pAdv = [], nAdv = 0;
  enT.forEach(([eName, ePos]) => {
    let v = getRawIndex(name, eName, 'counter');
    if (v > 0) pAdv.push(ePos === pos ? v * 1.0605 : v);
    else if (v < 0) nAdv += ((v/100) * (1 + Math.abs(v/100)*7.8882) * 100) * (ePos === pos ? 1.0605 : 1);
  });
  pAdv.sort((a,b)=>b-a);
  const cScore = (pAdv[0]||0) + (pAdv[1]||0)*0.5649 + pAdv.slice(2).reduce((a,b)=>a+b*0.1178,0) + nAdv;
  const synScore = myT.reduce((acc, [tName]) => acc + (tName !== name ? getRawIndex(name, tName, 'synergy') : 0), 0);
  return [cScore, synScore * Math.max(0, 1 - Math.abs(wr - 0.5) * 5.8843)];
}

function predictWr(myT, enT, period = null) {
  let ml = [], el = [], tC = 0, tS = 0;
  myT.forEach(([n, p]) => {
    let wr = getWr(heroDict[n] || "__DUMMY__", p, period); ml.push(Math.log(wr/(1-wr)));
    const [c, s] = calcFeatures(n, p, wr, myT, enT); tC+=c; tS+=s;
  });
  enT.forEach(([n, p]) => {
    let wr = getWr(heroDict[n] || "__DUMMY__", p, period); el.push(Math.log(wr/(1-wr)));
    const [c, s] = calcFeatures(n, p, wr, enT, myT); tC-=c; tS-=s;
  });
  const avgM = ml.length ? ml.reduce((a,b)=>a+b,0)/ml.length : 0;
  const avgE = el.length ? el.reduce((a,b)=>a+b,0)/el.length : 0;
  return (1 / (1 + Math.exp(-(1.1811*(avgM-avgE) + 1.2668*(tC/100) + 1.3774*(tS/200))))) * 100;
}

function formatSign(num) { return (num > 0 ? "+" : "") + num.toFixed(2) + "%"; }

// ================= 主干调度 =================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const resps = await Promise.all(['hero_list','position_cache','win_rate_cache','hero_analysis_cache','hero_period_cache','equip_cache','hero_hashes'].map(f => fetch(`data/${f}.json`).catch(()=>({json:()=>({})}))) );
    [heroDict, posCache, wrCache, anaCache, periodCache, equipCache, hashLib] = await Promise.all(resps.map(r => r.json()));
    idToName = Object.fromEntries(Object.entries(heroDict).map(([k,v])=>[v,k]));
  } catch(e) {}
  document.getElementById('btn-consult').addEventListener('click', () => handleUpload('consult'));
  document.getElementById('btn-predict').addEventListener('click', () => handleUpload('predict'));
});

async function handleUpload(mode) {
  if (isCalculating) return;
  const fileInput = document.getElementById(mode === 'consult' ? 'upload-consult' : 'upload-predict');
  if (!fileInput.files.length) return alert("请先选择图片！");
  if (mode === 'predict' && !(userPosition = document.getElementById('my-pos-select').value)) return alert("模式二必须选择你的分路！");

  isCalculating = true;
  document.getElementById('status-text').textContent = '🔄 极速分析中...';
  document.getElementById('log-output').textContent = '';

  try {
    const img = new Image(); img.src = URL.createObjectURL(fileInput.files[0]);
    await new Promise(r => img.onload = r);

    const { leftNames, rightNames } = await recognizeImg(img);
    myTeam = assignPos(leftNames); enemyTeam = assignPos(rightNames);
    myPositions = myTeam.map(h => h[1]);

    if (mode === 'consult') await showRecs();
    else await showFinal();
    document.getElementById('status-text').textContent = '✔️ 分析完成';
  } catch(e) { document.getElementById('status-text').textContent = '❌ 出错: ' + e.message; } 
  finally { isCalculating = false; }
}

async function showRecs() {
  document.getElementById('rec-card').style.display = 'block';
  const rc = document.getElementById('rec-content');
  const avail = POSITIONS.filter(p => !myPositions.includes(p));
  if (!avail.length) return rc.innerHTML = '位置已满。';
  
  rc.innerHTML = '演算中...';
  let html = '';
  const picked = new Set([...myTeam.map(h=>h[0]), ...enemyTeam.map(h=>h[0])]);

  for (const pos of avail) {
    let res = [];
    for (const [name, id] of Object.entries(heroDict)) {
      if (!picked.has(name) && (posCache[id]||{})[pos] >= 10) {
        res.push({ score: predictWr(myTeam.concat([[name, pos]]), enemyTeam), name });
      }
    }
    if (res.length) {
      html += `<div class="hero-group">补位: ${pos}</div>`;
      res.sort((a,b)=>b.score-a.score).slice(0,3).forEach(r => html += `<div class="hero-item">${r.name} [融入胜率: ${r.score.toFixed(2)}%]</div>`);
    }
  }
  rc.innerHTML = html;
}

// 完美还原原版排版与控制变量法深度评估
async function showFinal() {
  const finalWr = predictWr(myTeam, enemyTeam);
  const wrE = predictWr(myTeam, enemyTeam, 'e');
  const wrM = predictWr(myTeam, enemyTeam, 'm');
  const wrL = predictWr(myTeam, enemyTeam, 'l');

  log("=== 最终胜率预测 ===");
  log(`【整体预测】我方阵容胜率：${finalWr.toFixed(2)}% | 敌方：${(100-finalWr).toFixed(2)}%`);
  log(`【前期(0-12min)】我方阵容胜率：${wrE.toFixed(2)}% | 敌方：${(100-wrE).toFixed(2)}%`);
  log(`【中期(12-18min)】我方阵容胜率：${wrM.toFixed(2)}% | 敌方：${(100-wrM).toFixed(2)}%`);
  log(`【后期(18min+)】我方阵容胜率：${wrL.toFixed(2)}% | 敌方：${(100-wrL).toFixed(2)}%`);
  
  let phaseAdv = "平稳";
  if (wrE > Math.max(wrM, wrL) && wrE > 50) phaseAdv = "前期强势，应尽量在前期建立优势";
  else if (wrL > Math.max(wrE, wrM) && wrL > 50) phaseAdv = "后期强势，前期应注重防守发育拖后期";
  else if (wrM > Math.max(wrE, wrL) && wrM > 50) phaseAdv = "中期强势，应把握中期团战节奏结束比赛";
  else if (finalWr < 45) phaseAdv = "全期劣势，非常考验选手个人手法与团队配合";
  log(`💡 分析：我方阵容${phaseAdv}。\n`);

  log("--- 我方阵容深度评估 ---");
  for (const [hName, hPos] of myTeam) {
    if (!hName) continue;
    log(`\n【已选】${hName} (位置: ${hPos})`);
    
    // 控制变量法算单人贡献
    const myTeamWithoutMe = myTeam.map(h => h[0] === hName ? ["__DUMMY__", h[1]] : h);
    const wrWithoutMe = predictWr(myTeamWithoutMe, enemyTeam);
    const contribution = finalWr - wrWithoutMe;
    
    let tag = "中规";
    if (contribution >= 3) tag = "绝佳妙手";
    else if (contribution >= 1) tag = "妙手";
    else if (contribution > -1) tag = "不错";
    else if (contribution <= -3) tag = "惊天臭手";
    else if (contribution <= -1) tag = "臭手";
    
    log(`   📈 对总胜率影响: ${formatSign(contribution)} [${tag}]`);

    // 对位克制展示 (读取原汁原味 API index)
    enemyTeam.forEach(([eName, ePos]) => {
      if (!eName) return;
      const rawV = getRawIndex(hName, eName, 'counter');
      const samePosStr = (ePos === hPos) ? " (同分路)" : "";
      if (rawV > 0) log(`   对位 ${eName}: 克制 指数 ${formatSign(rawV)}${samePosStr}`);
      else if (rawV < 0) log(`   对位 ${eName}: 被克制 指数 ${formatSign(rawV)}${samePosStr}`);
      else log(`   对位 ${eName}: 无克制 指数 0.00%${samePosStr}`);
    });

    // 队友配合展示
    myTeam.forEach(([tName, tPos]) => {
      if (!tName || tName === hName) return;
      const rawV = getRawIndex(hName, tName, 'synergy');
      if (rawV > 0) log(`   配合 ${tName}: 优异 指数 ${formatSign(rawV)}`);
      else if (rawV < 0) log(`   配合 ${tName}: 冲突 指数 ${formatSign(rawV)}`);
    });
  }

  // 专属战术板输出 (所有 >10% 的装备与分时段)
  const uH = myTeam.find(h => h[1] === userPosition);
  if (uH) {
    const idStr = String(heroDict[uH[0]]);
    log(`\n【出装推荐】${uH[0]} (${uH[1]})`);
    const equips = (equipCache[idStr] || {})[uH[1]] || [];
    if (equips.length) {
      equips.forEach(e => log(`${e.equipmentName} 登场率:${e.pickRate.toFixed(2)}% 胜率:${e.winRate.toFixed(2)}%`));
    } else log("暂无出装数据");

    log(`\n【强势期分析】${uH[0]}`);
    const periods = periodCache[idStr] || [];
    if (periods.length) {
      const p1 = periods.find(p => p.durationRange.includes('0-12'));
      const p2 = periods.find(p => p.durationRange.includes('12-18'));
      const p3 = periods.find(p => p.durationRange.includes('18') && !p.durationRange.includes('12'));
      if(p1) log(`0-12分钟胜率：${p1.winRate.toFixed(2)}%`);
      if(p2) log(`12-18分钟胜率：${p2.winRate.toFixed(2)}%`);
      if(p3) log(`18分钟+胜率：${p3.winRate.toFixed(2)}%`);
    } else log("暂无时段数据");
  } else log(`\n⚠️ 警告：检测系统未把我方任何人推演至你的预设分路(${userPosition})。`);
}
