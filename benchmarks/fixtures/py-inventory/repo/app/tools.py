"""Operational helpers."""
import json
import pickle
import subprocess


def export_report(filename):
    subprocess.run("tar czf /tmp/report.tgz " + filename, shell=True, check=True)


def list_directory(path):
    return subprocess.run(["ls", "-l", path], capture_output=True, check=True).stdout


def load_snapshot(blob):
    return pickle.loads(blob)


def load_settings(text):
    return json.loads(text)


def evaluate(expression):
    return eval(expression)
