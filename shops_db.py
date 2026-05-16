"""Shared SQLite schema and shop-upsert helper.

Both `to_sqlite.py` (bulk import) and `update_from_feed.py` (incremental
merge) write to the same DB through `upsert_shop`. Keep the schema and
flattening logic in one place so they can't drift.
"""
from __future__ import annotations

import sqlite3

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS shops (
    id                  INTEGER PRIMARY KEY,
    shop_hash_id        TEXT,
    name                TEXT NOT NULL,
    description         TEXT,
    url                 TEXT,
    tel_no              TEXT,
    fax_no              TEXT,
    address             TEXT,
    lat                 REAL,
    lng                 REAL,
    last_modified_date  TEXT,
    revision_no         INTEGER,
    owner_name          TEXT,
    notice              TEXT,
    public_notice       TEXT,
    shared_shop         INTEGER,
    partner             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shops_name     ON shops(name);
CREATE INDEX IF NOT EXISTS idx_shops_owner    ON shops(owner_name);
CREATE INDEX IF NOT EXISTS idx_shops_modified ON shops(last_modified_date);

CREATE TABLE IF NOT EXISTS shop_sent_areas (
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    area    TEXT    NOT NULL,
    PRIMARY KEY (shop_id, area)
);
CREATE INDEX IF NOT EXISTS idx_sent_areas_area ON shop_sent_areas(area);

CREATE TABLE IF NOT EXISTS shop_service_types (
    shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    service_type TEXT    NOT NULL,
    PRIMARY KEY (shop_id, service_type)
);
CREATE INDEX IF NOT EXISTS idx_service_types_type ON shop_service_types(service_type);

CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id   INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    name      TEXT,
    defined   INTEGER,
    UNIQUE (shop_id, position)
);
CREATE INDEX IF NOT EXISTS idx_categories_shop ON categories(shop_id);

CREATE TABLE IF NOT EXISTS products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    api_id              INTEGER,
    category_id         INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    position            INTEGER NOT NULL,
    name                TEXT,
    image_url           TEXT,
    image_thumbnail_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_api_id   ON products(api_id);

CREATE TABLE IF NOT EXISTS variations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    api_id      INTEGER,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT,
    price       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_variations_product ON variations(product_id);
CREATE INDEX IF NOT EXISTS idx_variations_api_id  ON variations(api_id);
"""

DROP_DDL = """
DROP TABLE IF EXISTS variations;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS shop_sent_areas;
DROP TABLE IF EXISTS shop_service_types;
DROP TABLE IF EXISTS shops;
"""


def open_db(path) -> sqlite3.Connection:
    """Open a connection with FK enforcement on."""
    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys = ON")
    return con


def ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA_DDL)


def reset_schema(con: sqlite3.Connection) -> None:
    con.executescript(DROP_DDL)
    con.executescript(SCHEMA_DDL)


def _to_int_bool(v) -> int | None:
    if v is None:
        return None
    return 1 if v else 0


def upsert_shop(con: sqlite3.Connection, shop_id: int, data: dict) -> bool:
    """Insert or replace one shop and all its children.

    Removes any existing shop row with `shop_id` first (FK cascade clears
    its sent_areas / service_types / categories / products / variations),
    then re-inserts everything. Returns False if `data` is missing the
    required name field.
    """
    detail = data.get("detail") or {}
    name = detail.get("name")
    if not name:
        return False

    con.execute("DELETE FROM shops WHERE id = ?", (shop_id,))
    con.execute(
        """INSERT INTO shops VALUES
           (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            shop_id,
            detail.get("shopHashId"),
            name,
            detail.get("description"),
            detail.get("url"),
            detail.get("telNo"),
            detail.get("faxNo"),
            detail.get("address"),
            detail.get("lat"),
            detail.get("lng"),
            detail.get("lastModifiedDate"),
            detail.get("revisionNo"),
            detail.get("ownerName"),
            detail.get("notice"),
            detail.get("publicNotice"),
            _to_int_bool(detail.get("sharedShop")),
            _to_int_bool(data.get("partner")),
        ),
    )

    for area in detail.get("sentAreas") or []:
        con.execute(
            "INSERT OR IGNORE INTO shop_sent_areas(shop_id, area) VALUES (?, ?)",
            (shop_id, area),
        )
    for st in detail.get("serviceTypes") or []:
        con.execute(
            "INSERT OR IGNORE INTO shop_service_types(shop_id, service_type) VALUES (?, ?)",
            (shop_id, st),
        )

    for cat_pos, cat in enumerate(detail.get("categories") or []):
        cur = con.execute(
            "INSERT INTO categories(shop_id, position, name, defined) VALUES (?, ?, ?, ?)",
            (shop_id, cat_pos, cat.get("name"), _to_int_bool(cat.get("defined"))),
        )
        cat_id = cur.lastrowid
        for prod_pos, prod in enumerate(cat.get("products") or []):
            img = prod.get("image")
            if isinstance(img, dict):
                img_url, img_thumb = img.get("url"), img.get("thumbnailUrl")
            elif isinstance(img, str):
                img_url, img_thumb = img, None
            else:
                img_url, img_thumb = None, None
            cur = con.execute(
                "INSERT INTO products(api_id, category_id, position, name, image_url, image_thumbnail_url) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (prod.get("id"), cat_id, prod_pos, prod.get("name"), img_url, img_thumb),
            )
            prod_id = cur.lastrowid
            for var_pos, var in enumerate(prod.get("variations") or []):
                con.execute(
                    "INSERT INTO variations(api_id, product_id, position, name, price) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (var.get("id"), prod_id, var_pos, var.get("name"), var.get("price")),
                )
    return True
