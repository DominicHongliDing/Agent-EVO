from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    db_path: Path
    artifact_root: Path
    dataset_root: Path
    fixture_root: Path
    unihr_url: str
    clinical_url: str
    unihr_username: str
    unihr_password: str
    unihr_usage_db: Path | None
    clinical_user_id: str
    clinical_access_token: str
    access_token: str
    timeout_seconds: int
    unihr_source: Path
    clinical_source: Path

    @classmethod
    def from_env(cls) -> "Settings":
        usage = os.getenv("EVO_UNIHR_USAGE_DB_PATH", "").strip()
        return cls(
            db_path=Path(os.getenv("EVO_DB_PATH", str(ROOT / ".local" / "evo.db"))).resolve(),
            artifact_root=Path(os.getenv("EVO_ARTIFACT_ROOT", str(ROOT / ".local" / "artifacts"))).resolve(),
            dataset_root=ROOT / "datasets",
            fixture_root=ROOT / "fixtures",
            unihr_url=os.getenv("EVO_UNIHR_BASE_URL", "http://127.0.0.1:8088").rstrip("/"),
            clinical_url=os.getenv("EVO_CLINICAL_BASE_URL", "http://127.0.0.1:8000").rstrip("/"),
            unihr_username=os.getenv("EVO_UNIHR_USERNAME", ""),
            unihr_password=os.getenv("EVO_UNIHR_PASSWORD", ""),
            unihr_usage_db=Path(usage).resolve() if usage else None,
            clinical_user_id=os.getenv("EVO_CLINICAL_USER_ID", "evo_synthetic_user"),
            clinical_access_token=os.getenv("EVO_CLINICAL_ACCESS_TOKEN", ""),
            access_token=os.getenv("EVO_ACCESS_TOKEN", ""),
            timeout_seconds=int(os.getenv("EVO_RUN_TIMEOUT_SECONDS", "600")),
            unihr_source=Path(os.getenv("EVO_UNIHR_SOURCE_ROOT", str(ROOT / "external" / "unihr-server"))).resolve(),
            clinical_source=Path(os.getenv("EVO_CLINICAL_SOURCE_ROOT", str(ROOT / "external" / "clinical-agent"))).resolve(),
        )

    def prepare(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.artifact_root.mkdir(parents=True, exist_ok=True)

    def assert_local_targets(self) -> None:
        from urllib.parse import urlparse

        for target in (self.unihr_url, self.clinical_url):
            parsed = urlparse(target)
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
                raise ValueError("Business API targets must use local HTTP loopback addresses")
