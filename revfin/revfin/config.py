"""Load entities, category rules and settings from config.yaml plus .env.

Adding a second Revolut account is a config change: add an entity block to
config.yaml and the matching REVOLUT_<SLUG>_* lines to .env.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import yaml

SANDBOX_API = "https://sandbox-b2b.revolut.com/api/1.0"
PRODUCTION_API = "https://b2b.revolut.com/api/1.0"
SANDBOX_CONSENT = "https://sandbox-business.revolut.com/app-confirm"
PRODUCTION_CONSENT = "https://business.revolut.com/app-confirm"

STARTER_CATEGORIES = [
    "client_receipt", "payroll", "contractor", "software", "office_rent", "travel",
    "ads", "bank_fee", "tax", "intercompany", "fx", "owner", "uncategorised",
]
# Built-in categories the rule engine assigns on its own (see categorise.py).
SYSTEM_CATEGORIES = ["internal"]


class ConfigError(Exception):
    pass


def find_home(explicit: str | os.PathLike | None = None) -> Path:
    """Project root: the directory holding config.yaml.

    Order: explicit argument, $REVFIN_HOME, the first parent of the cwd that
    has a config.yaml, then the directory above this package.
    """
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("REVFIN_HOME")
    if env:
        return Path(env).expanduser().resolve()
    cwd = Path.cwd()
    for candidate in (cwd, *cwd.parents):
        if (candidate / "config.yaml").exists():
            return candidate
    return Path(__file__).resolve().parent.parent


def load_dotenv(path: Path, environ: dict | None = None) -> dict[str, str]:
    """Minimal .env reader. Existing environment variables win."""
    environ = os.environ if environ is None else environ
    loaded: dict[str, str] = {}
    if not path.exists():
        return loaded
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in environ:
            environ[key] = value
            loaded[key] = value
    return loaded


@dataclass
class Entity:
    slug: str
    name: str
    base_currency: str
    client_id: str | None = None
    private_key_path: Path | None = None
    redirect_uri: str | None = None
    intercompany_pattern: str | None = None
    env_prefix: str = ""

    @property
    def redirect_domain(self) -> str:
        if not self.redirect_uri:
            return ""
        return urlparse(self.redirect_uri).netloc

    def missing_credentials(self) -> list[str]:
        missing = []
        if not self.client_id:
            missing.append(f"{self.env_prefix}CLIENT_ID")
        if not self.private_key_path:
            missing.append(f"{self.env_prefix}PRIVATE_KEY")
        elif not self.private_key_path.exists():
            missing.append(f"{self.env_prefix}PRIVATE_KEY (file not found: {self.private_key_path})")
        if not self.redirect_uri:
            missing.append(f"{self.env_prefix}REDIRECT_URI")
        return missing

    def require_credentials(self) -> None:
        missing = self.missing_credentials()
        if missing:
            raise ConfigError(
                f"Entity '{self.slug}' is missing credentials: {', '.join(missing)}. "
                "Set them in .env (see .env.example)."
            )


@dataclass
class Rule:
    id: str
    category: str
    merchant_name: re.Pattern | None = None
    counterparty_name: re.Pattern | None = None
    reference: re.Pattern | None = None
    type: str | None = None
    direction: str | None = None  # "in" | "out" | None


@dataclass
class Settings:
    home: Path
    env: str
    api_base: str
    consent_base: str
    db_path: Path
    tokens_path: Path
    exports_dir: Path
    default_since: str
    sync_overlap_days: int
    unusual_threshold: float
    unusual_mom_pct: float
    fx_rates: dict[tuple[str, str], float]
    account_nicknames: dict[str, str]
    entities: dict[str, Entity]
    rules: list[Rule]
    raw: dict = field(default_factory=dict)

    def entity(self, slug: str) -> Entity:
        try:
            return self.entities[slug]
        except KeyError:
            known = ", ".join(self.entities) or "(none configured)"
            raise ConfigError(f"Unknown entity '{slug}'. Configured entities: {known}") from None

    def select_entities(self, slug: str | None) -> list[Entity]:
        if slug:
            return [self.entity(slug)]
        return list(self.entities.values())

    @property
    def is_production(self) -> bool:
        return self.env == "production"


def _compile(pattern: str | None) -> re.Pattern | None:
    if pattern is None:
        return None
    try:
        return re.compile(str(pattern), re.IGNORECASE)
    except re.error as exc:
        raise ConfigError(f"Bad regex in category rule: {pattern!r} ({exc})") from exc


def _parse_rules(items: list | None) -> list[Rule]:
    rules: list[Rule] = []
    seen: set[str] = set()
    for i, item in enumerate(items or []):
        if not isinstance(item, dict) or "category" not in item:
            raise ConfigError(f"Category rule #{i + 1} needs at least a 'category' key")
        rule_id = str(item.get("id") or f"rule{i + 1}")
        if rule_id in seen:
            raise ConfigError(f"Duplicate category rule id '{rule_id}'")
        seen.add(rule_id)
        match = item.get("match") or {}
        if not isinstance(match, dict) or not match:
            raise ConfigError(f"Category rule '{rule_id}' needs a non-empty 'match' block")
        unknown = set(match) - {"merchant_name", "counterparty_name", "reference", "type", "direction"}
        if unknown:
            raise ConfigError(f"Category rule '{rule_id}' has unknown match keys: {sorted(unknown)}")
        direction = match.get("direction")
        if direction not in (None, "in", "out"):
            raise ConfigError(f"Category rule '{rule_id}': direction must be 'in' or 'out'")
        rules.append(
            Rule(
                id=rule_id,
                category=str(item["category"]),
                merchant_name=_compile(match.get("merchant_name")),
                counterparty_name=_compile(match.get("counterparty_name")),
                reference=_compile(match.get("reference")),
                type=match.get("type"),
                direction=direction,
            )
        )
    return rules


def _parse_fx(raw: dict | None) -> dict[tuple[str, str], float]:
    rates: dict[tuple[str, str], float] = {}
    for key, value in (raw or {}).items():
        pair = re.split(r"[/_\->]+", str(key).upper())
        if len(pair) != 2 or not pair[0] or not pair[1]:
            raise ConfigError(f"fx.rates key must look like EUR_GBP, got {key!r}")
        rates[(pair[0], pair[1])] = float(value)
    return rates


def load(home: str | os.PathLike | None = None, environ: dict | None = None) -> Settings:
    root = find_home(home)
    environ = os.environ if environ is None else environ
    load_dotenv(root / ".env", environ)

    config_path = root / "config.yaml"
    if not config_path.exists():
        raise ConfigError(f"No config.yaml in {root}. Copy the one from the repo or set REVFIN_HOME.")
    raw = yaml.safe_load(config_path.read_text()) or {}
    settings_raw = raw.get("settings") or {}

    env = (environ.get("REVOLUT_ENV") or settings_raw.get("env") or "sandbox").lower()
    if env not in ("sandbox", "production"):
        raise ConfigError(f"REVOLUT_ENV must be 'sandbox' or 'production', got {env!r}")

    entities: dict[str, Entity] = {}
    for slug, block in (raw.get("entities") or {}).items():
        block = block or {}
        slug = str(slug)
        if not re.fullmatch(r"[a-z0-9_-]+", slug):
            raise ConfigError(f"Entity slug '{slug}' must be lowercase letters, digits, - or _")
        prefix = block.get("env_prefix") or f"REVOLUT_{slug.upper().replace('-', '_')}_"
        key_value = environ.get(f"{prefix}PRIVATE_KEY")
        key_path = (root / Path(key_value).expanduser()) if key_value else None
        entities[slug] = Entity(
            slug=slug,
            name=str(block.get("name") or slug),
            base_currency=str(block.get("base_currency") or "GBP").upper(),
            client_id=environ.get(f"{prefix}CLIENT_ID") or None,
            private_key_path=key_path.resolve() if key_path else None,
            redirect_uri=environ.get(f"{prefix}REDIRECT_URI") or None,
            intercompany_pattern=block.get("intercompany_pattern"),
            env_prefix=prefix,
        )
    if not entities:
        raise ConfigError("config.yaml has no entities")

    def _path(key: str, default: str) -> Path:
        return (root / Path(settings_raw.get(key) or default)).resolve()

    unusual = raw.get("unusual") or {}
    return Settings(
        home=root,
        env=env,
        api_base=PRODUCTION_API if env == "production" else SANDBOX_API,
        consent_base=PRODUCTION_CONSENT if env == "production" else SANDBOX_CONSENT,
        db_path=_path("db_path", "data/revfin.db"),
        tokens_path=_path("tokens_path", "tokens.json"),
        exports_dir=_path("exports_dir", "data/exports"),
        default_since=str(settings_raw.get("default_since") or "2026-01-01"),
        sync_overlap_days=int(settings_raw.get("sync_overlap_days", 3)),
        unusual_threshold=float(unusual.get("large_outgoing", 5000)),
        unusual_mom_pct=float(unusual.get("month_on_month_pct", 40)),
        fx_rates=_parse_fx((raw.get("fx") or {}).get("rates")),
        account_nicknames={str(k): str(v) for k, v in (raw.get("accounts") or {}).items()},
        entities=entities,
        rules=_parse_rules(raw.get("categories")),
        raw=raw,
    )
