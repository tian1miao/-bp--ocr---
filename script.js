// ================= 全局变量 =================
let heroDict = {};
let idToName = {};
let posCache = {};
let wrCache = {};
let anaCache = {};
let periodCache = {};
let globalWinRate = {};
let equipCache = {};
let qqIdToName = {}; 
let hashLib = {}; // 存放从 data/hero_hashes.json 加载的指纹库

const POSITION_MAP = {"0":"对抗路","1":"中路","2":"发育路","3":"打野","4":"辅助"};
const POSITIONS = Object.values(POSITION_MAP);

let myTeam = [];     // [ [英雄名, 分路], ... ]
let enemyTeam = [];
let myPositions = [];
let userPosition = ""; // 仅胜率预测模式使用
let isCalculating = false;

// ================= 工具函数 =================
function log(msg) {
  const logEl = document.getElementById('log-output');
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function formatAdvantage(adv) {
  return `${adv > 0 ? '+' : ''}${adv.toFixed(2)}%`;
}

// 辅助：解析 64 位 16 进制字符串，计算汉明距离
function hammingDistance(hex1, hex2) {
  let dist = 0;
  for (let i = 0; i < hex1.length; i++) {
    const val = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
    dist += val.toString(2).split('1').length - 1;
  }
  return dist;
}

// ================= 数据加载 =================
async function loadData() {
  try {
    const [heroesRes, posRes, wrRes, anaRes, periodRes, globalRes, equipRes, hashRes, qqRes] = await Promise.all([
      fetch('data/hero_list.json'),
      fetch('data/position_cache.json'),
      fetch('data/win_rate_cache.json'),
      fetch('data/hero_analysis_cache.json'),
      fetch('data/hero_period_cache.json'),
      fetch('data/global_win_rate_cache.json'),
      fetch('data/equip_cache.json'),
      fetch('data/hero_hashes.json').catch(() => ({json: () => ({})})), // 容错处理
      fetch('https://pvp.qq.com/web201605/js/herolist.json').catch(() => ({json: () => []}))
    ]);
    
    heroDict = await heroesRes.json();
    idToName = Object.fromEntries(Object.entries(heroDict).map(([k,v])=>[v,k]));
    posCache = await posRes.json();
    wrCache = await wrRes.json();
    anaCache = await anaRes.json();
    periodCache = await periodRes.json();
    globalWinRate = await globalRes.json();
    equipCache = await equipRes.json();
    hashLib = await hashRes.json();
    
    const qqData = await qqRes.json();
    qqData.forEach(h => qqIdToName[String(h.ename)] = h.cname);

    log('✅ 核心数据与指纹库加载成功');
  } catch (e) {
    log('❌ 数据加载失败，请检查文件路径或网络');
    console.error(e);
  }
}

// ================= 胜率与 BP 算法 =================
function getBaseWinrate(heroId, targetPosition) {
  const idStr = String(heroId);
  const wrMap = wrCache[idStr] || {};
  if (wrMap[targetPosition] !== undefined) {
    let wr = wrMap[targetPosition];
    if (wr > 1) wr /= 100;
    return Math.max(0.01, Math.min(0.99, wr));
  }
  return 0.5; // 默认平庸胜率
}

function getPeriodWinrate(heroId, periodKey) {
  const idStr = String(heroId);
  const periods = periodCache[idStr] || [];
  if (!periods.length) return 0.5;
  for (const p of periods) {
    const dr = p.durationRange || '';
    let wr = null;
    if (periodKey === 'early' && dr.includes('0-12')) wr = p.winRate;
    else if (periodKey === 'mid' && dr.includes('12-18')) wr = p.winRate;
    else if (periodKey === 'late' && dr.includes('18') && !dr.includes('12-18')) wr = p.winRate;
    if (wr !== null) {
      if (wr > 1) wr /= 100;
      return Math.max(0.01, Math.min(0.99, wr));
    }
  }
  return 0.5;
}

function computeHeroFeatures(heroName, heroPos, heroWr, team, enemyTeam) {
  const heroId = heroDict[heroName];
  const analysis = anaCache[String(heroId)] || { counters: [], counteredBy: [], goodSynergies: [], badSynergies: [] };
  const discount = Math.max(0, 1 - Math.abs(heroWr - 0.5) * 5.8843);

  const counters = {}, counteredBy = {};
  analysis.counters.forEach(item => counters[item.heroName] = item.advantageIndex);
  analysis.counteredBy.forEach(item => counteredBy[item.heroName] = item.advantageIndex);

  let posAdvList = [], negAdvSum = 0;
  for (const [eName, ePos] of enemyTeam) {
    let adv = counters[eName] || counteredBy[eName] || 0;
    if (adv > 0) {
      if (ePos === heroPos) adv *= 1.0605;
      posAdvList.push(adv);
    } else if (adv < 0) {
      let R = adv / 100;
      let penalized = (R * (1 + Math.abs(R) * 7.8882)) * 100;
      if (ePos === heroPos) penalized *= 1.0605;
      negAdvSum += penalized;
    }
  }
  posAdvList.sort((a,b)=>b-a);
  let decayedPosAdv = 0;
  posAdvList.forEach((val, idx) => {
    if (idx === 0) decayedPosAdv += val * 1.0;
    else if (idx === 1) decayedPosAdv += val * 0.5649;
    else decayedPosAdv += val * 0.1178;
  });

  const goodSyn = {}, badSyn = {};
  analysis.goodSynergies.forEach(item => goodSyn[item.heroName] = item.synergyIndex);
  analysis.badSynergies.forEach(item => badSyn[item.heroName] = item.synergyIndex);

  let discountedCombo = 0;
  for (const [tName] of team) {
    if (tName !== heroName) {
      const syn = goodSyn[tName] || badSyn[tName] || 0;
      discountedCombo += syn * discount;
    }
  }
  return [decayedPosAdv + negAdvSum, discountedCombo];
}

async function predictLineupWinrate(myTeamArray, enemyTeamArray, periodKey = null) {
  let myLogits = [], enemyLogits = [];
  let totalCounterIndex = 0, totalComboIndex = 0;

  for (const [myName, myPos] of myTeamArray) {
    let wr = periodKey ? getPeriodWinrate(heroDict[myName], periodKey) : getBaseWinrate(heroDict[myName], myPos);
    myLogits.push(Math.log(wr / (1 - wr)));
    const [cScore, sScore] = computeHeroFeatures(myName, myPos, wr, myTeamArray, enemyTeamArray);
    totalCounterIndex += cScore;
    totalComboIndex += sScore;
  }
  for (const [eName, ePos] of enemyTeamArray) {
    let wr = periodKey ? getPeriodWinrate(heroDict[eName], periodKey) : getBaseWinrate(heroDict[eName], ePos);
    enemyLogits.push(Math.log(wr / (1 - wr)));
    const [cScore, sScore] = computeHeroFeatures(eName, ePos, wr, enemyTeamArray, myTeamArray);
    totalCounterIndex -= cScore;
    totalComboIndex -= sScore;
  }

  const S_counter = totalCounterIndex / 100;
  const S_combo = (totalComboIndex / 2) / 100;
  const avgMy = myLogits.length ? myLogits.reduce((a,b)=>a+b,0) / myLogits.length : 0;
  const avgEnemy = enemyLogits.length ? enemyLogits.reduce((a,b)=>a+b,0) / enemyLogits.length : 0;
  const S_hero = avgMy - avgEnemy;

  const S_total = 1.1811 * S_hero + 1.2668 * S_counter + 1.3774 * S_combo;
  return (1 / (1 + Math.exp(-S_total))) * 100;
}

// ================= 智能分路排雷分配系统 =================
function assignPositions(teamIds) {
  const team = [];
  const heroPrefs = teamIds.filter(id => id).map(id => {
    const name = qqIdToName[id] || idToName[id] || "未知英雄";
    const prefs = posCache[heroDict[name]] || {}; 
    return { name, prefs };
  });

  // 按英雄拥有的最高分路出场率降序，优先分配绝活哥
  heroPrefs.sort((a, b) => Math.max(0, ...Object.values(b.prefs)) - Math.max(0, ...Object.values(a.prefs)));

  const availablePos = [...POSITIONS];
  heroPrefs.forEach(hero => {
    const sortedPrefs = Object.entries(hero.prefs).sort((x, y) => y[1] - x[1]);
    let found = false;
    for (const [pos, rate] of sortedPrefs) {
      if (availablePos.includes(pos)) {
        team.push([hero.name, pos]);
        availablePos.splice(availablePos.indexOf(pos), 1);
        found = true;
        break;
      }
    }
    if (!found) {
      const fallback = availablePos.shift() || "未知"; 
      team.push([hero.name, fallback]);
    }
  });
  return team;
}

// ================= 纯前端图像指纹提取与匹配 =================
const BP_PARAMS = {
  PICK_Y: [0.171, 0.330, 0.491, 0.652, 0.814],
  PICK_SIDE_RATIO: 0.118,
  PICK_LEFT_EDGE_RATIO: 0.192,
  PICK_RIGHT_EDGE_RATIO: 0.194,
  MASK_REGIONS: [[0.00, 0.00, 0.19, 0.32], [0.26, 0.72, 0.71, 1.00]],
  GRAY_VALUE: 128,
  MATCH_THRESHOLD: 12 // 宽松容错，因JS hash与Python可能微小差异
};

function getCropRect(imgW, imgH, isLeft, index) {
  const side = Math.max(24, Math.round(imgH * BP_PARAMS.PICK_SIDE_RATIO));
  const centerY = Math.round(imgH * BP_PARAMS.PICK_Y[index]);
  const offset = Math.round(imgH * (isLeft ? BP_PARAMS.PICK_LEFT_EDGE_RATIO : BP_PARAMS.PICK_RIGHT_EDGE_RATIO));
  const cx = isLeft ? offset : imgW - offset;
  const half = Math.floor(side / 2);
  return { left: Math.max(0, cx - half), top: Math.max(0, centerY - half), width: side, height: side };
}

// 提取区域，应用 Mask，转灰度并获取 Blockhash
function extractHash(ctx, rect) {
  const { left, top, width, height } = rect;
  const imgData = ctx.getImageData(left, top, width, height);
  
  // 应用遮罩
  BP_PARAMS.MASK_REGIONS.forEach(([l, t, r, b]) => {
    const startX = Math.floor(width * l), endX = Math.floor(width * r);
    const startY = Math.floor(height * t), endY = Math.floor(height * b);
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4;
        imgData.data[idx] = BP_PARAMS.GRAY_VALUE;
        imgData.data[idx+1] = BP_PARAMS.GRAY_VALUE;
        imgData.data[idx+2] = BP_PARAMS.GRAY_VALUE;
      }
    }
  });
  
  return blockhash.bmvbhash(imgData, 8); // 使用引入的 blockhash 库生成 8x8 hash
}

async function recognizeHeroes(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const teamLeft = [], teamRight = [];
  
  // 简化的无变换匹配（因为纯前端性能考虑，暂时砍掉微调网格，依赖正规截图）
  for (let i = 0; i < 5; i++) {
    const lRect = getCropRect(img.width, img.height, true, i);
    const lHash = extractHash(ctx, lRect);
    let lBestId = null, lMinDist = 999;
    
    const rRect = getCropRect(img.width, img.height, false, i);
    const rHash = extractHash(ctx, rRect);
    let rBestId = null, rMinDist = 999;

    for (const [heroId, variants] of Object.entries(hashLib)) {
      for (const vh of variants) {
        const d1 = hammingDistance(lHash, vh);
        if (d1 < lMinDist) { lMinDist = d1; lBestId = heroId; }
        
        const d2 = hammingDistance(rHash, vh);
        if (d2 < rMinDist) { rMinDist = d2; rBestId = heroId; }
      }
    }
    teamLeft.push(lMinDist <= BP_PARAMS.MATCH_THRESHOLD ? lBestId : null);
    teamRight.push(rMinDist <= BP_PARAMS.MATCH_THRESHOLD ? rBestId : null);
  }
  return { team_left: teamLeft, team_right: teamRight };
}

// ================= 主控调度与输出 =================
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  document.getElementById('btn-consult').addEventListener('click', () => handleUpload('consult'));
  document.getElementById('btn-predict').addEventListener('click', () => handleUpload('predict'));
});

async function handleUpload(mode) {
  if (isCalculating) return;
  const inputId = mode === 'consult' ? 'upload-consult' : 'upload-predict';
  const fileInput = document.getElementById(inputId);
  if (!fileInput.files.length) { alert("请先选择图片！"); return; }
  
  if (mode === 'predict') {
    userPosition = document.getElementById('my-pos-select').value;
    if (!userPosition) { alert("模式二必须选择你的分路！"); return; }
  }

  isCalculating = true;
  const statusEl = document.getElementById('status-text');
  statusEl.textContent = '🔄 正在识别截图...';
  document.getElementById('log-output').textContent = ''; // 清空日志

  try {
    const file = fileInput.files[0];
    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = imgUrl;
    await new Promise(r => img.onload = r);

    const rawData = await recognizeHeroes(img);
    myTeam = assignPositions(rawData.team_left);
    enemyTeam = assignPositions(rawData.team_right);
    myPositions = myTeam.map(h => h[1]);

    const myStr = myTeam.map(h => `${h[0]}(${h[1]})`).join(', ');
    const eStr = enemyTeam.map(h => `${h[0]}(${h[1]})`).join(', ');
    log(`✅ 识别完成。\n【我方】: ${myStr || '空'}\n【敌方】: ${eStr || '空'}\n`);

    if (mode === 'consult') {
      statusEl.textContent = '✔️ 识别成功，已生成推荐在下方区域。';
      await showRecommendations();
    } else {
      if (myTeam.length < 5 || enemyTeam.length < 5) {
         log("⚠️ 警告：检测到双方阵容不完整，预测结果可能存在偏差。");
      }
      statusEl.textContent = '✔️ 识别成功，已生成分析日志。';
      await showFinalAnalysis();
    }
  } catch(e) {
    statusEl.textContent = '❌ 处理出错';
    console.error(e);
    alert('错误: ' + e.message);
  } finally {
    isCalculating = false;
  }
}

async function showRecommendations() {
  document.getElementById('rec-card').style.display = 'block';
  const recContent = document.getElementById('rec-content');
  const availablePositions = POSITIONS.filter(p => !myPositions.includes(p));
  if (availablePositions.length === 0) {
    recContent.innerHTML = '我方位置已满，请使用【模式二：胜率预测】分析终局。';
    return;
  }

  recContent.innerHTML = '正在推演计算...';
  const finalResults = {};
  for (const p of availablePositions) finalResults[p] = [];

  const pickedNames = new Set([...myTeam.map(h=>h[0]), ...enemyTeam.map(h=>h[0])]);

  for (const pos of availablePositions) {
    for (const [heroName, heroId] of Object.entries(heroDict)) {
      if (pickedNames.has(heroName)) continue;
      if ((posCache[heroId] || {})[pos] >= 10) {
        const simTeam = myTeam.concat([[heroName, pos]]);
        const wr = await predictLineupWinrate(simTeam, enemyTeam);
        finalResults[pos].push({ score: wr, name: heroName, id: heroId });
      }
    }
    finalResults[pos].sort((a,b)=>b.score-a.score);
  }

  let html = '';
  for (const pos of availablePositions) {
    if (!finalResults[pos].length) continue;
    html += `<div class="hero-group"><strong style="color:#d32f2f;">补位推荐: ${pos}</strong></div>`;
    for (const { score, name } of finalResults[pos].slice(0, 3)) {
      html += `<div class="hero-item"><span class="hero-item-main">${name} [融入胜率:${score.toFixed(2)}%]</span></div>`;
    }
  }
  recContent.innerHTML = html;
}

async function showFinalAnalysis() {
  log("【数据时效说明】\n整体胜率基于「昨日」天元之弈数据。\n强势期预测基于「近一月」数据。");
  
  const finalWr = await predictLineupWinrate(myTeam, enemyTeam);
  const earlyWr = await predictLineupWinrate(myTeam, enemyTeam, 'early');
  const midWr = await predictLineupWinrate(myTeam, enemyTeam, 'mid');
  const lateWr = await predictLineupWinrate(myTeam, enemyTeam, 'late');

  log(`\n=== 整体阵容评估 ===`);
  log(`【最终预测】我方胜率：${finalWr.toFixed(2)}% | 敌方：${(100-finalWr).toFixed(2)}%`);
  log(`【前期 (0-12m)】我方：${earlyWr.toFixed(2)}%`);
  log(`【中期 (12-18m)】我方：${midWr.toFixed(2)}%`);
  log(`【后期 (18m+)】我方：${lateWr.toFixed(2)}%`);

  // 用户专属推荐
  const userHero = myTeam.find(h => h[1] === userPosition);
  if (userHero) {
    const [uName, uPos] = userHero;
    log(`\n=== 专属打法指导：${uName} (${uPos}) ===`);
    const idStr = String(heroDict[uName]);
    
    // 强势期
    log("【发力期提示】");
    const periods = periodCache[idStr] || [];
    if (periods.length) {
      periods.forEach(item => log(` - ${item.durationRange} 胜率: ${item.winRate.toFixed(2)}%`));
    } else log(" - 暂无时段数据");

    // 出装
    log("【高胜率核心出装】");
    const equipList = (equipCache[idStr] || {})[uPos] || [];
    if (equipList.length) {
      equipList.slice(0,4).forEach(e => log(` - ${e.equipmentName} (登场率${e.pickRate.toFixed(1)}%, 胜率${e.winRate.toFixed(1)}%)`));
    } else log(" - 暂无出装数据");
  } else {
    log(`\n⚠️ 未在识别结果中找到你选的分路 (${userPosition})，请检查截图或分路选择。`);
  }
}
