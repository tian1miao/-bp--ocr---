import requests, json, os, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://tianyuanzhiyi.com/api"
CACHE_DIR = "data"
POS_MAP = {"0": "对抗路", "1": "中路", "2": "发育路", "3": "打野", "4": "辅助"}
POS_NUM = {v: k for k, v in POS_MAP.items()}
TARGET_DATE = (datetime.datetime.now() - datetime.timedelta(days=2 if datetime.datetime.now().hour < 8 else 1)).strftime("%Y-%m-%d")

sess = requests.Session()
sess.mount("http://", HTTPAdapter(max_retries=Retry(total=2, backoff_factor=0.3)))
sess.mount("https://", HTTPAdapter(max_retries=Retry(total=2, backoff_factor=0.3)))
sess.headers.update({"x-external-auth": "1145141919810"})

def fetch_json(url, default=None):
    try: return sess.get(url, timeout=10).json()
    except: return default

def get_fallback_wr(h_id, h_name, pos, h_dict):
    opponents = [("狂铁", "0"), ("沈梦溪", "1"), ("敖隐", "2"), ("裴擒虎", "3"), ("少司缘", "4")]
    p_num = POS_NUM.get(pos)
    if not p_num: return None
    for op_n, op_p in opponents:
        if op_n in h_dict and op_n != h_name:
            res = fetch_json(f"{BASE_URL}/match/find?camp1Heroes={json.dumps({p_num:h_id})}&camp2Heroes={json.dumps({op_p:h_dict[op_n]})}&days=30", {})
            for c in res.get("heroComparisons", []):
                if c.get("heroName") == h_name and c.get("averageWinRate"):
                    wr = float(c["averageWinRate"])
                    return max(0.01, min(0.99, wr/100 if wr > 1 else wr))
    return None

def process_hero(h_id, h_name, h_dict):
    p_res, w_res, a_res, e_res = {}, {}, {"counters": [], "counteredBy": [], "goodSynergies": [], "badSynergies": []}, {}
    
    c_data = fetch_json(f"{BASE_URL}/herostats/combined?heroId={h_id}&date={TARGET_DATE}", {}).get("positions", {})
    for k, v in c_data.items():
        if POS_MAP.get(k):
            if v.get("pickRate"): p_res[POS_MAP[k]] = round(float(v["pickRate"]), 2)
            if v.get("winRate"): w_res[POS_MAP[k]] = max(0.01, min(0.99, float(v["winRate"])/100 if float(v["winRate"]) > 1 else float(v["winRate"])))

    a_res = fetch_json(f"{BASE_URL}/hero/analysis?heroId={h_id}", a_res)
    pd_res = fetch_json(f"{BASE_URL}/detail/specifyheroperiod?heroId={h_id}", {}).get("winRateByDuration", [])

    for p in list(POS_MAP.values()):
        if p not in w_res:
            fb = get_fallback_wr(h_id, h_name, p, h_dict)
            if fb: w_res[p] = fb
        if p_res.get(p, 0) >= 10:
            eq = fetch_json(f"{BASE_URL}/hero/equip?date={TARGET_DATE}&heroId={h_id}&position={POS_NUM[p]}", {}).get("equipmentWinRates", [])
            e_res[p] = sorted([e for e in eq if e.get("pickRate",0) > 10], key=lambda x: x.get("pickRate",0), reverse=True)

    return str(h_id), p_res, w_res, a_res, pd_res, e_res

def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    h_dict = {h["name"]: h["id"] for h in fetch_json(f"{BASE_URL}/allheroes", [])}
    json.dump(h_dict, open(f"{CACHE_DIR}/hero_list.json", "w"), ensure_ascii=False)
    
    p_c, w_c, a_c, pd_c, e_c = {}, {}, {}, {}, {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(process_hero, v, k, h_dict): k for k, v in h_dict.items()}
        for f in as_completed(futures):
            try:
                i, pr, wr, ar, pdr, er = f.result()
                p_c[i], w_c[i], a_c[i], pd_c[i], e_c[i] = pr, wr, ar, pdr, er
            except: pass

    for name, d in zip(["position","win_rate","hero_analysis","hero_period","equip"], [p_c, w_c, a_c, pd_c, e_c]):
        json.dump(d, open(f"{CACHE_DIR}/{name}_cache.json", "w"), ensure_ascii=False)

if __name__ == "__main__":
    main()
