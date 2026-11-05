#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — сборка data/schedule.json из экспорта aSc Timetables (docs/20.xml).

Запуск:  python3 build.py [путь_к_xml]

Формат компактный: все ссылки (предмет, учитель, кабинет, группа, класс)
хранятся индексами в общих массивах, сетка — grid[classId][день][урок] = [запись].
Запись = [индекс предмета, [индексы учителей], [индексы кабинетов],
          [индексы групп], [индексы классов]].
Индексы учителей/кабинетов приложение строит само при загрузке.
"""
import json
import os
import re
import sys
import datetime
import hashlib
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "docs", "20.xml")
OUT = os.path.join(HERE, "data", "schedule.json")

DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт"]
DAYS_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница"]

# категории для цветовой полосы в карточке урока
CATS = (
    ("math", ("алгебра", "геометрия", "вероятность", "математик", "статистик")),
    ("it", ("информатик", "python", "программирован", "искусственный интеллект",
            "компьютерн", "беспилотн", "информационная безопасность")),
    ("sci", ("физика", "химия", "биология", "география", "экология", "анатом",
             "генетика", "биохимия", "медицин", "механика", "сестринск")),
    ("hum", ("история", "обществ", "литератур", "русский", "родной", "право",
             "экономик", "педагогик", "психолог", "журналистик", "востоковед",
             "финанс", "предпринимат", "риторика", "познания", "карьерн")),
    ("lang", ("иностранный", "англ", "китайск", "немецк")),
    ("sport", ("физическая культура", "самбо", "гто", "безопасности", "нвп",
               "первой помощи", "туризм", "шахматы")),
)


def cat_of(name, kind):
    low = name.lower()
    for cat, keys in CATS:
        if any(k in low for k in keys):
            return cat
    if kind in ("vd", "ek"):
        return "extra"
    return "other"


def parse_days(mask):
    out = set()
    for part in (mask or "").split(","):
        for i, ch in enumerate(part.strip()[:5]):
            if ch == "1":
                out.add(i)
    return sorted(out)


def kind_of(name):
    low = name.strip().lower()
    if low.startswith("вд."):
        return "vd"
    if low.startswith("эк."):
        return "ek"
    if low.startswith("индивидуальный проект"):
        return "project"
    if low.startswith("самоподготовка"):
        return "self"
    return "lesson"


def parse_class(name):
    raw = name
    div = None
    m = re.search(r"\\\s*(\d+)", name)
    if m:
        div = int(m.group(1))
        name = name[: m.start()].strip()
    profile = None
    m = re.search(r"\(([^)]*)\)", name)
    if m:
        profile = m.group(1).strip()
        name = name[: m.start()].strip()
    m = re.match(r"^(\d{1,2})\s*(.*)$", name)
    parallel, code = (int(m.group(1)), m.group(2).strip()) if m else (None, name)
    short = f"{parallel} {code}".strip() if parallel else code
    if div:
        short += f" /{div}"
    return {
        "parallel": parallel, "code": code, "div": div,
        "profile": profile, "short": short, "name": raw,
    }


def clean(s):
    return re.sub(r"\s+", " ", (s or "").replace("\\", "/")).strip()


def main():
    root = ET.parse(SRC).getroot()

    periods = sorted(
        ({"n": int(p.get("period")), "start": p.get("starttime", ""),
          "end": p.get("endtime", "")} for p in root.find("periods")),
        key=lambda x: x["n"],
    )
    pmap = {p["n"]: p for p in periods}

    subjects, sidx = [], {}
    for s in root.find("subjects"):
        nm = clean(s.get("name"))
        sidx[s.get("id")] = len(subjects)
        subjects.append({
            "id": s.get("id"), "name": nm,
            "short": clean(s.get("short")) or nm,
            "kind": kind_of(nm), "cat": cat_of(nm, kind_of(nm)),
        })

    teachers, tidx = [], {}
    for t in root.find("teachers"):
        tidx[t.get("id")] = len(teachers)
        teachers.append({"id": t.get("id"), "name": clean(t.get("name")),
                         "short": clean(t.get("short")) or clean(t.get("name"))})

    rooms, ridx = [], {}
    for r in root.find("classrooms"):
        ridx[r.get("id")] = len(rooms)
        rooms.append({"id": r.get("id"), "name": clean(r.get("name")),
                      "short": clean(r.get("short")) or clean(r.get("name"))})
    rooms.sort(key=lambda r: (not r["name"][:1].isdigit(), r["name"]))
    ridx = {r["id"]: i for i, r in enumerate(rooms)}

    groups, gidx = [], {}
    for g in root.find("groups"):
        gidx[g.get("id")] = len(groups)
        groups.append({"id": g.get("id"), "class": g.get("classid"),
                       "name": clean(g.get("name")),
                       "entire": g.get("entireclass") == "1",
                       "divtag": g.get("divisiontag", ""),
                       "count": g.get("studentcount", "")})

    classes, cidx = [], {}
    for c in root.find("classes"):
        info = parse_class(clean(c.get("name")))
        info["id"] = c.get("id")
        info["tutor"] = c.get("teacherid") or ""
        cidx[c.get("id")] = len(classes)
        classes.append(info)

    lesson_by_id = {}
    for l in root.find("lessons"):
        lesson_by_id[l.get("id")] = {
            "subject": sidx.get(l.get("subjectid")),
            "classes": [cidx[x] for x in (l.get("classids") or "").split(",") if x in cidx],
            "groups": [gidx[x] for x in (l.get("groupids") or "").split(",") if x in gidx],
            "teachers": [tidx[x] for x in (l.get("teacherids") or "").split(",") if x in tidx],
            "rooms": [ridx[x] for x in (l.get("classroomids") or "").split(",") if x in ridx],
        }

    grid = {}
    for c in classes:
        grid[c["id"]] = {str(d): {} for d in range(5)}

    cards = 0
    for card in root.find("cards"):
        les = lesson_by_id.get(card.get("lessonid"))
        if not les or les["subject"] is None:
            continue
        cards += 1
        period = str(int(card.get("period") or 0))
        room_ids = [ridx[x] for x in (card.get("classroomids") or "").split(",") if x in ridx] \
            or les["rooms"]
        rec = [les["subject"], les["teachers"], room_ids, les["groups"], les["classes"]]
        for d in parse_days(card.get("days")):
            for ci in les["classes"]:
                cells = grid[classes[ci]["id"]][str(d)]
                lst = cells.setdefault(period, [])
                if rec not in lst:
                    lst.append(rec)

    # порядок уроков в клетке: сначала основные, потом ВД/ЭК
    for cid, days in grid.items():
        for d, cells in days.items():
            for p, lst in cells.items():
                lst.sort(key=lambda r: (subjects[r[0]]["kind"] != "lesson",
                                        subjects[r[0]]["short"]))

    # параллели
    parallels = {}
    for c in classes:
        parallels.setdefault(str(c["parallel"]), []).append(c["id"])
    for k in parallels:
        parallels[k].sort(key=lambda cid: (
            classes[cidx[cid]]["code"], classes[cidx[cid]]["div"] or 0))

    max_period = max((int(p) for cid in grid for d in grid[cid] for p in grid[cid][d]), default=8)
    used = [p for p in sorted(pmap) if p <= max_period]

    payload = {
        "meta": {
            "generated": datetime.date.today().isoformat(),
            "source": os.path.basename(SRC),
            "hash": hashlib.sha1(open(SRC, "rb").read()).hexdigest()[:10],
            "cards": cards,
            "title": "Расписание уроков",
            "subtitle": "10–11 классы · профильное обучение",
            "days": [{"i": i, "short": DAYS[i], "full": DAYS_FULL[i]} for i in range(5)],
            "periods": [pmap[p] for p in used],
        },
        "classes": classes,
        "teachers": teachers,
        "rooms": rooms,
        "subjects": subjects,
        "groups": groups,
        "parallels": parallels,
        "grid": grid,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    cells = sum(len(grid[c][d]) for c in grid for d in grid[c])
    multi = sum(1 for c in grid for d in grid[c] for p, l in grid[c][d].items() if len(l) > 1)
    print(f"классов={len(classes)} учителей={len(teachers)} кабинетов={len(rooms)} "
          f"предметов={len(subjects)} групп={len(groups)} карточек={cards}")
    print(f"клеток(класс·день·урок)={cells}, с параллельными группами={multi}, "
          f"уроков в неделе={used[0]}–{used[-1]}")
    print(f"→ {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
