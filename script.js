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

// ================= 识别参数（与 Python 成功版完全对齐） =================
const BP_PARAMS = {
  PICK_Y: [0.171, 0.330, 0.491, 0.652, 0.814],
  PICK_X_L: 0.192, PICK_X_R: 0.194, SIDE: 0.118,
  MASK: [[0.00, 0.00, 0.19, 0.32], [0.26, 0.72, 0.71, 1.00]],
  MATCH_THRESHOLD: 10,
  PHASE1_PASS: 10
};

// ================= 智能自适应搜索网格 =================
const PHASE1_GRID = [];
const PHASE2_GRID = [];

// 扩大的搜索范围：应对各种刘海屏和不同屏幕比例（最高支持 ±35% 头像宽度的偏差）
const scales = [1.00, 0.95, 1.05, 0.90, 1.10, 0.85, 1.15, 1.20, 0.80];
const dx_list = [0, 0.03, -0.03, 0.08, -0.08, 0.15, -0.15, 0.25, -0.25, 0.35, -0.35];
const dy_list = [0, 0.03, -0.03, 0.08, -0.08, 0.15, -0.15, -0.20];

const all_transforms = [];
for (const s of scales) {
  for (const dx of dx_list) {
    for (const dy of dy_list) {
      // 计算惩罚权重：距离中心越远、缩放越极端的组合，延后搜索
      const weight = Math.abs(1 - s) * 10 + Math.abs(dx) + Math.abs(dy);
      all_transforms.push({ scale: s, dx, dy, weight });
    }
  }
}
// 按权重升序（水波纹式搜索：优先匹配标准坐标，保证性能）
all_transforms.sort((a, b) => a.weight - b.weight);

// 前 20% 分配给一阶段快速搜索，剩余 80% 作为二阶段深度兜底
const splitIndex = Math.floor(all_transforms.length * 0.2);
PHASE1_GRID.push(...all_transforms.slice(0, splitIndex));
PHASE2_GRID.push(...all_transforms.slice(splitIndex));

// ================= 汉明距离 =================
function hammingDistance(h1, h2) {
  const a = h1.toLowerCase().replace(/^0x/, '');
  const b = h2.toLowerCase().replace(/^0x/, '');
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const val = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += val.toString(2).split('1').length - 1;
  }
  return dist;
}

// ================= 一维 DCT =================
function dct1D(arr) {
  const N = arr.length;
  const result = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += arr[n] * Math.cos(Math.PI / N * (n + 0.5) * k);
    }
    result[k] = sum * 2;
  }
  return result;
}

// ================= 二维 DCT =================
function dct2D(matrix) {
  const N = matrix.length;
  const rowDct = [];
  for (let r = 0; r < N; r++) {
    rowDct.push(dct1D(matrix[r]));
  }
  const result = [];
  for (let c = 0; c < N; c++) {
    const col = new Float32Array(N);
    for (let r = 0; r < N; r++) {
      col[r] = rowDct[r][c];
    }
    result.push(dct1D(col));
  }
  const finalMatrix = [];
  for (let r = 0; r < N; r++) {
    const row = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      row[c] = result[c][r];
    }
    finalMatrix.push(row);
  }
  return finalMatrix;
}

// ================= 自实现 pHash =================
function computePhash(imgData) {
  if (imgData.width !== 32 || imgData.height !== 32) {
    throw new Error("pHash 需要 32x32 的输入图像");
  }
  const pixels = imgData.data;
  const gray = new Float32Array(32 * 32);
  for (let i = 0; i < 32 * 32; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    gray[i] = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
  }

  const matrix = [];
  for (let r = 0; r < 32; r++) {
    const row = new Float32Array(32);
    for (let c = 0; c < 32; c++) {
      row[c] = gray[r * 32 + c];
    }
    matrix.push(row);
  }

  const dctMatrix = dct2D(matrix);

  const lowFreq = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      lowFreq.push(dctMatrix[r][c]);
    }
  }

  const sorted = [...lowFreq].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2.0;

  let hash = "";
  for (let i = 0; i < 64; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      if (lowFreq[i + j] > median) {
        byte |= (1 << (7 - j));
      }
    }
    hash += byte.toString(16).padStart(2, '0');
  }
  return hash;
}

// ================= 裁剪 + 遮罩 + 缩放 + pHash =================
function cropAndPhash(ctx, imgW, imgH, isLeft, index, scale, dx, dy) {
  let side = Math.max(24, Math.round(imgH * BP_PARAMS.SIDE));
  let centerY = Math.round(imgH * BP_PARAMS.PICK_Y[index]);
  let ratio = isLeft ? BP_PARAMS.PICK_X_L : BP_PARAMS.PICK_X_R;
  let offset = Math.round(imgH * ratio);
  let cx = isLeft ? offset : imgW - offset;
  let half = Math.floor(side / 2);
  let left = Math.max(0, cx - half);
  let top = Math.max(0, centerY - half);
  let right = Math.min(imgW, cx - half + side);
  let bottom = Math.min(imgH, centerY - half + side);
  let w = right - left;
  let h = bottom - top;
  let centerX = left + w / 2;
  let centerY2 = top + h / 2;

  let nw = w * scale;
  let nh = h * scale;
  let n_left = centerX - nw / 2 + dx * w;
  let n_top = centerY2 - nh / 2 + dy * h;

  let final_l = Math.trunc(n_left);
  let final_t = Math.trunc(n_top);
  let final_r = Math.trunc(n_left + nw);
  let final_b = Math.trunc(n_top + nh);
  let final_w = final_r - final_l;
  let final_h = final_b - final_t;

  if (final_w <= 0 || final_h <= 0) return null;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = final_w;
  cropCanvas.height = final_h;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  cropCtx.drawImage(ctx.canvas, final_l, final_t, final_w, final_h, 0, 0, final_w, final_h);

  const cropData = cropCtx.getImageData(0, 0, final_w, final_h);
  BP_PARAMS.MASK.forEach(([ml, mt, mr, mb]) => {
    const sl = Math.floor(final_w * ml);
    const sr = Math.floor(final_w * mr);
    const st = Math.floor(final_h * mt);
    const sb = Math.floor(final_h * mb);
    for (let y = st; y < sb; y++) {
      for (let x = sl; x < sr; x++) {
        const i = (y * final_w + x) * 4;
        cropData.data[i] = cropData.data[i+1] = cropData.data[i+2] = 128;
      }
    }
  });
  cropCtx.putImageData(cropData, 0, 0);

  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = 32;
  resizeCanvas.height = 32;
  const resizeCtx = resizeCanvas.getContext('2d', { willReadFrequently: true });
  resizeCtx.imageSmoothingEnabled = true;
  resizeCtx.imageSmoothingQuality = 'high';
  resizeCtx.drawImage(cropCanvas, 0, 0, final_w, final_h, 0, 0, 32, 32);
  const resizedData = resizeCtx.getImageData(0, 0, 32, 32);

  return computePhash(resizedData);
}

// ================= 网格搜索（返回英雄名字） =================
function runGridSearch(ctx, imgW, imgH, isLeft, index, grid) {
  let bestId = null;
  let bestDist = 999;
  for (const { scale, dx, dy } of grid) {
    const hash = cropAndPhash(ctx, imgW, imgH, isLeft, index, scale, dx, dy);
    if (!hash) continue;
    for (const [heroId, variants] of Object.entries(hashLib)) {
      for (const vh of variants) {
        const d = hammingDistance(hash, vh);
        if (d < bestDist) {
          bestDist = d;
          bestId = heroId;
          // 由于网格按权重排序，一旦在 ±2 距离内匹配成功，说明必然找到了正确英雄，直接返回极速放行
          if (bestDist <= 2) return { id: bestId, dist: bestDist, name: idToName[bestId] || bestId };
        }
      }
    }
  }
  return { id: bestId, dist: bestDist, name: bestId ? (idToName[bestId] || bestId) : null };
}

// ================= 识别主流程 =================
function recognizeImg(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  log(`图片尺寸: ${img.width} x ${img.height}`);
  log("--- 开始图像识别 ---");

  const leftNames = [], rightNames = [];
  for (let i = 0; i < 5; i++) {
    // 左槽位
    let lRes = runGridSearch(ctx, img.width, img.height, true, i, PHASE1_GRID);
    if (lRes.dist > BP_PARAMS.PHASE1_PASS) {
      const p2Res = runGridSearch(ctx, img.width, img.height, true, i, PHASE2_GRID);
      if (p2Res.dist < lRes.dist) lRes = p2Res;
    }
    // 右槽位
    let rRes = runGridSearch(ctx, img.width, img.height, false, i, PHASE1_GRID);
    if (rRes.dist > BP_PARAMS.PHASE1_PASS) {
      const p2Res = runGridSearch(ctx, img.width, img.height, false, i, PHASE2_GRID);
      if (p2Res.dist < rRes.dist) rRes = p2Res;
    }

    const lName = (lRes.dist <= BP_PARAMS.MATCH_THRESHOLD && lRes.name) ? lRes.name : null;
    const rName = (rRes.dist <= BP_PARAMS.MATCH_THRESHOLD && rRes.name) ? rRes.name : null;

    log(`左${i+1}: ${lName || '未识别'} (距离 ${lRes.dist}) ${lRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? '✅' : '❌'}`);
    log(`右${i+1}: ${rName || '未识别'} (距离 ${rRes.dist}) ${rRes.dist <= BP_PARAMS.MATCH_THRESHOLD ? '✅' : '❌'}`);

    leftNames.push(lName);
    rightNames.push(rName);
  }

  log("------------------------");
  return { leftNames, rightNames };
}

// ================= 数据推演与胜率核心 =================
function assignPos(teamNames) {
  // teamNames 是英雄名字数组（可能包含 null）
  const team = [];
  const prefs = teamNames.filter(n => n).map(name => {
    return { name, p: posCache[heroDict[name]] || {} };
  }).sort((a, b) => Math.max(0, ...Object.values(b.p)) - Math.max(0, ...Object.values(a.p)));

  const avail = [...POSITIONS];
  prefs.forEach(h => {
    const sortedP = Object.entries(h.p).sort((x, y) => y[1] - x[1]);
    const found = sortedP.find(([pos]) => avail.includes(pos));
    const finalPos = found ? found[0] : (avail.shift() || "未知");
    if (found) avail.splice(avail.indexOf(finalPos), 1);
    team.push([h.name, finalPos]);
  });
  return team;
}

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
    await new Promise(r => setTimeout(r, 50)); 

    const { leftNames, rightNames } = recognizeImg(img);
    myTeam = assignPos(leftNames); enemyTeam = assignPos(rightNames);
    
    myTeam.sort((a, b) => POSITIONS.indexOf(a[1]) - POSITIONS.indexOf(b[1]));
    enemyTeam.sort((a, b) => POSITIONS.indexOf(a[1]) - POSITIONS.indexOf(b[1]));
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
      res.sort((a,b)=>b.score-a.score).filter(r => r.score >= 50).forEach(r => html += `<div class="hero-item">${r.name} [融入胜率: ${r.score.toFixed(2)}%]</div>`);
    }
  }
  rc.innerHTML = html;
}

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

    enemyTeam.forEach(([eName, ePos]) => {
      if (!eName) return;
      const rawV = getRawIndex(hName, eName, 'counter');
      const samePosStr = (ePos === hPos) ? " (同分路)" : "";
      if (rawV > 0) log(`   对位 ${eName}: 克制 指数 ${formatSign(rawV)}${samePosStr}`);
      else if (rawV < 0) log(`   对位 ${eName}: 被克制 指数 ${formatSign(rawV)}${samePosStr}`);
      else log(`   对位 ${eName}: 无克制 指数 0.00%${samePosStr}`);
    });

    myTeam.forEach(([tName, tPos]) => {
      if (!tName || tName === hName) return;
      const rawV = getRawIndex(hName, tName, 'synergy');
      if (rawV > 0) log(`   配合 ${tName}: 优异 指数 ${formatSign(rawV)}`);
      else if (rawV < 0) log(`   配合 ${tName}: 冲突 指数 ${formatSign(rawV)}`);
    });
  }

  const uH = myTeam.find(h => h[1] === userPosition);
  if (uH) {
    const idStr = String(heroDict[uH[0]]);
    log(`\n【出装推荐】${uH[0]} (${uH[1]})`);
    const equips = (equipCache[idStr] || {})[uH[1]] || [];
    
    const validEquips = equips.filter(e => e.pickRate >= 10).sort((a, b) => b.pickRate - a.pickRate);
    
    if (validEquips.length) {
      validEquips.forEach(e => log(`${e.equipmentName} 登场率:${e.pickRate.toFixed(2)}% 胜率:${e.winRate.toFixed(2)}%`));
    } else log("暂无出场率大于10%的有效出装数据");

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
