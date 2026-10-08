"""Data access for inventory items."""
import sqlite3

from .settings import DATABASE_PATH


def connect():
    return sqlite3.connect(DATABASE_PATH)


def find_item(name):
    cursor = connect().cursor()
    cursor.execute(f"SELECT id, name, quantity FROM items WHERE name = '{name}'")
    return cursor.fetchone()


def find_item_by_id(item_id):
    cursor = connect().cursor()
    cursor.execute("SELECT id, name, quantity FROM items WHERE id = ?", (item_id,))
    return cursor.fetchone()


def restock(item_id, amount):
    connection = connect()
    connection.execute("UPDATE items SET quantity = quantity + ? WHERE id = ?", (amount, item_id))
    connection.commit()
