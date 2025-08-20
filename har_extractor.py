import json
import os
import requests
import hashlib
from urllib.parse import urlparse
import argparse


def safe_filename(url, mime_type=""):
    """
    将 URL 转换成安全的本地文件名（避免冲突和非法字符）
    """
    parsed = urlparse(url)
    # 取 URL 路径的最后一段作为文件名（没有就用 index）
    filename = os.path.basename(parsed.path) or "index"

    # 如果内容类型是 HTML 且原始扩展名不是 .html 或 .htm，则强制使用 .html
    base, ext = os.path.splitext(filename)
    if 'text/html' in mime_type.lower() and ext.lower() not in ['.html', '.htm']:
        ext = '.html'

    # 加 hash 避免重名冲突
    hash_suffix = hashlib.md5(url.encode()).hexdigest()[:8]
    return f"{base}_{hash_suffix}{ext}" if ext else f"{base}_{hash_suffix}"

def download_file(url, filepath, timeout=10):
    """
    下载单个文件到本地
    """
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        resp = requests.get(url, timeout=timeout, stream=True)
        resp.raise_for_status()
        with open(filepath, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"✅ {url} -> {filepath}")
        return filepath
    except Exception as e:
        print(f"❌ 下载失败: {url} ({e})")
        return None

def extract_from_har(har_file, project_dir, mapping_file, timeout=10):
    """从 HAR 文件提取入口 URL 和所有请求 URL。通常，第一个请求是页面的主入口。"""
    with open(har_file, "r", encoding="utf-8") as f:
        har_data = json.load(f)

    entries = har_data.get("log", {}).get("entries", [])

    # 没有通过 --out 指定目录
    if project_dir is None:
        # 使用har文件名作为项目名
        base_name = os.path.splitext(os.path.basename(har_file))[0]
        project_dir = os.path.join("projects", base_name)
        print(f"输出目录未指定，将使用默认目录名: {project_dir}")
    else:
        print(f"将使用指定输出目录: {project_dir}")

    # 创建资源目录
    os.makedirs(project_dir, exist_ok=True)
    assets_dir = os.path.join(project_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    output_data = {
        "entry_point":{
            "origin": None,
            "local_file": None
        },
        "url_mapping": {}
    }

    entry_point_url = entries[0]["request"]["url"]
    unique_entries_map = {}

    # 去重
    for entry in entries:
        url = entry["request"]["url"]
        if url not in unique_entries_map:
            unique_entries_map[url] = entry

    for url, entry in unique_entries_map.items():
        mime_type = entry.get("response", {}).get("content", {}).get("mimeType", "")

        filename = safe_filename(url, mime_type)
        filepath = os.path.join(assets_dir, filename)

        if download_file(url, filepath, timeout):
            relative_path = os.path.relpath(filepath, project_dir)
            output_data["url_mapping"][url] = relative_path

            if url == entry_point_url:
                output_data["entry_point"]["origin"] = url
                output_data["entry_point"]["local_file"] = relative_path

    # 保存映射表
    mapping_path = os.path.join(project_dir, mapping_file)
    with open(mapping_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"\n映射表已保存到 {mapping_path}")
    if output_data["entry_point"]["origin"]:
        print(f"网页入口 URL: {output_data['entry_point']['origin']}")
        print(f"对应本地文件: {output_data['entry_point']['local_file']}")
    else:
        print("⚠️ 未能成功下载并标识网页入口文件。")

def main():
    parser = argparse.ArgumentParser(
        description="从 HAR 文件提取资源并生成本地映射")
    parser.add_argument("har_file", help="HAR 文件路径")
    parser.add_argument("--out", help="指定输出的项目目录。如果未提供，将根据har文件名在 'projects/' 目录下自动创建。")
    # parser.add_argument("--map", default="url_mapping.json", help="映射文件名 (默认: url_mapping.json)")
    parser.add_argument("--timeout", type=int, default=10, help="请求超时时间 (秒)")
    args = parser.parse_args()

    extract_from_har(har_file=args.har_file, project_dir=args.out, mapping_file=args.map, timeout=args.timeout)

if __name__ == "__main__":
    main()
