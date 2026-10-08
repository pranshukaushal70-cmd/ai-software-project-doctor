# Inventory service

A small Flask API that tracks stock levels.

## Setup

```
pip install -r requirements.txt
```

## Usage

```
flask --app app.main run
```

## Configuration

| Variable | Purpose |
|---|---|
| `INVENTORY_DB` | Path of the SQLite database |
| `SUPPLIER_FEED_URL` | Supplier feed to import |

## Testing

```
pytest
```

## License

MIT, see [LICENSE](LICENSE).
