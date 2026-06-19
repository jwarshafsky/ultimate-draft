#!/usr/bin/env python3
"""Fetch rest-of-season projections from FanGraphs' public API and write them as
CSVs the Ultimate Draft app loads (one-click "Load latest projections").

FanGraphs is behind Cloudflare bot protection that throttles bursts, so this is
meant to run occasionally (scheduled every few days) from a normal IP — not in a
tight loop. It retries with backoff and tries a few candidate type slugs per
source (FanGraphs' ROS slugs are inconsistent: steamerr, rthebatx, etc.).

Output: ultimate-draft/projections/<source>_bat.csv, _pit.csv, manifest.json
"""
import csv, json, os, sys, time, urllib.request

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "projections")

# source id -> (label, [candidate FanGraphs type slugs, tried in order])
SOURCES = {
    "steamer_ros": ("Steamer ROS", ["steamerr"]),
    "batx_ros":    ("THE BAT X ROS", ["rthebatx"]),
    "atc_ros":     ("ATC ROS", ["atcr", "ratc", "atc"]),
}

HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "referer": "https://www.fangraphs.com/projections",
    "user-agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
}

BAT_COLS = ["Name", "PA", "AB", "H", "R", "HR", "RBI", "SB", "BB", "HBP", "SF", "OBP"]
PIT_COLS = ["Name", "IP", "SO", "QS", "SV", "HLD", "ER", "H", "BB", "ERA", "WHIP"]


def fetch(fg_type, stats, tries=4):
    url = ("https://www.fangraphs.com/api/projections?type=%s&stats=%s"
           "&pos=all&team=0&players=0&lg=all" % (fg_type, stats))
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.loads(r.read().decode("utf-8"))
                if isinstance(data, list) and data:
                    return data
        except Exception as e:
            sys.stderr.write("  attempt %d failed (%s): %s\n" % (i + 1, fg_type, e))
        time.sleep(8 * (i + 1))  # backoff; safe in a scheduled run
    return None


def g(row, key):
    v = row.get(key)
    return v if isinstance(v, (int, float)) else 0


def write_csv(path, cols, rows, mapper):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for row in rows:
            name = row.get("PlayerName") or row.get("Name")
            if not name:
                continue
            w.writerow(mapper(name, row))


def bat_row(name, r):
    return [name, round(g(r, "PA")), round(g(r, "AB")), round(g(r, "H")),
            round(g(r, "R")), round(g(r, "HR")), round(g(r, "RBI")), round(g(r, "SB")),
            round(g(r, "BB")), round(g(r, "HBP")), round(g(r, "SF")), round(g(r, "OBP"), 4)]


def pit_row(name, r):
    return [name, round(g(r, "IP"), 1), round(g(r, "SO")), round(g(r, "QS")),
            round(g(r, "SV")), round(g(r, "HLD")), round(g(r, "ER")), round(g(r, "H")),
            round(g(r, "BB")), round(g(r, "ERA"), 2), round(g(r, "WHIP"), 2)]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {}
    ok = True
    for sid, (label, slugs) in SOURCES.items():
        used = None
        bat = pit = None
        for slug in slugs:
            sys.stderr.write("Fetching %s via type=%s ...\n" % (label, slug))
            bat = fetch(slug, "bat")
            if not bat:
                continue
            pit = fetch(slug, "pit")
            if not pit:
                continue
            used = slug
            break
        if not (bat and pit):
            sys.stderr.write("!! FAILED to fetch %s (tried %s)\n" % (label, slugs))
            ok = False
            continue
        write_csv(os.path.join(OUT_DIR, sid + "_bat.csv"), BAT_COLS, bat, bat_row)
        write_csv(os.path.join(OUT_DIR, sid + "_pit.csv"), PIT_COLS, pit, pit_row)
        manifest[sid] = {"label": label, "fgType": used,
                         "hitters": len(bat), "pitchers": len(pit),
                         "updated": time.strftime("%Y-%m-%d")}
        sys.stderr.write("  wrote %s: %d hit / %d pit\n" % (label, len(bat), len(pit)))
        time.sleep(3)
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps(manifest, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
