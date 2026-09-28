"""Object storage abstraction. Keys are tenant-scoped paths like
``workspaces/{ws}/jobs/{job}/scenes/0/clip.mp4``.

Only a local-filesystem backend exists today; an S3 backend will implement the same protocol.
FFmpeg needs real file paths, so every backend can materialise a key as a local path.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Protocol


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


class S3Storage:
    """S3-compatible backend (AWS S3, Cloudflare R2, MinIO).

    Producers write to a local staging path and ``commit`` uploads it; readers get a cached
    local copy from ``local_path``. The cache lives under ``cache_dir`` and is per worker pod,
    so a key downloaded once is reused across activities on the same pod.
    """

    def __init__(
        self,
        bucket: str,
        cache_dir: Path,
        *,
        endpoint_url: str | None = None,
        region: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._s3: Any = client or boto3.client(
            "s3",
            endpoint_url=endpoint_url or None,
            region_name=region or None,
            aws_access_key_id=access_key or None,
            aws_secret_access_key=secret_key or None,
            config=Config(s3={"addressing_style": "path"} if endpoint_url else {}),
        )

    def _validate(self, key: str) -> str:
        if key.startswith("/") or ".." in key.split("/"):
            raise ValueError(f"invalid storage key: {key}")
        return key

    def _cache_path(self, key: str) -> Path:
        return self.cache_dir / self._validate(key)

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=self._validate(key), Body=data, ContentType=content_type
        )
        p = self._cache_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        self._s3.upload_file(
            str(path), self.bucket, self._validate(key), ExtraArgs={"ContentType": content_type}
        )
        p = self._cache_path(key)
        if path.resolve() != p.resolve():
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, p)

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._s3.head_object(Bucket=self.bucket, Key=self._validate(key))
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def local_path(self, key: str) -> Path:
        p = self._cache_path(key)
        if p.exists():
            return p
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        self._s3.download_file(self.bucket, self._validate(key), str(tmp))
        tmp.replace(p)
        return p

    def staging_path(self, key: str) -> Path:
        p = self._cache_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def commit(self, key: str, content_type: str) -> None:
        p = self._cache_path(key)
        if not p.exists():
            raise FileNotFoundError(key)
        self._s3.upload_file(
            str(p), self.bucket, self._validate(key), ExtraArgs={"ContentType": content_type}
        )

    def read_bytes(self, key: str) -> bytes:
        return self.local_path(key).read_bytes()
