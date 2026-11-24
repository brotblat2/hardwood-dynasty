#!/usr/bin/env python3
"""Refresh the NBA regular-season snapshot used by roster ratings.

Run with Python 3.10+ and the BoxScore Lab publication date (YYYY-MM-DD).
The source CSVs are published under CC BY 4.0.
"""

import argparse
import csv
from datetime import date
import io
import json
from pathlib import Path
import re
import unicodedata
import urllib.request

BOXSCORE = "https://www.boxscorelab.com/downloads/"
ESPN = "https://site.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete"
TOTAL_FIELDS = {
    "games": "games_played",
    "points": "points",
    "fgm": "field_goals_made",
    "fga": "field_goal_attempts",
    "threeMade": "three_point_makes",
    "threeAttempted": "three_point_attempts",
    "ftm": "free_throws_made",
    "fta": "free_throw_attempts",
    "rebounds": "rebounds",
    "assists": "assists",
    "steals": "steals",
    "blocks": "blocks",
    "turnovers": "turnovers",
}
RATE_FIELDS = {
    "ts": "ts_pct",
    "efg": "effective_fg_pct",
    "usg": "usage_rate",
    "astPct": "ast_pct",
    "rebPct": "reb_pct",
    "tovPct": "tov_pct",
    "netRating": "net_rating",
}


def name_key(name):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", name).lower())


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "NBA-roster-data-refresh/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8-sig")


def season_rows(year, contents):
    season_name = f"{year - 1}-{year % 100:02}"
    seen = set()
    teams = set()
    for row in csv.DictReader(io.StringIO(contents)):
        key = name_key(row["player_name"])
        if row["season"] != season_name or key in seen or not key:
            raise ValueError(f"Unexpected season or duplicate player: {row}")
        seen.add(key)
        teams.add(row["team"])
        line = {
            "season": year,
            "name": row["player_name"],
            "team": row["team"],
            "minutes": float(row["minutes"]),
            **{field: int(row[column]) for field, column in TOTAL_FIELDS.items()},
        }
        line.update({field: float(row[column]) for field, column in RATE_FIELDS.items() if row[column]})
        if line["points"] != 2 * line["fgm"] + line["threeMade"] + line["ftm"]:
            raise ValueError(f"Box score shot and point totals disagree: {line}")
        yield key, line
    if len(teams) < 30 or len(seen) < 400:
        raise ValueError(f"Incomplete league snapshot: {season_name}, {len(teams)} teams, {len(seen)} players")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("date", type=date.fromisoformat)
    parser.add_argument("years", nargs="+", type=int, help="Season-ending years, e.g. 2027 2026")
    parser.add_argument("--input-dir", type=Path, help="Read archived downloads named by season")
    args = parser.parse_args()
    lines = {}
    ids = {}
    for year in sorted(set(args.years), reverse=True):
        season = f"{year - 1}-{year % 100:02}"
        filename = f"{season}-player-season-totals.csv"
        espn_filename = f"{season}-espn.json"
        boxscore = (args.input_dir / filename).read_text() if args.input_dir else fetch(BOXSCORE + filename)
        espn = json.loads(
            (args.input_dir / espn_filename).read_text() if args.input_dir
            else fetch(f"{ESPN}?season={year}&seasontype=2&limit=1000&qualified=false")
        )
        for key, line in season_rows(year, boxscore):
            lines.setdefault(key, []).append(line)
        for entry in espn["athletes"]:
            athlete = entry["athlete"]
            key = name_key(athlete["displayName"])
            if athlete["id"] in ids and ids[athlete["id"]] != key:
                raise ValueError(f"Inconsistent name for ESPN athlete {athlete['id']}")
            ids[athlete["id"]] = key

    # A single ID index keeps each measured season row stored once.
    payload = {
        "snapshotDate": args.date.isoformat(),
        "source": BOXSCORE,
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "espnIds": {athlete_id: key for athlete_id, key in sorted(ids.items()) if key in lines},
        "players": dict(sorted(lines.items())),
    }
    destination = Path(__file__).resolve().parents[1] / "packages/roster-data/data/nba-season-stats.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {len(lines)} players with {sum(map(len, lines.values()))} season lines and {len(payload['espnIds'])} ESPN IDs")


if __name__ == "__main__":
    main()
