import requests
import json
import os
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ================= 基础配置 =================
BASE_URL = "https://tianyuanzhiyi.com/api"
CACHE_DIR = "data"
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {"x-external-auth": "1145141919810"}

POSITION_MAP = {"0": "对抗路", "1": "中路", "2": "发育路", "3": "打野", "4": "辅助"}
POSITIONS = list(POSITION_MAP.values())
POSITION_TO_NUM = {v: k for k, v in POSITION_MAP.items()}

now = datetime.datetime.now()
days_ago = 2 if now.hour < 8 else 1
TARGET_DATE = (now.date() - datetime.timedelta(days=days_ago)).strftime("%Y-%m-%d")

session = requests.Session()
retry_strategy = Retry(
    total=2,
    backoff_factor=0.3,
    status_forcelist=[429, 500, 502, 503, 504],
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("http://", adapter)
session.mount("https://", adapter)
session.headers.update(HEADERS)

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_json(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def get_all_heroes():
    resp = session.get(f"{BASE_URL}/allheroes", timeout=15)
    resp.raise_for_status()
    heroes = resp.json()
    hero_dict = {h["name"]: h["id"] for h in heroes}
    return hero_dict

def get_global_winrate():
    try:
        resp = session.get(f"{BASE_URL}/global/winrate?date={TARGET_DATE}", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        blue = float(data.get("blueTeamWinRate", 50.45))
        red = float(data.get("redTeamWinRate", 100 - blue))
        return {TARGET_DATE: {"blue": blue, "red": red}}
    except Exception:
        return {TARGET_DATE: {"blue": 50.0, "red": 50.0}}

def get_hero_combined(hero_id):
    url = f"{BASE_URL}/herostats/combined?heroId={hero_id}&date={TARGET_DATE}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    data = resp.json().get("positions", {})
    pos_result = {}
    wr_result = {}
    for key, value in data.items():
        role = POSITION_MAP.get(key)
        if not role:
            continue
        pick_raw = value.get("pickRate")
        if pick_raw is not None:
            pos_result[role] = round(float(pick_raw), 2)
        wr_raw = value.get("winRate")
        if wr_raw is not None:
            try:
                wr = float(wr_raw)
                wr = max(0.01, min(0.99, wr / 100 if wr > 1 else wr))
                wr_result[role] = wr
            except (TypeError, ValueError):
                pass
    return pos_result, wr_result

def get_hero_analysis(hero_id):
    url = f"{BASE_URL}/hero/analysis?heroId={hero_id}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    return resp.json()

def get_hero_period(hero_id):
    url = f"{BASE_URL}/detail/specifyheroperiod?heroId={hero_id}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    periods = resp.json().get("winRateByDuration", [])
    return periods

def get_hero_equip(hero_id, position_num):
    url = f"{BASE_URL}/hero/equip?date={TARGET_DATE}&heroId={hero_id}&position={position_num}"
    resp = session.get(url, timeout=8)
    resp.raise_for_status()
    equip_data = resp.json().get("equipmentWinRates", [])
    filtered = [e for e in equip_data if e.get("pickRate", 0) > 10]
    filtered.sort(key=lambda x: x.get("pickRate", 0), reverse=True)
    return filtered

def get_fallback_winrate(hero_id, hero_name, target_position, hero_dict):
    fallback_opponents = [
        ("狂铁", "0"), ("沈梦溪", "1"), ("敖隐", "2"), ("裴擒虎", "3"), ("少司缘", "4")
    ]
    pos_num = POSITION_TO_NUM.get(target_position)
    if not pos_num:
        return None

    for opp_name, opp_pos_num in fallback_opponents:
        if opp_name not in hero_dict or opp_name == hero_name:
            continue
        try:
            camp1 = {pos_num: hero_id}
            camp2 = {opp_pos_num: hero_dict[opp_name]}
            params = {
                "camp1Heroes": json.dumps(camp1, separators=(',', ':')),
                "camp2Heroes": json.dumps(camp2, separators=(',', ':')),
                "days": 30
            }
            resp = session.get(f"{BASE_URL}/match/find", params=params, timeout=6)
            resp.raise_for_status()
            comps = resp.json().get("heroComparisons", [])
            target_comp = next((c for c in comps if c.get('heroName') == hero_name), None)
            if target_comp:
                raw_wr = target_comp.get("averageWinRate")
                if raw_wr is None:
                    continue
                wr_value = float(raw_wr)
                if wr_value > 1.0:
                    wr_value = wr_value / 100.0
                if wr_value < 0.001:
                    continue
                wr_value = max(0.01, min(0.99, wr_value))
                return wr_value
        except Exception:
            continue
    return None

def process_hero(hero_id, hero_name, hero_dict):
    hero_id_str = str(hero_id)
    pos_res, wr_res = {}, {}
    ana_res = {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}
    period_res = []
    equip_res = {}

    try: pos_res, wr_res = get_hero_combined(hero_id)
    except Exception as e: print(f"⚠️ {hero_name} 获取 combined 失败")
    try: ana_res = get_hero_analysis(hero_id)
    except Exception as e: print(f"⚠️ {hero_name} 获取 analysis 失败")
    try: period_res = get_hero_period(hero_id)
    except Exception as e: print(f"⚠️ {hero_name} 获取 period 失败")

    missing_positions = [pos for pos in POSITIONS if pos not in wr_res]
    for pos in missing_positions:
        fallback_wr = get_fallback_winrate(hero_id, hero_name, pos, hero_dict)
        if fallback_wr is not None:
            wr_res[pos] = fallback_wr

    for pos_name, pos_num in POSITION_TO_NUM.items():
        if pos_res.get(pos_name, 0) >= 10:
            try:
                equip_list = get_hero_equip(hero_id, pos_num)
                if equip_list: equip_res[pos_name] = equip_list
            except Exception as e: pass

    return hero_id_str, pos_res, wr_res, ana_res, period_res, equip_res

def main():
    print("开始更新数据...")
    hero_dict = get_all_heroes()
    save_json(os.path.join(CACHE_DIR, "hero_list.json"), hero_dict)
    
    global_wr = get_global_winrate()
    global_path = os.path.join(CACHE_DIR, "global_win_rate_cache.json")
    old_global = load_json(global_path)
    old_global.update(global_wr)
    save_json(global_path, old_global)

    pos_cache, wr_cache, ana_cache, period_cache, equip_cache = {}, {}, {}, {}, {}
    hero_items = list(hero_dict.items())

    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_hero = {
            executor.submit(process_hero, hero_id, hero_name, hero_dict): (hero_name, hero_id)
            for hero_name, hero_id in hero_items
        }
        for future in as_completed(future_to_hero):
            hero_name, hero_id = future_to_hero[future]
            try:
                hero_id_str, pos_res, wr_res, ana_res, period_res, equip_res = future.result()
                pos_cache[hero_id_str] = pos_res
                wr_cache[hero_id_str] = wr_res
                ana_cache[hero_id_str] = ana_res
                period_cache[hero_id_str] = period_res
                equip_cache[hero_id_str] = equip_res
                print(f"✅ {hero_name} 完成")
            except Exception as e:
                hero_id_str = str(hero_id)
                pos_cache[hero_id_str] = {}
                wr_cache[hero_id_str] = {}
                ana_cache[hero_id_str] = {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}
                period_cache[hero_id_str] = []
                equip_cache[hero_id_str] = {}

    save_json(os.path.join(CACHE_DIR, "position_cache.json"), pos_cache)
    save_json(os.path.join(CACHE_DIR, "win_rate_cache.json"), wr_cache)
    save_json(os.path.join(CACHE_DIR, "hero_analysis_cache.json"), ana_cache)
    save_json(os.path.join(CACHE_DIR, "hero_period_cache.json"), period_cache)
    save_json(os.path.join(CACHE_DIR, "equip_cache.json"), equip_cache)
    print("✅ 数据更新完成！")

if __name__ == "__main__":
    main()
