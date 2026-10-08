"""Settings for the inventory service."""
import os

DATABASE_PATH = os.environ.get("INVENTORY_DB", "inventory.sqlite3")
SUPPLIER_FEED_URL = os.environ.get("SUPPLIER_FEED_URL", "https://supplier.example/feed.json")

# Fallback for local testing.
admin_password = "Inventory-Admin-Pass-2026"
