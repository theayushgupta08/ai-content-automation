"""S3Storage against moto's in-memory S3."""

from __future__ import annotations

from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from avg_workers.storage import S3Storage


@pytest.fixture
def s3(tmp_path: Path):
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="avg-media")
        yield S3Storage("avg-media", tmp_path / "cache", region="us-east-1", client=client)


def test_put_exists_read_and_cache(s3: S3Storage, tmp_path: Path) -> None:
    key = "workspaces/ws/jobs/j/script/v1.json"
    assert not s3.exists(key)
    s3.put_bytes(key, b'{"a":1}', "application/json")
    assert s3.exists(key)
    assert s3.read_bytes(key) == b'{"a":1}'
    # Fresh instance (empty cache) downloads from the bucket.
    other = S3Storage("avg-media", tmp_path / "cache2", region="us-east-1", client=s3._s3)
    assert other.local_path(key).read_bytes() == b'{"a":1}'


def test_staging_commit_uploads(s3: S3Storage) -> None:
    key = "workspaces/ws/jobs/j/scenes/0/clip.mp4"
    staging = s3.staging_path(key)
    staging.write_bytes(b"MP4")
    assert not s3.exists(key)
    s3.commit(key, "video/mp4")
    assert s3.exists(key)
    head = s3._s3.head_object(Bucket="avg-media", Key=key)
    assert head["ContentType"] == "video/mp4"


def test_commit_without_file_and_bad_keys(s3: S3Storage) -> None:
    with pytest.raises(FileNotFoundError):
        s3.commit("workspaces/ws/missing.bin", "application/octet-stream")
    with pytest.raises(ValueError):
        s3.exists("../etc/passwd")
    with pytest.raises(ValueError):
        s3.put_bytes("/abs", b"", "text/plain")


def test_put_file(s3: S3Storage, tmp_path: Path) -> None:
    src = tmp_path / "poster.jpg"
    src.write_bytes(b"JPG")
    s3.put_file("workspaces/ws/jobs/j/output/poster.jpg", src, "image/jpeg")
    assert s3.read_bytes("workspaces/ws/jobs/j/output/poster.jpg") == b"JPG"
