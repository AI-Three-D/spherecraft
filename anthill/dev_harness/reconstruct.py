#!/usr/bin/env python3
"""Restore a readable harness bundle without overwriting existing paths."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

MAGIC = b"// renderer-harness-bundle v1\n"
METADATA = b"// bundle-file "


def parse_bundle(data):
    """Validate every section before creating any files. Counts are UTF-8 bytes."""
    if not data.startswith(MAGIC):
        raise ValueError("Not a renderer harness bundle (expected v1)")
    cursor = data.find(b"\n\n", len(MAGIC))
    if cursor < 0:
        raise ValueError("Missing bundle preamble terminator")
    cursor += 2
    files = {}
    while cursor < len(data):
        end = data.find(b"\n", cursor)
        if end < 0 or not data[cursor:end].startswith(b"// "):
            raise ValueError("Missing file path header")
        name = data[cursor + 3:end].decode("utf-8")
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or "\\" in name or ":" in name
                or any(part in ("", ".", "..") for part in name.split("/"))):
            raise ValueError(f"Unsafe bundle path: {name}")
        if name in files:
            raise ValueError(f"Duplicate bundle path: {name}")
        cursor = end + 1
        end = data.find(b"\n", cursor)
        if end < 0 or not data[cursor:end].startswith(METADATA):
            raise ValueError(f"Missing file metadata: {name}")
        metadata = json.loads(data[cursor + len(METADATA):end])
        size = metadata["bytes"]
        if type(size) is not int or size < 0:
            raise ValueError(f"Invalid content length: {name}")
        cursor = end + 1
        content = data[cursor:cursor + size]
        if len(content) != size or hashlib.sha256(content).hexdigest() != metadata["sha256"]:
            raise ValueError(f"Content length/checksum mismatch: {name}")
        content.decode("utf-8")
        cursor += size
        if data[cursor:cursor + 2] != b"\n\n":
            raise ValueError(f"Missing section separator: {name}")
        cursor += 2
        files[name] = content
    if not files:
        raise ValueError("Bundle contains no files")
    return files


def restore(files, destination):
    # Resolve the user-selected root (e.g. macOS /var -> /private/var), then
    # refuse symlinks underneath it rather than following them out of the root.
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    for name, content in files.items():
        target = root / name
        if target.exists() or target.is_symlink():
            print(f"WARNING: exists; skipping {name}")
            skipped += 1
            continue
        parents = target.relative_to(root).parts[:-1]
        parent = root
        blocked = False
        for part in parents:
            parent /= part
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                print(f"WARNING: blocked parent; skipping {name}")
                skipped += 1
                blocked = True
                break
            parent.mkdir(exist_ok=True)
        if blocked:
            continue
        try:
            with target.open("xb") as output:
                output.write(content)
            written += 1
        except FileExistsError:
            print(f"WARNING: exists; skipping {name}")
            skipped += 1
    print(f"Reconstructed {written} files; skipped {skipped} existing/blocked paths in {root}")
    return written, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--destination", type=Path, default=Path("."))
    args = parser.parse_args()
    try:
        files = parse_bundle(args.bundle.read_bytes())
        restore(files, args.destination)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f"Reconstruction failed: {error}\n")


if __name__ == "__main__":
    main()
