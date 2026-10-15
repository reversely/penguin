"""Grow Larder from the fourteen people in larder.json to the size its 'scale' section names.

``expand(raw)`` returns larder.json's data with the generated people, team members and features added,
plus the source files of each generated feature commit, keyed by ``(feature id, source)``. build.py
builds them like any other feature. Every value comes from the 'scale' section, in its order, so
every machine generates the same features and the same commits.

A generated person joins one of the four teams and runs features in that team's scopes. Most
features are plain work in one scope: a module with one function and its test, which calls nothing
another scope owns. The features 'scale.callers' lists call Larder's shared code the way the
fixture's own readers do, so cases 1 and 2 reach them:

- ``shopper-same`` reads ``ShopperMap.resolve()`` with events that carry one identity each, so case
  1's change leaves every call's result as it was.
- ``shopper-cutover`` counts shoppers by their first active day through ``ShopperMap.resolve()``,
  as Jun's cohort report does. Case 1's change lowers a published day's count; Penguin's update
  copies ``accounts/shoppers.py`` and rule ``count-by-cutover`` rewrites the count's key.
- ``shopper-consent`` builds an email audience from ``ShopperMap.shoppers()`` and ``is_subscribed()``,
  as Sam's digest does. Penguin's update copies ``accounts/shoppers.py`` and
  ``messaging/subscriptions.py``.
- ``local-day`` reads a store's local day from ``start_of_day()``, as Elif's holiday closures do.
  Case 2's change moves it to the UTC day until Hugo's agent revises the change.
"""

import os
import re
from itertools import cycle

# A commit's source directory name for each generated commit.
CHECKPOINT = "checkpoint"

KINDS = frozenset({"shopper-same", "shopper-cutover", "shopper-consent", "local-day"})


def _module(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def _package(scope_path: str) -> str:
    return scope_path.rstrip("/").replace("/", ".")


# Plain features: one function per suffix, each with a test that pins its behaviour.

PLAIN_CODE = {
    "report": '''"""{title}."""

from collections import Counter


def {fn}(rows: list[dict[str, str]], key: str) -> dict[str, int]:
    """Count the {subject} rows per value of ``key``, in key order; a row without one is left out."""
    counts = Counter(row[key] for row in rows if row.get(key))
    return dict(sorted(counts.items()))
''',
    "checks": '''"""{title}."""


def {fn}(rows: list[dict[str, str]], required: list[str]) -> list[int]:
    """Return the index of each {subject} row that leaves a required field empty."""
    return [i for i, row in enumerate(rows) if any(not row.get(field) for field in required)]
''',
    "export": '''"""{title}."""


def {fn}(rows: list[dict[str, str]], columns: list[str]) -> str:
    """Write the {subject} rows as comma-separated lines, one header line first."""
    lines = [",".join(columns)]
    lines += [",".join(row.get(column, "") for column in columns) for row in rows]
    return "\\n".join(lines) + "\\n"
''',
    "alerts": '''"""{title}."""

from collections import Counter


def {fn}(rows: list[dict[str, str]], key: str, threshold: int) -> list[str]:
    """Return each value of ``key`` that at least ``threshold`` {subject} rows share, sorted."""
    counts = Counter(row[key] for row in rows if row.get(key))
    return sorted(value for value, count in counts.items() if count >= threshold)
''',
}

PLAIN_TEST = {
    "report": """from {package}.{module} import {fn}


def test_counts_rows_per_key():
    rows = [{{"store": "s-1"}}, {{"store": "s-2"}}, {{"store": "s-1"}}, {{"store": ""}}]
    assert {fn}(rows, "store") == {{"s-1": 2, "s-2": 1}}
""",
    "checks": """from {package}.{module} import {fn}


def test_lists_rows_missing_a_required_field():
    rows = [{{"id": "a", "store": "s-1"}}, {{"id": "b", "store": ""}}, {{"id": ""}}]
    assert {fn}(rows, ["id", "store"]) == [1, 2]
""",
    "export": """from {package}.{module} import {fn}


def test_writes_a_header_then_one_line_per_row():
    rows = [{{"id": "a", "store": "s-1"}}, {{"id": "b"}}]
    assert {fn}(rows, ["id", "store"]) == "id,store\\na,s-1\\nb,\\n"
""",
    "alerts": """from {package}.{module} import {fn}


def test_lists_values_at_or_over_the_threshold():
    rows = [{{"store": "s-1"}}, {{"store": "s-1"}}, {{"store": "s-2"}}]
    assert {fn}(rows, "store", 2) == ["s-1"]
""",
}

# Callers of Larder's shared code, as the fixture's own readers call it.

CALLER_CODE = {
    "shopper-same": '''"""{title}."""

from collections import defaultdict
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap


def {fn}(events: Iterable[Event], shopper_map: ShopperMap, minimum: int) -> int:
    """Count the shoppers active on at least ``minimum`` different days."""
    days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        days[shopper_map.resolve(event)].add(event.day)
    return sum(1 for each in days.values() if len(each) >= minimum)
''',
    "shopper-cutover": '''"""{title}."""

from collections import Counter, defaultdict
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap


def {fn}(events: Iterable[Event], shopper_map: ShopperMap) -> dict[str, int]:
    """Count the shoppers whose first active day is each ISO date, in date order."""
    days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        days[shopper_map.resolve(event)].add(event.day)
    firsts = Counter(min(each) for each in days.values())
    return dict(sorted(firsts.items()))
''',
    "shopper-consent": '''"""{title}."""

from accounts.shoppers import ShopperMap
from messaging.subscriptions import SUBSCRIBED, is_subscribed


def {fn}(shopper_map: ShopperMap) -> list[str]:
    """Return the sorted addresses of subscribed shoppers.

    An address that any shopper has unsubscribed is suppressed, even when another shopper with the
    same address is subscribed.
    """
    shoppers = shopper_map.shoppers()
    suppressed = {{shopper.get("email") for shopper in shoppers if shopper.get(SUBSCRIBED) is False}}
    return sorted(
        {{
            str(shopper.get("email"))
            for shopper in shoppers
            if shopper.get("email")
            and shopper.get("email") not in suppressed
            and is_subscribed(shopper)
        }}
    )
''',
    "local-day": '''"""{title}."""

from datetime import datetime, timedelta, timezone

from shared.platform.dates import start_of_day


def {fn}(moment: datetime, utc_offset: timedelta) -> str:
    """Return the store's local ISO day for ``moment``, at ``utc_offset``."""
    local = moment.astimezone(timezone(utc_offset))
    return start_of_day(local).date().isoformat()
''',
}

CALLER_TEST = {
    "shopper-same": """from accounts.shoppers import Event, ShopperMap
from {package}.{module} import {fn}


def test_counts_shoppers_active_on_several_days():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-06", 2, user_id="u1"),
        Event("web", "page_view", "2026-01-05", 3, user_id="u2"),
    ]
    assert {fn}(events, ShopperMap.from_events(events), 2) == 1
""",
    "shopper-cutover": '''from accounts.shoppers import Event, ShopperMap
from {package}.{module} import {fn}


def _counts(events):
    return {fn}(events, ShopperMap.from_events(events))


def test_counts_shoppers_by_first_day():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-06", 2, user_id="u1"),
        Event("web", "page_view", "2026-01-06", 3, user_id="u2"),
    ]
    assert _counts(events) == {{"2026-01-05": 1, "2026-01-06": 1}}


def test_published_day_stays_the_same():
    """A published day's count stays the same when later days' events arrive."""
    published = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("mobile", "app_open", "2026-01-05", 2, device_id="d1"),
    ]
    later = [
        Event("mobile", "login", "2026-01-06", 3, user_id="u1", device_id="d1"),
    ]
    assert _counts(published + later)["2026-01-05"] == _counts(published)["2026-01-05"] == 2
''',
    "shopper-consent": '''from accounts.shoppers import Event, ShopperMap
from {package}.{module} import {fn}


def test_unsubscribe_survives():
    """An unsubscribe on mobile holds after a later web signup subscribes the address by default."""
    events = [
        Event(
            "mobile",
            "unsubscribe",
            "2025-11-03",
            1,
            device_id="d1",
            email="a@example.com",
            email_verified=True,
            traits={{"email_subscribed": False}},
        ),
        Event(
            "web",
            "signup",
            "2025-11-10",
            2,
            user_id="u1",
            email="a@example.com",
            email_verified=True,
            traits={{"email_subscribed": True}},
        ),
    ]
    assert {fn}(ShopperMap.from_events(events)) == []
''',
    "local-day": '''from datetime import UTC, datetime, timedelta

from {package}.{module} import {fn}

LOS_ANGELES_WINTER = timedelta(hours=-8)


def test_reads_the_stores_local_day():
    """20:00 on 25 December at UTC-08:00 is 04:00 UTC on 26 December."""
    christmas_evening = datetime(2026, 12, 26, 4, 0, tzinfo=UTC)
    assert {fn}(christmas_evening, LOS_ANGELES_WINTER) == "2026-12-25"
''',
}

# Penguin's update of a generated fork from case 1's change, as the fixture updates Jun's and Sam's.
UPDATES = {
    "shopper-cutover": {
        "copies": ["accounts/shoppers.py"],
        "test": "test_published_day_stays_the_same",
        "message": "{id}: Penguin's update from Priya's shopper accounts\n\nCopies accounts/shoppers.py from accounts-merge-fix-messaging byte for byte.\nRule count-by-cutover rewrites the count's key to ShopperMap.counted_as(), so days\nbefore the cutover keep the counts they were published with.\n",
        "tag": "cutover",
    },
    "shopper-consent": {
        "copies": ["accounts/shoppers.py", "messaging/subscriptions.py"],
        "test": "test_unsubscribe_survives",
        "message": "{id}: Penguin's update from Priya's shopper accounts\n\nCopies accounts/shoppers.py and messaging/subscriptions.py from\naccounts-merge-fix-messaging byte for byte. is_subscribed() now reads each linked\nidentity's consent. No rule changes the feature's own code.\n",
        "tag": "consent",
    },
}


def _minutes(start: str, minutes: int) -> str:
    """``start`` (``YYYY-MM-DDTHH:MM:00+00:00``) plus ``minutes``, in the same form."""
    day, clock = start[:10], start[11:16]
    hour, minute = (int(part) for part in clock.split(":"))
    total = hour * 60 + minute + minutes
    if total >= 24 * 60:
        raise ValueError(f"{start} plus {minutes} minutes leaves the day")
    return f"{day}T{total // 60:02d}:{total % 60:02d}:00+00:00"


# A benchmark may build Larder with fewer generated people (scripts/benchmark-land.ts), and the live
# demo with none ("off"); the pinned fixture always uses the 'scale' section's own counts.
SCALE_PEOPLE = "LARDER_SCALE_PEOPLE"


def team_counts(scale: dict, scopes: dict) -> dict[str, int]:
    """How many generated people join each team: the section's counts, or, when the environment sets
    LARDER_SCALE_PEOPLE, that many in the same proportion, each team keeping a person per caller."""
    counts = scale["teams"]
    wanted = os.environ.get(SCALE_PEOPLE)
    if wanted is None:
        return counts
    total = sum(counts.values())
    if not wanted.isdigit() or int(wanted) > len(scale["names"]):
        raise ValueError(
            f"{SCALE_PEOPLE} must be 'off' or a whole number from 0 to "
            f"{len(scale['names'])}, not {wanted!r}"
        )
    limit = int(wanted)
    needed = {team: 0 for team in counts}
    for caller in scale["callers"]:
        needed[scopes[caller["scope"]]["team"]] += 1
    return {
        team: max(needed[team], round(count * limit / total))
        for team, count in counts.items()
    }


def expand(raw: dict) -> tuple[dict, dict[tuple[str, str], dict[str, bytes]]]:
    """larder.json's data grown to its 'scale' section, and each generated commit's source files.

    Data without a 'scale' section comes back unchanged with no sources.
    """
    scale = raw.get("scale")
    if scale is None:
        return raw, {}
    # The live demo on Cloudflare runs the fourteen DRIs' Larder alone (LARDER_SCALE_PEOPLE=off).
    if os.environ.get(SCALE_PEOPLE) == "off":
        return {key: value for key, value in raw.items() if key != "scale"}, {}
    scopes = {scope["id"]: scope for scope in raw["scopes"]}
    teams = {
        team["id"]: dict(team, members=list(team["members"])) for team in raw["teams"]
    }
    taken_ids = {person["id"] for person in raw["people"]} | {
        feature["id"] for feature in raw["features"]
    }
    excluded = set(scale["excluded_scopes"])

    # People, each in the team the counts give next.
    people, team_of = [], {}
    names = iter(scale["names"])
    for team_id, count in team_counts(scale, scopes).items():
        for _ in range(count):
            name = next(names)
            person_id = name.lower().replace(" ", "-")
            if person_id in taken_ids:
                raise ValueError(f"generated person {person_id!r} repeats an id")
            taken_ids.add(person_id)
            people.append(
                {
                    "id": person_id,
                    "display_name": name,
                    "vendor": "claude-code" if len(people) % 3 else "codex",
                }
            )
            team_of[person_id] = team_id
            teams[team_id]["members"].append(person_id)

    # Each person's feature slots, by the per-person cycle.
    slots = [
        (person["id"], slot)
        for person, count in zip(people, cycle(scale["features_per_person"]))
        for slot in range(count)
    ]

    # The callers take the first slot of the first person of the right team not already holding one.
    callers: dict[tuple[str, int], dict] = {}
    for caller in scale["callers"]:
        team_id = scopes[caller["scope"]]["team"]
        person_id = next(
            p["id"]
            for p in people
            if team_of[p["id"]] == team_id and (p["id"], 0) not in callers
        )
        callers[(person_id, 0)] = caller

    # Subjects per scope, by suffix, in order; each scope hands out its titles in turn.
    titles = {
        scope_id: iter(
            [
                f"{subject[:1].upper()}{subject[1:]} {suffix}"
                for suffix in scale["suffixes"]
                for subject in subjects
            ]
        )
        for scope_id, subjects in scale["subjects"].items()
    }
    team_scopes = {
        team_id: [
            scope_id
            for scope_id, scope in scopes.items()
            if scope["team"] == team_id
            and scope_id not in excluded
            and scope_id in titles
        ]
        for team_id in teams
    }

    features, sources = [], {}
    turns = dict.fromkeys(teams, 0)
    for index, (person_id, slot) in enumerate(slots):
        caller = callers.get((person_id, slot))
        if caller is not None:
            scope_id, title, kind = caller["scope"], caller["title"], caller["kind"]
        else:
            choices = team_scopes[team_of[person_id]]
            scope_id = choices[turns[team_of[person_id]] % len(choices)]
            turns[team_of[person_id]] += 1
            title = next(titles[scope_id])
            kind = title.rsplit(" ", 1)[1]
        feature_id = _slug(title)
        if feature_id in taken_ids:
            raise ValueError(f"generated feature {feature_id!r} repeats an id")
        taken_ids.add(feature_id)
        scope_path = scopes[scope_id]["paths"][0]
        module = _module(title)
        values = {
            "title": title,
            "fn": module,
            "module": module,
            "package": _package(scope_path),
            "subject": title.rsplit(" ", 1)[0].lower(),
            "id": feature_id,
        }
        code, test = (
            (CALLER_CODE[kind], CALLER_TEST[kind])
            if kind in KINDS
            else (PLAIN_CODE[kind], PLAIN_TEST[kind])
        )
        sources[(feature_id, CHECKPOINT)] = {
            f"{scope_path}{module}.py": code.format(**values).encode(),
            f"{scope_path}tests/test_{module}.py": test.format(**values).encode(),
        }
        commits = [
            {
                "source": CHECKPOINT,
                "tag": "checkpoint",
                "date": _minutes(scale["start"], index),
                "message": f"{title}\n",
            }
        ]
        if kind in UPDATES:
            update = UPDATES[kind]
            commits.append(
                {
                    "update": {
                        "from": "accounts-merge",
                        "tag": "fix-messaging",
                        "copies": update["copies"],
                    },
                    "tag": update["tag"],
                    "date": _minutes(
                        scale["update_start"],
                        len([f for f in features if f.get("generated") in UPDATES]),
                    ),
                    "message": update["message"].format(**values),
                    "fix": {
                        "scope": scope_id,
                        "kind": "fix",
                        "tests": [
                            f"{scope_path}tests/test_{module}.py::{update['test']}"
                        ],
                    },
                }
            )
        features.append(
            {
                "id": feature_id,
                "owner": person_id,
                "title": title,
                "role": "unaffected",
                "vendor": next(p["vendor"] for p in people if p["id"] == person_id),
                "area": [scope_id],
                "start": "base",
                "generated": kind,
                "commits": commits,
            }
        )

    grown = dict(
        raw,
        people=raw["people"] + people,
        teams=list(teams.values()),
        features=raw["features"] + features,
    )
    grown.pop("scale")
    return grown, sources


def caller_words(words: dict, features: list[dict]) -> dict:
    """A case's callers file with each generated feature's words filled from the file's 'kinds'."""
    kinds = words.get("kinds", {})
    filled = {
        key: dict(words.get(key, {})) for key in ("explanations", "calls", "reviews")
    }
    for feature in features:
        template = kinds.get(feature.get("generated"))
        if template is None:
            continue
        values = {"title": feature["title"], "id": feature["id"]}
        filled["explanations"][feature["id"]] = template["explanation"].format(**values)
        filled["calls"][feature["id"]] = {
            "kind": template["kind"],
            "reason": template["reason"].format(**values),
        }
        if "review" in template:
            filled["reviews"][feature["id"]] = template["review"].format(**values)
    return {**{k: v for k, v in words.items() if k != "kinds"}, **filled}
