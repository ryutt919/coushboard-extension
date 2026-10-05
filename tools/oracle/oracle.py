#!/usr/bin/env python3
"""쿠팡 지출 대시보드 — 참조 구현(oracle).

TypeScript 구현과 같은 입력을 받아 같은 형태의 JSON을 출력한다.
차등 테스트(differential test)에서 '정답 쪽'으로 쓴다. 표준 라이브러리만 사용.

사용:
  python3 oracle.py --orders orders.csv [--receipts receipts.csv] \
      --rules category-rules.json --merges product-merges.json \
      --period 2026-01-01:2026-12-31 --period ALL [--status ok|all|ret] > out.json

이 파일에는 데이터가 없다. 저장소에 커밋해도 된다.
"""
import argparse
import csv
import json
import re
import sys
from collections import OrderedDict

OK_STATUSES = {"배송완료", "교환완료", "배송중"}
RET_STATUSES = {"반품완료", "취소완료"}
PREFIX_RE = re.compile(r"^(\[[^\]]*\]|\([^)]*\))\s*")
PIECES_RE = re.compile(r"\d+(?=\s*(개|롤|구|정|캔))")
REQUIRED = ["주문번호", "주문일시", "상품번호", "상태", "상품명", "수량", "판매가"]


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def clean_id(v):
    return (v or "").strip()


def load_orders(path):
    raw = read_csv(path)
    if raw:
        missing = [c for c in REQUIRED if c not in raw[0]]
        if missing:
            sys.exit("missing columns: " + ", ".join(missing))
    rows = []
    for i, r in enumerate(raw):
        rows.append({
            "idx": i,
            "order_no": clean_id(r["주문번호"]),
            "dt": r["주문일시"].strip(),
            "date": r["주문일시"].strip()[:10],
            "product_no": clean_id(r["상품번호"]),
            "status": r["상태"].strip(),
            "raw_name": r["상품명"],
            "qty": int(r["수량"]),
            "price": int(r["판매가"]),
        })
    return rows


def dedupe(rows, receipts):
    seen, kept, removed = set(), [], []
    for r in rows:
        k = (r["order_no"], r["product_no"], r["price"], r["qty"])
        (removed if k in seen else kept).append(r)
        seen.add(k)
    restored = []
    if receipts is not None:
        rec_items = {}
        for rc in receipts:
            o = clean_id(rc["order_no"])
            n = rc.get("item_count", "").strip()
            rec_items[o] = rec_items.get(o, 0) + (int(float(n)) if n else 1)
        kept_count = {}
        for r in kept:
            kept_count[r["order_no"]] = kept_count.get(r["order_no"], 0) + 1
        for o, n in rec_items.items():
            gap = n - kept_count.get(o, 0)
            if gap <= 0:
                continue
            cands = [r for r in removed if r["order_no"] == o][:gap]
            for r in cands:
                removed.remove(r)
                kept.append(r)
                restored.append(r)
        kept.sort(key=lambda r: r["idx"])
    return kept, removed, restored


def enrich(rows, rules, merges):
    cats = [(c["name"], re.compile("|".join(c["keywords"]))) for c in rules["categories"]]
    for r in rows:
        name = PREFIX_RE.sub("", r["raw_name"], count=1)
        cut = name.find(",")
        base = (name if cut < 0 else name[:cut]).strip()
        opt = "" if cut < 0 else name[cut + 1:].strip()
        r["name"] = name
        r["base"] = base
        r["group"] = merges.get(base, base)
        nums = [int(m.group(0)) for m in PIECES_RE.finditer(opt)]
        r["pieces"] = max(nums) if nums else 1
        r["unit_price"] = r["price"] / r["pieces"]
        r["amount"] = r["price"] * r["qty"]
        r["category"] = next((c for c, rx in cats if rx.search(name)), rules["fallback"])
    return rows


def months_between(a, b):
    y, m = int(a[:4]), int(a[5:7])
    ey, em = int(b[:4]), int(b[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def status_pass(r, status):
    if status == "ok":
        return r["status"] in OK_STATUSES
    if status == "ret":
        return r["status"] in RET_STATUSES
    return True


def summarize(rows, frm, to, status, data_end):
    sel = [r for r in rows if frm <= r["date"] <= to and status_pass(r, status)]
    months = months_between(frm, to)
    yearly = len(months) > 18
    keys = list(OrderedDict.fromkeys(m[:4] for m in months)) if yearly else months
    keyof = (lambda d: d[:4]) if yearly else (lambda d: d[:7])
    future = (lambda k: k > data_end[:4]) if yearly else (lambda k: k > data_end[:7])
    buckets = OrderedDict((k, {"n": 0, "amount": 0, "future": future(k)}) for k in keys)
    for r in sel:
        b = buckets.get(keyof(r["date"]))
        if b:
            b["n"] += 1
            b["amount"] += r["amount"]
    by_cat = {}
    for r in sel:
        c = by_cat.setdefault(r["category"], {"n": 0, "amount": 0})
        c["n"] += 1
        c["amount"] += r["amount"]
    groups = {}
    for r in sel:
        groups.setdefault(r["group"], []).append(r)
    products = []
    for g, ls in groups.items():
        if len(ls) < 2:
            continue
        days = sorted({l["date"] for l in ls})
        products.append({
            "group": g, "n": len(ls), "amount": sum(l["amount"] for l in ls),
            "order_days": len(days), "last": days[-1],
            "min_unit_price": round(min(l["unit_price"] for l in ls), 2),
            "max_unit_price": round(max(l["unit_price"] for l in ls), 2),
            "aliases": sorted({l["base"] for l in ls}),
        })
    products.sort(key=lambda p: (-p["n"], -p["amount"], p["group"]))
    return {
        "from": frm, "to": to, "status": status,
        "rows": len(sel), "total": sum(r["amount"] for r in sel),
        "order_days": len({r["date"] for r in sel}),
        "granularity": "year" if yearly else "month",
        "buckets": buckets, "by_category": dict(sorted(by_cat.items())),
        "products": products,
    }


def reconcile(rows, receipts):
    if receipts is None:
        return None
    ord_sum = {}
    for r in rows:
        ord_sum[r["order_no"]] = ord_sum.get(r["order_no"], 0) + r["amount"]
    rec_sum = {}
    for rc in receipts:
        o = clean_id(rc["order_no"])
        rec_sum[o] = rec_sum.get(o, 0) + int(rc["total"])
    matched = sorted(set(ord_sum) & set(rec_sum))
    diffs = [{"order_no": o, "orders": ord_sum[o], "receipts": rec_sum[o], "diff": ord_sum[o] - rec_sum[o]}
             for o in matched if ord_sum[o] != rec_sum[o]]
    return {"matched": len(matched), "exact": len(matched) - len(diffs), "diffs": diffs,
            "receipt_orders_missing": len(set(rec_sum) - set(ord_sum))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orders", required=True)
    ap.add_argument("--receipts")
    ap.add_argument("--rules", required=True)
    ap.add_argument("--merges", required=True)
    ap.add_argument("--period", action="append", default=[], help="YYYY-MM-DD:YYYY-MM-DD 또는 ALL")
    ap.add_argument("--status", action="append", default=[], choices=["ok", "all", "ret"])
    a = ap.parse_args()

    rules = json.load(open(a.rules, encoding="utf-8"))
    merges = json.load(open(a.merges, encoding="utf-8"))
    receipts = read_csv(a.receipts) if a.receipts else None
    rows = load_orders(a.orders)
    kept, removed, restored = dedupe(rows, receipts)
    enrich(kept, rules, merges)
    data_start = min(r["date"] for r in kept)
    data_end = max(r["date"] for r in kept)
    out = {
        "input": {"rows_raw": len(rows), "orders": len({r["order_no"] for r in rows}),
                  "data_start": data_start, "data_end": data_end},
        "dedupe": {"removed": len(removed), "restored": len(restored),
                   "restored_orders": sorted({r["order_no"] for r in restored})},
        "rows_after_dedupe": len(kept),
        "unclassified": sum(1 for r in kept if r["category"] == rules["fallback"]),
        "reconcile": reconcile(kept, receipts),
        "summaries": [],
    }
    for p in (a.period or ["ALL"]):
        frm, to = (data_start, data_end) if p == "ALL" else p.split(":")
        for s in (a.status or ["ok"]):
            out["summaries"].append(summarize(kept, frm, to, s, data_end))
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
