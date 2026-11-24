from __future__ import annotations

from typing import Any, Callable, Optional

from stellar_sdk import Keypair as StellarKeypair

from flowfi.errors import FlowFiError


class SignerProtocol:
    """Minimal signer interface used by FlowFiClient."""

    def get_public_key(self) -> str: ...

    def sign(self, envelope_xdr: str) -> str: ...


class KeypairSigner(SignerProtocol):
    """Sign a transaction using a Stellar Keypair (secret seed starting with S)."""

    def __init__(self, secret: str) -> None:
        if not secret.startswith("S"):
            raise FlowFiConfigError(f"Invalid secret seed: {secret}")
        self._keypair = StellarKeypair.from_secret(secret)

    def get_public_key(self) -> str:
        return self._keypair.public_key

    def sign(self, envelope_xdr: str) -> str:
        return self._keypair.sign_envelope(envelope_xdr).to_xdr()


class CustomSigner(SignerProtocol):
    """Sign using a custom callable that receives the XDR envelope and returns the signed XDR."""

    def __init__(self, sign_fn: Callable[[str], str]) -> None:
        if not callable(sign_fn):
            raise FlowFiConfigError("sign_fn must be callable")
        self._sign_fn = sign_fn

    def get_public_key(self) -> str:
        # Callers providing their own key management must supply the public key separately.
        raise FlowFiError("CustomSigner does not expose a public key automatically")

    def sign(self, envelope_xdr: str) -> str:
        try:
            return self._sign_fn(envelope_xdr)
        except Exception as exc:  # noqa: BLE001
            raise FlowFiError(f"signer failed: {exc}") from exc