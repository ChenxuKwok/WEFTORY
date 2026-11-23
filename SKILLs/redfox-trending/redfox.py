"""获取抖音、小红书热点并计算近期增速，仅依赖 Python 标准库。"""

import argparse
import getpass
import json
import math
import os
import re
import sqlite3
import sys
import unicodedata
from collections import Counter
import warnings
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


ENDPOINT = "https://redfox.hk/story/api/hotSpot/getListByPlatform"
CHINA = timezone(timedelta(hours=8))

# 热榜配置。平台按列出顺序请求，同名次也按此顺序合并。
# 每项依次为红狐平台编号、显示名、本地保留条数。删掉一项即停用该平台。
PLATFORMS = (
    (2, "抖音", 50),
    (6, "小红书", 50),
)
FASHION_LIMIT = 5     # 服装选题上限，0 表示停用
DEFAULT_TIMEOUT = 20
DEFAULT_MAX_AGE_HOURS = 24
DEFAULT_HISTORY_PATH = Path.home() / ".weftory" / "redfox" / "history.sqlite3"
HEAT_PATTERN = re.compile(r"([0-9]{1,24}(?:\.[0-9]{1,12})?)\s*(w|万|亿)?")

# 按优先级排列。可以在这里调整默认关键词和对应的选题角度。
RULES = (
    ("直接相关", ("穿搭", "穿衣", "这样穿", "怎么穿", "ootd", "搭配公式", "叠穿"),
     "标题直接涉及穿衣搭配，可拆解场景、配色和单品组合。"),
    ("直接相关", ("羽绒服", "毛衣", "风衣", "大衣", "外套", "夹克", "卫衣", "西装", "衬衫",
                "牛仔裤", "连衣裙", "半身裙", "马面裙", "汉服", "旗袍", "礼服", "球鞋", "服装",
                "时装", "走秀", "时装周", "袜子"),
     "标题涉及服装单品或时装场景，可围绕款式、版型或实际搭配做选题。"),
    ("相关延伸", ("饰品", "配饰", "耳饰", "首饰", "项链"),
     "配饰可作为造型重点，可展示同一套衣服更换配饰后的效果。"),
    ("相关延伸", ("千金妆", "淡颜妆", "氛围感妆", "妆容"),
     "可从妆容延伸到服装造型，示范同色系衣服与配饰的搭配。"),
    ("相关延伸", ("旅行拍照", "拍照姿势", "拍照方式", "福娃照"),
     "标题提供拍照场景，可延伸为上镜穿搭，展示服装颜色与背景或姿势的配合。"),
)
EXCLUDED_PHRASES = ("用袜子来做", "裙下之臣开播")


class NoRedirect(HTTPRedirectHandler):
    """接口固定在红狐域名，防止鉴权头随重定向转发。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_board(platform, key, timeout):
    query = urlencode({"platform": platform, "source": "WEFTORY"})
    request = Request(f"{ENDPOINT}?{query}", headers={
        "Accept": "application/json",
        "X-API-KEY": key,
        "REDFOX-API-KEY": key,
    }, method="GET")
    rows = request_data(request, timeout)
    if not isinstance(rows, list):
        raise ValueError("红狐响应缺少榜单数组")
    return rows


def request_data(request, timeout):
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            raw = json.load(response)
    except HTTPError as exc:
        raise ValueError(f"红狐返回 HTTP {exc.code}") from exc
    except (URLError, OSError) as exc:
        raise ValueError("无法连接红狐或请求超时") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("红狐响应不是有效的 JSON") from exc
    if not isinstance(raw, dict) or raw.get("code") != 2000:
        code = raw.get("code") if isinstance(raw, dict) else None
        code_text = f"（业务码 {code}）" if type(code) is int else ""
        raise ValueError(f"红狐接口返回失败{code_text}，请检查密钥和接口权限")
    return raw.get("data")


def parse_snapshot(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=CHINA) if parsed.tzinfo is None else parsed.astimezone(CHINA)
    except (OverflowError, ValueError):
        return None


def summarize_board(rows, platform, name, now, max_age, limit):
    entries = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        rank = row.get("index")
        if isinstance(rank, str) and rank.isascii() and rank.isdecimal() and len(rank) <= 6:
            rank = int(rank)
        if type(rank) is not int or rank < 1:
            continue
        entries.append({
            "platform": name,
            "rank": rank,
            "title": title.strip(),
            "heat": row.get("hotCount"),
            "snapshot_at": row.get("gmtCreate"),
            "url": row.get("url"),
        })
    entries.sort(key=lambda item: item["rank"])
    entries = entries[:limit]
    if not entries:
        raise ValueError("榜单为空，或榜单记录缺少有效标题和原始名次")
    snapshots = [parse_snapshot(item["snapshot_at"]) for item in entries]
    available = sorted({stamp for stamp in snapshots if stamp is not None})
    notes = []
    if sorted({item["rank"] for item in entries}) != list(range(1, limit + 1)):
        notes.append(f"返回 {len(rows)} 条记录，未覆盖完整的前 {limit} 名")
    missing_snapshot = None in snapshots
    stale = bool(available and now - available[0] > max_age)
    future = bool(available and available[-1] > now + timedelta(minutes=5))
    if missing_snapshot:
        notes.append("部分或全部记录缺少可解析的快照时间")
    if stale:
        notes.append(f"快照已过期，至少一条记录超过 {max_age.total_seconds() / 3600:g} 小时")
    if future:
        notes.append("快照时间明显晚于本机时间，请核对时钟")
    return {
        "platform": name, "platform_id": platform, "returned": len(rows),
        "snapshot_at": available[-1].isoformat() if available else None,
        "snapshot_status": "stale" if stale else "unknown" if missing_snapshot or future else "fresh",
        "warnings": notes, "entries": entries,
    }


def normalize(text):
    return "".join(unicodedata.normalize("NFKC", text).casefold().split()).strip("#")


def unique_topics(entries):
    seen = set()
    for entry in entries:
        title = normalize(entry["title"])
        if title and title not in seen:
            seen.add(title)
            yield entry


def heat_value(value):
    if type(value) not in (str, int, float):
        return None
    match = HEAT_PATTERN.fullmatch(unicodedata.normalize("NFKC", str(value)).strip().lower())
    if match is None:
        return None
    amount, unit = match.groups()
    if "." in amount:
        amount = amount.rstrip("0").rstrip(".")
    return Decimal(amount), "万" if unit == "w" else unit or "原始数值"


def read_views(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        rows = json.load(stream)
    if not isinstance(rows, list):
        raise ValueError("播放量快照文件必须是 JSON 数组")
    snapshots = {}
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"播放量快照第 {index} 条必须是对象")
        platform = row.get("platform_id")
        title = row.get("title")
        value = row.get("views")
        stamp = parse_snapshot(row.get("snapshot_at"))
        if (type(platform) is not int or platform < 1 or not isinstance(title, str) or not normalize(title)
                or type(value) is not int or not 0 <= value < 10**24 or stamp is None):
            raise ValueError(f"播放量快照第 {index} 条的平台、标题、时间或累计播放量无效")
        key = (platform, normalize(title), stamp)
        if key in snapshots and snapshots[key][1] != value:
            raise ValueError(f"播放量快照第 {index} 条与同一时点的记录冲突")
        snapshots.setdefault(key, (title.strip(), value))
    return [(platform, title, stamp.isoformat(), "次", str(value))
            for (platform, _, stamp), (title, value) in snapshots.items()]


def redfox_history(connection, sources, now, window, max_age):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS redfox_heat (
            platform_id INTEGER NOT NULL, title TEXT NOT NULL, snapshot_at TEXT NOT NULL,
            unit TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (platform_id, title, snapshot_at)
        )
    """)
    current = []
    for source in sources:
        first_stamp = {}
        for entry in source["entries"]:
            stamp = parse_snapshot(entry["snapshot_at"])
            value = heat_value(entry["heat"])
            title = normalize(entry["title"])
            if first_stamp.setdefault(title, stamp) != stamp:
                continue
            if value is not None and title and stamp is not None and stamp <= now and now - stamp <= max_age:
                amount, unit = value
                current.append((source["platform_id"], title, stamp.isoformat(), unit, str(amount)))
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        first_baseline = bool(current) and connection.execute("SELECT 1 FROM redfox_heat LIMIT 1").fetchone() is None
        connection.executemany("""
            INSERT INTO redfox_heat VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(platform_id, title, snapshot_at) DO UPDATE SET unit = '', value = ''
            WHERE redfox_heat.unit != excluded.unit
               OR redfox_heat.value != excluded.value
        """, current)
        history = connection.execute("""
            SELECT platform_id, title, snapshot_at, unit, value FROM redfox_heat
            WHERE snapshot_at >= ? AND snapshot_at <= ? AND unit != ''
        """, ((now - window).isoformat(), now.isoformat())).fetchall()
    return history, first_baseline


def growth_board(sources, rows, now, window, max_age, views_mode):
    series = {}
    titles = {}
    for platform, title, stamp, unit, value in rows:
        stamp = parse_snapshot(stamp)
        if now - window <= stamp <= now:
            key = (platform, normalize(title), unit)
            series.setdefault(key, {})[stamp] = Decimal(value)
            titles[key] = title
    if views_mode:
        sources_by_platform = {source["platform_id"]: source for source in sources}
        board_entries = {(source["platform_id"], normalize(entry["title"])): entry
                         for source in sources for entry in unique_topics(source["entries"])}
        view_sources = {}
        platform_names = {platform: name for platform, name, _ in PLATFORMS}
        for key, title in titles.items():
            platform, normalized, _ = key
            source = sources_by_platform.get(platform)
            name = source["platform"] if source else platform_names.get(platform, f"平台 {platform}")
            entry = board_entries.get((platform, normalized))
            if entry is None:
                entry = {"platform": name, "rank": None, "title": title, "heat": None,
                         "snapshot_at": max(series[key]).isoformat(), "url": None}
            view_sources.setdefault(platform, {"platform_id": platform, "entries": []})["entries"].append(entry)
        sources = view_sources.values()
    groups = []
    for source in sources:
        ranked = []
        for entry in unique_topics(source["entries"]):
            title = normalize(entry["title"])
            board_stamp = parse_snapshot(entry["snapshot_at"])
            if not views_mode and (board_stamp is None or board_stamp > now or now - board_stamp > max_age):
                continue
            heat = heat_value(entry["heat"])
            unit = "次" if views_mode else heat[1] if heat is not None else None
            history = series.get((source["platform_id"], title, unit), {})
            current = max(history, default=None) if views_mode else board_stamp
            if current is None or current not in history:
                continue
            previous = min((stamp for stamp in history if stamp < current), default=None)
            if previous is None:
                continue
            end, start = history[current], history[previous]
            if end <= start:
                continue
            if views_mode:
                counts = [history[stamp] for stamp in sorted(history)]
                if any(later < earlier for earlier, later in zip(counts, counts[1:])):
                    continue
            hours = Decimal(str((current - previous).total_seconds())) / 3600
            increase_per_hour = (end - start) / hours
            scale = {"万": 10_000, "亿": 100_000_000}.get(unit, 1)
            ranked.append((increase_per_hour * scale, {
                **entry, "ranking_basis": "views_growth" if views_mode else "heat_growth",
                "growth": {
                    "unit": unit, "baseline_value": int(start) if views_mode else float(start),
                    "current_value": int(end) if views_mode else float(end),
                    "baseline_at": previous.isoformat(), "current_at": current.isoformat(),
                    "interval_hours": float(hours), "increase_per_hour": float(increase_per_hour),
                    "percent_per_hour": float(increase_per_hour / start * 100) if start else None,
                },
            }))
        groups.append(sorted(ranked, key=lambda item: item[0], reverse=True))
    if views_mode:
        return [entry for _, entry in sorted((item for group in groups for item in group),
                                              key=lambda item: item[0], reverse=True)]
    # 平台热度口径各异，先在同一平台内排序，再按平台内增速名次交错。
    return [group[position][1] for position in range(max(map(len, groups), default=0))
            for group in groups if position < len(group)]


def select_fashion(entries, keywords, *, limit=None, rules=None):
    if rules is None:
        rules = RULES
    if keywords:
        rules = (("自定义匹配", tuple(keywords),
                    "标题命中指定关键词，可围绕该词核实服装关联并设计搭配示例。"), *rules)
    matches = []
    exclusions = tuple(filter(None, map(normalize, EXCLUDED_PHRASES)))
    for entry in entries:
        title = normalize(entry["title"])
        if any(phrase in title for phrase in exclusions):
            continue
        for priority, (kind, words, reason) in enumerate(rules):
            hit = next((word for word in words if normalize(word) and normalize(word) in title), None)
            if hit:
                matches.append((priority, {
                    **entry, "relevance": kind, "keyword": hit, "reason": f"命中「{hit}」。{reason}",
                }))
                break
    matches.sort(key=lambda match: match[0])
    return [entry for _, entry in matches[:FASHION_LIMIT if limit is None else limit]]


BOARD_LIMIT = 15
DEFAULT_GROWTH_WINDOW_HOURS = 12
FASHION_SEARCHES = ("女装穿搭", "通勤穿搭", "秋冬穿搭")
FASHION_RULES = (
    ("直接相关", ("女装", "女款", "女裤", "裙装", "短裙", "百褶裙", "针织开衫",
                "瑜伽裤", "阔腿裤", "通勤鞋", "女鞋", "冬装", "秋装", "夏装",
                "打底衫", "针织衫", "短靴", "裙子", "棉服", "裤装", "裤子",
                "显瘦搭配", "通勤搭配", "复古搭配", "衣橱", "新中式服饰"),
     "标题涉及女装或可用于女装搭配的单品。"),
    *((kind, tuple(word for word in words if word != "走秀"), reason)
      for kind, words, reason in RULES if kind == "直接相关"),
)


def _replay_rows(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        report = json.load(stream)
    sources = report.get("sources") if isinstance(report, dict) else None
    if not isinstance(sources, list):
        raise ValueError("回放文件须包含红狐报告的 sources 数组")
    rows = {}
    for source in sources:
        if not isinstance(source, dict) or type(source.get("platform_id")) is not int:
            raise ValueError("回放文件的榜单来源缺少有效平台编号")
        entries = source.get("entries")
        if not isinstance(entries, list):
            raise ValueError("回放文件的榜单来源缺少 entries 数组")
        rows[source["platform_id"]] = [
            {"title": item.get("title"), "index": item.get("rank"), "hotCount": item.get("heat"),
             "gmtCreate": item.get("snapshot_at"), "url": item.get("url")}
            for item in entries if isinstance(item, dict)
        ]
    return rows


def _fetch_sources(key, replay, now, max_age, notices):
    if replay is not None:
        try:
            rows_by_platform = _replay_rows(replay)
        except (OSError, ValueError) as exc:
            notices.append(f"无法读取红狐回放快照：{exc}")
            return []
        notices.append("当前榜使用配置的红狐回放快照。")
    elif not key:
        notices.append("请设置有效的 REDFOX_API_KEY 以获取红狐当前热榜。")
        return []
    sources = []
    for platform, name, limit in PLATFORMS:
        try:
            rows = rows_by_platform.get(platform, []) if replay is not None else fetch_board(
                platform, key, DEFAULT_TIMEOUT)
            source = summarize_board(rows, platform, name, now, max_age, limit)
        except ValueError as exc:
            notices.append(f"{name}榜单不可用：{exc}")
            continue
        sources.append(source)
        stamp = parse_snapshot(source["snapshot_at"])
        stamp_text = stamp.strftime("%m-%d %H:%M:%S") + "（北京时间）" if stamp else "未知"
        notices.append(f"{name}热榜源快照 {stamp_text}。")
        notices.extend(f"{name}：{note}" for note in source["warnings"])
    return sources


def _heat_history(path, sources, now, window, max_age, replay):
    if replay is None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as connection:
            return redfox_history(connection, sources, now, window, max_age)
    # 回放使用内存副本，不写入实际热度历史。
    with closing(sqlite3.connect(":memory:")) as connection:
        if path.is_file():
            with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as saved:
                saved.backup(connection)
        return redfox_history(connection, sources, now, window, max_age)


def _fashion_samples(key, existing, limit, notices):
    works = {}
    for keyword in FASHION_SEARCHES:
        try:
            request = Request("https://redfox.hk/story/api/dy/data/searchWork",
                              data=json.dumps({"keyword": keyword, "pageNum": 1, "pageSize": 50}).encode(),
                              headers={"Content-Type": "application/json", "X-API-KEY": key, "REDFOX-API-KEY": key})
            payload = request_data(request, DEFAULT_TIMEOUT)
            page = payload.get("list") if isinstance(payload, dict) else None
            if not isinstance(page, list):
                raise ValueError("作品列表格式异常")
        except ValueError:
            notices.append(f"抖音服饰作品搜索「{keyword}」暂不可用。")
            continue
        for work in page:
            if not isinstance(work, dict):
                continue
            url = work.get("opusUrl")
            url = url if isinstance(url, str) and url.startswith("https://www.douyin.com/") else None
            video_id = work.get("videoId")
            identity = url.split("?", 1)[0].rstrip("/") if url else str(video_id or "")
            raw_tags = work.get("tagList")
            if not identity or not isinstance(raw_tags, list):
                continue
            _, tags = works.setdefault(identity, (url, {}))
            for tag in raw_tags:
                if isinstance(tag, dict):
                    tag = tag.get("tagName") or tag.get("name") or tag.get("tag")
                if isinstance(tag, str):
                    title = tag.strip().strip("#").strip()
                    normalized = normalize(title)
                    if normalized:
                        tags.setdefault(normalized, title)
    counts = Counter()
    examples = {}
    for url, tags in works.values():
        counts.update(tags.keys())
        for normalized, title in tags.items():
            examples.setdefault(normalized, (title, url))
    sample_size = len(works)
    seen = {normalize(item["title"]) for item in existing}
    entries = []
    for normalized in sorted(counts, key=lambda tag: (-counts[tag], tag)):
        if normalized in seen:
            continue
        title, url = examples[normalized]
        entries.append({
            "title": title, "platform": "抖音", "rank": None, "heat": None, "url": url,
            "ranking_basis": "fashion_sample", "source_label": f"服饰作品标签 · 样本 {sample_size} 篇",
            "sample_count": counts[normalized], "sample_size": sample_size,
        })
    # 相关性只决定是否收录。保留各标签的作品数排序。
    matches = select_fashion(entries, (), limit=len(entries), rules=FASHION_RULES)
    included = {item["title"] for item in matches}
    return [entry for entry in entries if entry["title"] in included][:limit]


def get_boards(*, api_key=None, now=None, board_snapshot=None, history_path=None, views_snapshots=None):
    """读取配置和榜单。now 与 board_snapshot 可固定用于离线回放。"""
    now = datetime.now(CHINA) if now is None else (
        now.replace(tzinfo=CHINA) if now.tzinfo is None else now.astimezone(CHINA))
    board_snapshot = board_snapshot or os.environ.get("WEFTORY_HOT_SNAPSHOT") or None
    history_path = Path(history_path or os.environ.get("WEFTORY_HOT_HISTORY") or DEFAULT_HISTORY_PATH)
    views_snapshots = views_snapshots or os.environ.get("WEFTORY_VIEWS_SNAPSHOTS")
    notices = []
    try:
        hours = float(os.environ.get("WEFTORY_GROWTH_WINDOW_HOURS") or DEFAULT_GROWTH_WINDOW_HOURS)
        if not math.isfinite(hours) or not 0 < hours <= 1_000_000:
            raise ValueError
    except ValueError:
        hours = DEFAULT_GROWTH_WINDOW_HOURS
        notices.append(f"增速观测窗口配置无效，使用默认 {hours:g} 小时。")
    notices.append(f"增速观测窗口为最近 {hours:g} 小时。")
    window = timedelta(hours=hours)
    max_age = timedelta(hours=DEFAULT_MAX_AGE_HOURS)
    key = (api_key if api_key is not None else os.environ.get("REDFOX_API_KEY", "")).strip()
    if not key.isascii() or not key.isprintable():
        key = ""
    sources = _fetch_sources(key, board_snapshot, now, max_age, notices)
    combined = sorted((entry for source in sources for entry in source["entries"]),
                      key=lambda entry: entry["rank"])
    fresh = [entry for entry in combined if (stamp := parse_snapshot(entry["snapshot_at"])) is not None
             and now - max_age <= stamp <= now]
    if len(fresh) < len(combined):
        notices.append(f"已从当前榜和服饰热榜候选中排除 {len(combined) - len(fresh)} 条快照时间无效或过期的话题。")
    topics = list(unique_topics(fresh))
    current = [{**entry, "ranking_basis": "current_board"} for entry in topics[:BOARD_LIMIT]]
    fashion = select_fashion(topics, (), limit=BOARD_LIMIT, rules=FASHION_RULES)
    if key and board_snapshot is None and len(fashion) < BOARD_LIMIT:
        samples = _fashion_samples(key, fashion, BOARD_LIMIT - len(fashion), notices)
        if samples:
            notices.append(f"女装候选补充 {len(samples)} 条抖音服饰作品标签，按标签出现的去重作品数排序。")
            fashion.extend(samples)

    history = []
    if sources:
        try:
            history, first_baseline = _heat_history(history_path, sources, now, window, max_age, board_snapshot)
        except (OSError, sqlite3.Error) as exc:
            notices.append(f"无法读写红狐热度快照：{exc}")
        else:
            if first_baseline:
                notices.append("已建立红狐热度基线，取得新快照后可计算热度增速。")
    growth = []
    if views_snapshots:
        try:
            growth = growth_board(sources, read_views(views_snapshots), now, window, max_age, True)
        except (OSError, ValueError) as exc:
            notices.append(f"无法读取累计播放量快照：{exc}")
        else:
            if not growth:
                notices.append("观测窗口内缺少足以计算正增速的累计播放量快照。")
    metric = "累计播放量"
    if not growth:
        metric = "红狐热度"
        notices.append("增速榜使用红狐热度。按平台内增速排序后交错合并，各平台热度口径不同。")
        growth = growth_board(sources, history, now, window, max_age, False)
    growth = list(unique_topics(growth))[:BOARD_LIMIT]

    if len(current) < BOARD_LIMIT:
        notices.append(f"当前榜只取得 {len(current)} 条有效热点，目标 {BOARD_LIMIT} 条。")
    if len(growth) < BOARD_LIMIT:
        notices.append(f"增速榜只有 {len(growth)} 条可计算的{metric}正增长热点，目标 {BOARD_LIMIT} 条。")
    if len(fashion) < BOARD_LIMIT:
        notices.append(f"女装服装相关话题只找到 {len(fashion)} 条，目标 {BOARD_LIMIT} 条。")
    return {"growth": growth, "current": current, "fashion": fashion, "notices": notices,
            "as_of": now.isoformat(timespec="seconds")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="以 JSON 输出三榜、来源及提示")
    parser.add_argument("--history-path", type=Path, help="热度快照 SQLite 文件路径")
    args = parser.parse_args()
    key = os.getenv("REDFOX_API_KEY")
    if not key and not os.getenv("WEFTORY_HOT_SNAPSHOT") and not os.getenv("WEFTORY_VIEWS_SNAPSHOTS"):
        if not sys.stdin.isatty():
            parser.error("请先设置 REDFOX_API_KEY")
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                key = getpass.getpass("红狐 API Key（隐藏输入）: ")
            except (getpass.GetPassWarning, EOFError):
                parser.error("请在交互终端输入，或设置 REDFOX_API_KEY")
    report = get_boards(api_key=key, history_path=args.history_path)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(report["as_of"], *report["notices"], sep="\n")
        for name, label in (("growth", "增长"), ("current", "当前"), ("fashion", "女装")):
            print(f"\n{label}榜（{len(report[name])}/{BOARD_LIMIT}）")
            for position, row in enumerate(report[name], 1):
                if name == "growth":
                    rate = row["growth"]
                    detail = f"+{rate['increase_per_hour']:,.2f} {rate['unit']}/小时"
                elif row.get("ranking_basis") == "fashion_sample":
                    detail = f"服饰样本命中 {row['sample_count']}/{row['sample_size']} 篇"
                else:
                    detail = f"平台第 {row['rank']} 名，热度 {row['heat']}"
                print(f"{position:2}. {row['title']}　{row['platform']}　{detail}")
    return 0 if any(report[k] for k in ("growth", "current", "fashion")) else 1


if __name__ == "__main__":
    sys.exit(main())
