import json, requests, hashlib, os, time
from PIL import Image, ImageDraw
from io import BytesIO

HEADERS = {'User-Agent': 'Mozilla/5.0'}
OFFICIAL_HEROLIST_URL = 'https://pvp.qq.com/web201605/js/herolist.json'
OFFICIAL_AVATAR_URL = 'https://game.gtimg.cn/images/yxzj/img201606/heroimg/{eid}/{eid}.jpg'

MASK_REGIONS = [(0.00, 0.00, 0.19, 0.32), (0.26, 0.72, 0.71, 1.00)]
GRAY_VALUE = 128
VARIANT_SCALES = [1.00, 0.92, 0.85, 0.78, 0.70]
CACHE_DIR = "data"

def calc_dhash(img):
    img = img.convert("L").resize((9, 8), Image.Resampling.BILINEAR)
    pixels = list(img.getdata())
    hex_str = ""
    for r in range(8):
        bits = "".join('1' if pixels[r*9 + c] > pixels[r*9 + c + 1] else '0' for c in range(8))
        hex_str += f"{int(bits, 2):02x}"
    return hex_str

def apply_mask_and_crop(img, scale):
    if scale < 1.0:
        w, h = img.size
        nw, nh = int(w * scale), int(h * scale)
        l, t = (w - nw) // 2, (h - nh) // 2
        img = img.crop((l, t, l + nw, t + nh))
    img = img.convert("RGB")
    w, h = img.size
    draw = ImageDraw.Draw(img)
    for (l, t, r, b) in MASK_REGIONS:
        draw.rectangle((int(w * l), int(h * t), int(w * r), int(h * b)), fill=(GRAY_VALUE,)*3)
    return img

def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    md5_file, hash_file = f"{CACHE_DIR}/avatar_md5.json", f"{CACHE_DIR}/hero_hashes.json"
    
    avatar_md5 = json.load(open(md5_file)) if os.path.exists(md5_file) else {}
    hero_hashes = json.load(open(hash_file)) if os.path.exists(hash_file) else {}
    heroes = requests.get(OFFICIAL_HEROLIST_URL, headers=HEADERS).json()
    updated = 0

    for idx, h in enumerate(heroes, 1):
        hero_id, name = str(h['ename']), h.get('cname', '未知')
        for _ in range(3):
            try:
                img_bytes = requests.get(OFFICIAL_AVATAR_URL.format(eid=hero_id), headers=HEADERS, timeout=5).content
                break
            except: time.sleep(1)
        else: continue
            
        current_md5 = hashlib.md5(img_bytes).hexdigest()
        # 注意这里：用 name 替代了 hero_id
        if name in avatar_md5 and avatar_md5[name] == current_md5 and name in hero_hashes:
            continue
            
        print(f"[{idx}/{len(heroes)}] 更新: {name}")
        img = Image.open(BytesIO(img_bytes)).convert("RGB")
        hero_hashes[name] = [calc_dhash(apply_mask_and_crop(img, s)) for s in VARIANT_SCALES]
        avatar_md5[name] = current_md5
        updated += 1

    if updated > 0:
        json.dump(hero_hashes, open(hash_file, "w"), indent=2, ensure_ascii=False)
        json.dump(avatar_md5, open(md5_file, "w"), indent=2, ensure_ascii=False)
        print(f"✅ 更新了 {updated} 个英雄。")

if __name__ == "__main__":
    main()
