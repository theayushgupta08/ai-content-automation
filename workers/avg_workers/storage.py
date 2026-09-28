"""Object storage abstraction. Keys are tenant-scoped paths like
``workspaces/{ws}/jobs/{job}/scenes/0/clip.mp4``.

Only a local-filesystem backend exists today; an S3 backend will implement the same protocol.
FFmpeg needs real file paths, so every backend can materialise a key as a local path.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    def put_bytes(self, key: str, data: bytes, content_type: str) -> None: ...

    def put_file(self, key: str, path: Path, content_type: str) -> None: ...

    def exists(self, key: str) -> bool: ...

    def local_path(self, key: str) -> Path:
        """Return a local path for reading. May download for remote backends."""
        ...

    def staging_path(self, key: str) -> Path:
        """Return a local path a producer can write to; call ``commit`` afterwards."""
        ...

    def commit(self, key: str, content_type: str) -> None:
        """Publish a file previously written to ``staging_path(key)``."""
        ...

    def read_bytes(self, key: str) -> bytes: ...


class LocalStorage:
    """Filesystem-backed storage rooted at ``root``. Shared with the API in local dev."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        if key.startswith("/") or ".." in key.split("/"):
            raise ValueError(f"invalid storage key: {key}")
        return self.root / key

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        if path.resolve() != p.resolve():
            shutil.copyfile(path, p)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def local_path(self, key: str) -> Path:
        p = self._path(key)
        if not p.exists():
            raise FileNotFoundError(key)
        return p

    def staging_path(self, key: str) -> Path:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def commit(self, key: str, content_type: str) -> None:
        # Files are written in place for the local backend.
        if not self._path(key).exists():
            raise FileNotFoundError(key)

    def read_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()


def job_prefix(workspace_id: str, job_id: str) -> str:
    return f"workspaces/{workspace_id}/jobs/{job_id}"
