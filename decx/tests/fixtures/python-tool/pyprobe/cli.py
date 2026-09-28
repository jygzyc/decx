"""Console entry point: print version/help or return arguments unchanged."""

import json
import sys


def main():
    arguments = sys.argv[1:]
    if arguments == ["--version"]:
        print("pyprobe 1.0.0")
    elif arguments == ["--help"]:
        print("usage: pyprobe [arguments...]")
    else:
        print(json.dumps(arguments, ensure_ascii=False))
