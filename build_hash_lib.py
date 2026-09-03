import json
import requests
from PIL import Image, ImageDraw
from io import BytesIO
import imagehash
import time
import os

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

OFFICIAL_HEROLIST_URL = 'https://pvp.qq.com/web201605/js/herolist.json'
OFFICIAL_AVATAR_URL = 'https://game.gtimg.cn/images/yxzj/img201606/heroimg/{eid}/{eid}.jpg'

MASK_REGIONS = [
    (0.00, 0.00, 0.19, 0.32),
    (0.26, 0.72, 0.71, 1.00),
]
GRAY_VALUE = 128
VARIANT_SCALES = [1.00, 0.92, 0.85, 0.78, 0.70]

def center_crop(img, scale):
    if scale >= 1.0: return img
    w, h = img.size
    nw, nh = int(w * scale), int(h * scale)
    l, t = (w - nw) // 2, (h - nh) // 2
    return img.crop((l, t, l + nw, t + nh))

def apply_mask(img):
    img = img.convert("RGB").copy()
    w, h = img.size
    draw = ImageDraw.Draw(img)
    for (l, t, r, b) in MASK_REGIONS:
        draw.rectangle(
            (int(w * l), int(h * t), int(w * r), int(h * b)),
            fill=(GRAY_VALUE, GRAY_VALUE, GRAY_VALUE),
        )
    return img

def download_image(url, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=(3, 7))
            resp.raise_for_status()
            return Image.open(BytesIO(resp.content)).convert("RGB")
        except Exception:
            time.sleep(1)
    return None

def build_hash_library():
    print("开始生成英雄 pHash 指纹库...")
    try:
        heroes = requests.get(OFFICIAL_HEROLIST_URL, headers=HEADERS).json()
    except:
        return print("官方列表获取失败")

    hero_hashes = {}
    for idx, h in enumerate(heroes, 1):
        hero_id, name = str(h['ename']), h.get('cname', '未知')
        img = download_image(OFFICIAL_AVATAR_URL.format(eid=hero_id))
        if not img: continue
        
        variants = []
        for scale in VARIANT_SCALES:
            masked = apply_mask(center_crop(img, scale))
            variants.append(str(imagehash.phash(masked, hash_size=8, highfreq_factor=4)))
        hero_hashes[hero_id] = variants
        print(f"[{idx}/{len(heroes)}] {name} 指纹生成完毕")

    os.makedirs("data", exist_ok=True)
    with open("data/hero_hashes.json", "w", encoding="utf-8") as f:
        json.dump(hero_hashes, f, indent=4)
    print("✅ 指纹库已保存至 data/hero_hashes.json")

if __name__ == "__main__":
    build_hash_library()
