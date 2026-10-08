"""HTTP API of the inventory service."""
from flask import Flask, jsonify, request

from .db import find_item, find_item_by_id

app = Flask(__name__)


@app.get("/items/<int:item_id>")
def get_item(item_id):
    return jsonify(find_item_by_id(item_id))


@app.get("/search")
def search():
    return jsonify(find_item(request.args.get("name", "")))


if __name__ == "__main__":
    app.run(debug=True)
