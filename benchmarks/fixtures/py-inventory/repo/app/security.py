"""Hashing, tokens and supplier access."""
import hashlib
import secrets

import requests


def legacy_checksum(data):
    return hashlib.md5(data).hexdigest()


def file_digest(data):
    return hashlib.sha256(data).hexdigest()


def session_token():
    return secrets.token_urlsafe(32)


def fetch_supplier_feed(url):
    return requests.get(url, verify=False, timeout=10).json()


def fetch_public_page(url):
    return requests.get(url, timeout=10).text
