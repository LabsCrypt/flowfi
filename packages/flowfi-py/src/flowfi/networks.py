from __future__ import annotations

from typing import Dict

NETWORK_PASSPHRASES: Dict[str, str] = {
    "public": "Public Global Network ; October 2019",
    "testnet": "Test Global Network ; September 2015",
    "futurenet": "Future Global Network ; January 2021",
}

DEFAULT_NETWORK = "public"


def validate_network_passphrase(passphrase: str) -> bool:
    """Return True if *passphrase* matches one of the known networks."""
    return passphrase in NETWORK_PASSPHRASES