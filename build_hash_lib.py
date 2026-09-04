import json
import requests
from PIL import Image, ImageDraw
from io import BytesIO
import imagehash
import time
import os
import hashlib

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
CACHE_DIR = "data"


def apply_mask_and_crop(img, scale):
    """居中裁切 + 遮罩"""
    if scale < 1.0:
        w, h = img.size
        nw, nh = int(w * scale), int(h * scale)
        l, t = (w - nw) // 2, (h - nh) // 2
        img = img.crop((l, t, l + nw, t + nh))
    img = img.convert("RGB").copy()
    w, h = img.size
    draw = ImageDraw.Draw(img)
    for (l, t, r, b) in MASK_REGIONS:
        draw.rectangle(
            (int(w * l), int(h * t), int(w * r), int(h * b)),
            fill=(GRAY_VALUE, GRAY_VALUE, GRAY_VALUE),
        )
    return img


def calc_phash(img):
    """计算 pHash（与 imagehash.phash 完全一致）"""
    return str(imagehash.phash(img, hash_size=8, highfreq_factor=4))


def build_hash_library():
    os.makedirs(CACHE_DIR, exist_ok=True)
    hash_file = os.path.join(CACHE_DIR, "hero_hashes.json")
    md5_file = os.path.join(CACHE_DIR, "avatar_md5.json")

    # 加载已有缓存（如果需要增量更新）
    avatar_md5 = {}
    if os.path.exists(md5_file):
        with open(md5_file, "r", encoding="utf-8") as f:
            avatar_md5 = json.load(f)

    hero_hashes = {}
    if os.path.exists(hash_file):
        with open(hash_file, "r", encoding="utf-8") as f:
            hero_hashes = json.load(f)

    # 获取官方英雄列表
    resp = requests.get(OFFICIAL_HEROLIST_URL, headers=HEADERS, timeout=10)
    heroes = resp.json()

    print(f"开始生成 pHash 指纹库（共 {len(heroes)} 个英雄）...")

    for idx, h in enumerate(heroes, 1):
        hero_id = str(h['ename'])
        name = h.get('cname', '未知')
        url = OFFICIAL_AVATAR_URL.format(eid=hero_id)

        # 下载头像
        img_bytes = None
        for attempt in range(3):
            try:
                img_bytes = requests.get(url, headers=HEADERS, timeout=5).content
                break
            except Exception:
                time.sleep(1)
        if img_bytes is None:
            print(f"  [{idx}/{len(heroes)}] {name} 下载失败，跳过")
            continue

        # 计算 MD5 用于缓存比较
        current_md5 = hashlib.md5(img_bytes).hexdigest()

        # 如果缓存中有且 MD5 未变，跳过
        if hero_id in avatar_md5 and avatar_md5[hero_id] == current_md5 and hero_id in hero_hashes:
            continue

        print(f"  [{idx}/{len(heroes)}] 更新: {name} (ID: {hero_id})")

        try:
            img = Image.open(BytesIO(img_bytes)).convert("RGB")
            variants = []
            for scale in VARIANT_SCALES:
                masked_img = apply_mask_and_crop(img, scale)
                variants.append(calc_phash(masked_img))
            hero_hashes[hero_id] = variants
            avatar_md5[hero_id] = current_md5
        except Exception as e:
            print(f"    {name} 处理失败: {e}")

    # 保存
    with open(hash_file, "w", encoding="utf-8") as f:
        json.dump(hero_hashes, f, indent=2, ensure_ascii=False)
    with open(md5_file, "w", encoding="utf-8") as f:
        json.dump(avatar_md5, f, indent=2, ensure_ascii=False)

    print(f"✅ 完成！指纹库已保存至 {hash_file}，共 {len(hero_hashes)} 个英雄。")


if __name__ == "__main__":
    build_hash_library()
