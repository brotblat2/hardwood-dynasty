"""Refresh the factual NBA roster snapshot; no photos, team marks, or artwork."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen
import json

EAST = "atl bos bkn cha chi cle det ind mia mil ny orl phi tor wsh".split()
WEST = "dal den gs hou lac lal mem min no okc phx por sac sa utah".split()
API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{}/roster"
OUT = Path(__file__).resolve().parents[1] / "packages/roster-data/data/nba-rosters.json"


def read_roster(key):
    with urlopen(Request(API.format(key), headers={"Accept": "application/json"}), timeout=25) as response:
        payload = json.load(response)
    fields = ("id", "displayName", "jersey", "height", "weight", "age", "position")
    athletes = []
    for athlete in payload["athletes"]:
        row = {field: athlete[field] for field in fields if field in athlete}
        row["position"] = row.get("position", {}).get("abbreviation")
        contract = athlete.get("contract") or {}
        for field in ("salary", "yearsRemaining"):
            value = contract.get(field)
            if isinstance(value, (int, float)) and value >= 0:
                row[field] = value
        athletes.append(row)
    return {
        "updatedAt": payload["timestamp"],
        "conference": "East" if key in EAST else "West",
        "team": {key: payload["team"].get(key) for key in ("abbreviation", "location", "name", "color")},
        "athletes": athletes,
    }


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=8) as workers:
        rosters = list(workers.map(read_roster, EAST + WEST))
    OUT.write_text(json.dumps(rosters, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Verified {len(rosters)} teams and {sum(len(row['athletes']) for row in rosters)} bios.")
