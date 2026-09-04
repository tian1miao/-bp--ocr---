let heroDict = {}, idToName = {};
let posCache = {}, wrCache = {}, anaCache = {}, periodCache = {}, equipCache = {}, hashLib = {};
const POSITIONS = ["对抗路", "中路", "发育路", "打野", "辅助"];
let myTeam = [], enemyTeam = [], myPositions = [], userPosition = "", isCalculating = false;

function log(msg) {
  const el = document.getElementById('log-output');
  el.textContent += msg === '' ? '' : msg + '\n';
  el.scrollTop = el.scrollHeight;
}

const BP_PARAMS = {
  PICK_Y: [0.171, 0.330, 0.491, 0.652, 0.814],
  PICK_X_L: 0.192, PICK_X_R: 0.194, SIDE: 0.118,
  MASK: [[0.00, 0.00, 0.19, 0.32], [0.26, 0.72, 0.71, 1.00]],
  MATCH_THRESHOLD: 22 // 放宽容错率，应对手机 Canvas 粗糙缩放
};

function calcDHash(ctx, imgW, imgH, isLeft, index) {
  const side = Math.max(24, Math.round(imgH * BP_PARAMS.SIDE));
  const cx = isLeft ? Math.round(imgH * BP_PARAMS.PICK_X_L) : imgW - Math.round(imgH * BP_PARAMS.PICK_X_R);
  const cy = Math.round(imgH * BP_PARAMS.PICK_Y[index]);
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

  const tempCanvas = document.createElement('canvas'); tempCanvas.width = rect.w; tempCanvas.height = rect.h;
  tempCanvas.getContext('2d').putImageData(oData, 0, 0);
  
  const resizeCanvas = document.createElement('canvas'); resizeCanvas.width = 9; resizeCanvas.height = 8;
  const rCtx = resizeCanvas.getContext('2d', {willReadFrequently: true});
  rCtx.drawImage(tempCanvas, 0, 0, 9, 8);
  const px = rCtx.getImageData(0, 0, 9, 8).data;

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
    const lHash = calcDHash(ctx, img.width, img.height, true, i);
    const rHash = calcDHash(ctx, img.width, img.height, false, i);
    let lBest = null, lMin = 999, rBest = null, rMin = 999;

    for (const [name, variants] of Object.entries(hashLib)) {
      variants.forEach(vh => {
        const d1 = hamming(lHash, vh); if (d1 < lMin) { lMin = d1; lBest = name; }
        const d2 = hamming(rHash, vh); if (d2 < rMin) { rMin = d2; rBest = name; }
      });
    }
    
    // 排错日志：直接打印出每一楼的最优匹配和误差值
    log(`左${i+1} 最佳匹配: ${lBest} (误差 ${lMin}) -> ${lMin <= BP_PARAMS.MATCH_THRESHOLD ? '✅通过' : '❌丢弃'}`);
    log(`右${i+1} 最佳匹配: ${rBest} (误差 ${rMin}) -> ${rMin <= BP_PARAMS.MATCH_THRESHOLD ? '✅通过' : '❌丢弃'}`);

    leftNames.push(lMin <= BP_PARAMS.MATCH_THRESHOLD ? lBest : null);
    rightNames.push(rMin <= BP_PARAMS.MATCH_THRESHOLD ? rBest : null);
  }
  log("------------------------");
  return { leftNames, rightNames };
}

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

function getWr(idStr, pos, period) {
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

function calcFeatures(name, pos, wr, myT, enT) {
  const ana = anaCache[heroDict[name]] || { counters: [], counteredBy: [], goodSynergies: [], badSynergies: [] };
  const getVal = (arr, t) => (arr.find(i => i.heroName === t) || {}).advantageIndex || (arr.find(i => i.heroName === t) || {}).synergyIndex || 0;
  
  let pAdv = [], nAdv = 0;
  enT.forEach(([eName, ePos]) => {
    let v = getVal(ana.counters, eName) || getVal(ana.counteredBy, eName);
    if (v > 0) pAdv.push(ePos === pos ? v * 1.0605 : v);
    else if (v < 0) nAdv += ((v/100) * (1 + Math.abs(v/100)*7.8882) * 100) * (ePos === pos ? 1.0605 : 1);
  });
  pAdv.sort((a,b)=>b-a);
  const cScore = (pAdv[0]||0) + (pAdv[1]||0)*0.5649 + pAdv.slice(2).reduce((a,b)=>a+b*0.1178,0) + nAdv;

  const synScore = myT.reduce((acc, [tName]) => acc + (tName !== name ? (getVal(ana.goodSynergies, tName) || getVal(ana.badSynergies, tName)) : 0), 0);
  return [cScore, synScore * Math.max(0, 1 - Math.abs(wr - 0.5) * 5.8843)];
}

function predictWr(myT, enT, period = null) {
  let ml = [], el = [], tC = 0, tS = 0;
  myT.forEach(([n, p]) => {
    let wr = getWr(heroDict[n], p, period); ml.push(Math.log(wr/(1-wr)));
    const [c, s] = calcFeatures(n, p, wr, myT, enT); tC+=c; tS+=s;
  });
  enT.forEach(([n, p]) => {
    let wr = getWr(heroDict[n], p, period); el.push(Math.log(wr/(1-wr)));
    const [c, s] = calcFeatures(n, p, wr, enT, myT); tC-=c; tS-=s;
  });
  const avgM = ml.length ? ml.reduce((a,b)=>a+b,0)/ml.length : 0;
  const avgE = el.length ? el.reduce((a,b)=>a+b,0)/el.length : 0;
  return (1 / (1 + Math.exp(-(1.1811*(avgM-avgE) + 1.2668*(tC/100) + 1.3774*(tS/200))))) * 100;
}

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

    log(`✅ 智能推演完毕。\n【我方】: ${myTeam.map(h=>`${h[0]}(${h[1]})`).join(', ') || '空'}\n【敌方】: ${enemyTeam.map(h=>`${h[0]}(${h[1]})`).join(', ') || '空'}\n`);

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
      res.sort((a,b)=>b.score-a.score).slice(0,3).forEach(r => html += `<div class="hero-item">${r.name} [融入胜率: ${r.score.toFixed(1)}%]</div>`);
    }
  }
  rc.innerHTML = html;
}

async function showFinal() {
  log("【数据维度】整体胜率(天元之弈日更) | 强势期(近一月推演)\n");
  log(`【预测胜率】我方 ${predictWr(myTeam, enemyTeam).toFixed(1)}% | 敌方 ${(100-predictWr(myTeam, enemyTeam)).toFixed(1)}%`);
  log(`【时段走势】前(${predictWr(myTeam, enemyTeam, 'e').toFixed(1)}%) -> 中(${predictWr(myTeam, enemyTeam, 'm').toFixed(1)}%) -> 后(${predictWr(myTeam, enemyTeam, 'l').toFixed(1)}%)`);

  const uH = myTeam.find(h => h[1] === userPosition);
  if (uH) {
    log(`\n=== 专属战术板：${uH[0]} ===`);
    const idStr = String(heroDict[uH[0]]);
    const periods = periodCache[idStr] || [];
    log("【强势期】" + (periods.length ? periods.map(p => `${p.durationRange}(${p.winRate.toFixed(1)}%)`).join(' / ') : "暂无"));
    const equips = (equipCache[idStr] || {})[uH[1]] || [];
    log("【优选装备】\n" + (equips.length ? equips.slice(0,3).map(e => ` - ${e.equipmentName} (登场率${e.pickRate.toFixed(1)}%, 胜率${e.winRate.toFixed(1)}%)`).join('\n') : "暂无"));
  } else log(`\n⚠️ 警告：检测系统未把我方任何人推演至你的预设分路(${userPosition})。`);
}
