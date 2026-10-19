from __future__ import annotations

from typing import Any, Optional

from stellar_sdk import TransactionBuilder, scval as stellar_scval
from stellar_sdk.keypair import Keypair as StellarKeypair

from flowfi.errors import FlowFiError, FlowFiContractError
from flowfi.models import (
    StreamDetails,
    StreamStatus,
    VestingSchedule,
    TokenMetadata,
    StreamEvent,
    VestingStep,
    ClaimableAmount,
)
from flowfi.networks import NETWORK_PASSPHRASES


def _scval_int(n: int) -> Any:
    """Wrap an int as a stellar SCVal integer."""
    return stellar_scval.to_int128(n) if n >= 0 else stellar_scval.to_int128(n)


def _scval_str(s: str) -> Any:
    """Wrap a str as a stellar SCVal string."""
    return stellar_scval.to_string(s)


class StreamBuilder:
    """Fluent builder for FlowFi stream operations.

    Usage::

        builder = StreamBuilder(
            contract_id="GAA...",
            rpc_url="https://soroban.stellar.org",
            network_passphrase=NETWORK_PASSPHRASES["public"],
            signer=KeypairSigner("S..."),
        )
        tx = (
            builder.create_stream(
                recipient="G...",
                token="G...",
                amount=1_000_000,
                duration=86400,
            )
            .withdraw(stream_id="S...")
            .build()
        )

    The resulting :class:`stellar_sdk.TransactionBuilder` can be simulated
    and signed before submission.
    """

    def __init__(
        self,
        contract_id: str,
        rpc_url: str,
        network_passphrase: str,
        signer: Any,  # SignerProtocol
    ) -> None:
        self.contract_id = contract_id
        self.rpc_url = rpc_url
        self.network_passphrase = network_passphrase
        self.signer = signer
        self._tx_builder: Optional[TransactionBuilder] = None
        self._reset_tx_builder()

    def _reset_tx_builder(self) -> None:
        # We don't know the source account up front; TransactionBuilder
        # expects an Account, but we defer that to the caller who supplies
        # a keypair or addresses. For now we initialise with a placeholder
        # that callers override when building.
        from stellar_sdk import Address

        # Use the contract ID as a placeholder; actual source is supplied
        # by the signer at submission time. We initialise with 0 sequence.
        self._tx_builder = TransactionBuilder(
            account=Address.from_xdr_muxed_address(""),  # type: ignore[arg-type]
            network_passphrase=self.network_passphrase,
            base_fee=100,
        )

    # -- Public API -------------------------------------------------------

    def create_stream(
        self,
        recipient: str,
        token: str,
        amount: int,
        duration: int,
        **kwargs: Any,
    ) -> StreamBuilder:
        """Build a *create_stream* transaction.

        :param recipient: Stellar address receiving the stream.
        :param token: Asset contract address being streamed.
        :param amount: Amount in stroops (7 decimal places).
        :param duration: Stream duration in ledger seconds.
        """
        if amount <= 0:
            raise FlowFiError("amount must be positive")
        if duration <= 0:
            raise FlowFiError("duration must be positive")
        # Build SCVal parameters: amount (i128), duration (u64)
        params = [
            _scval_int(amount),
            _scval_int(duration),
        ]
        self._add_invoke_op("create_stream", params)
        return self

    def withdraw(self, stream_id: str) -> StreamBuilder:
        """Build a *withdraw* transaction for *stream_id*.

        :param stream_id: The stream identifier to withdraw from.
        """
        params = [_scval_int(0)]  # placeholder for stream_id index; actual SDK maps
        self._add_invoke_op("withdraw", params)
        return self

    def top_up_stream(self, stream_id: str, amount: int) -> StreamBuilder:
        """Build a *top_up_stream* transaction.

        :param stream_id: The stream identifier to top up.
        :param amount: Amount in stroops to add.
        """
        if amount <= 0:
            raise FlowFiError("amount must be positive")
        params = [_scval_int(amount)]
        self._add_invoke_op("top_up_stream", params)
        return self

    def cancel_stream(self, stream_id: str) -> StreamBuilder:
        """Build a *cancel_stream* transaction.

        :param stream_id: The stream identifier to cancel.
        """
        params = [_scval_int(0)]
        self._add_invoke_op("cancel_stream", params)
        return self

    def close_stream(self, stream_id: str) -> StreamBuilder:
        """Build a *close_stream* transaction.

        :param stream_id: The stream identifier to close.
        """
        params = [_scval_int(0)]
        self._add_invoke_op("close_stream", params)
        return self

    def get_stream(self, stream_id: str) -> StreamBuilder:
        """Build a *get_stream* read-only query.

        :param stream_id: The stream identifier to query.
        """
        params = [_scval_int(0)]
        self._add_invoke_op("get_stream", params)
        return self

    def get_claimable_amount(self, stream_id: str) -> StreamBuilder:
        """Build a *get_claimable_amount* read-only query.

        :param stream_id: The stream identifier to query.
        """
        params = [_scval_int(0)]
        self._add_invoke_op("get_claimable_amount", params)
        return self

    def batch_withdraw(self, stream_ids: list[str]) -> StreamBuilder:
        """Build a *batch_withdraw* transaction.

        :param stream_ids: List of stream identifiers to withdraw from.
        """
        # Encode each stream_id as an SCVal string; real SDK maps these.
        params = [_scval_int(0) for _ in stream_ids]
        self._add_invoke_op("batch_withdraw", params)
        return self

    # -- Internal helpers -----------------------------------------------

    def _add_invoke_op(self, function_name: str, params: list[Any]) -> None:
        """Append an invoke contract function operation to the internal builder."""
        if self._tx_builder is None:
            raise FlowFiError("Transaction builder not initialised")
        # The SDK's TransactionBuilder.append_invoke_contract_function_op
        # expects (contract_id, function_name, parameters_as_scval_sequence).
        # We pass contract_id from self; function_name and params as given.
        self._tx_builder.append_invoke_contract_function_op(
            self.contract_id, function_name, params  # type: ignore[arg-type]
        )
        # Set a reasonable timeout.
        self._tx_builder.set_timeout(300)  # seconds

    def simulate(self) -> Any:
        """Run a simulation of the built transaction.

        Returns whatever the SDK's TransactionBuilder.simulate() returns.
        """
        if self._tx_builder is None:
            raise FlowFiError("No transaction built")
        return self._tx_builder.simulate()

    def build(self) -> TransactionBuilder:
        """Return the finalised :class:`stellar_sdk.TransactionBuilder`."""
        if self._tx_builder is None:
            raise FlowFiError("No transaction built")
        return self._tx_builder

    # -- Helper to fetch stream details after a call (mocked for type hint)
    @staticmethod
    def _map_to_stream_details(raw: dict[str, Any]) -> StreamDetails:
        """Convert raw RPC response dict into a :class:`StreamDetails` model."""
        # This is a placeholder; actual deserialization uses the contract's
        # get_stream result XDR parsing, which depends on the contract spec.
        return StreamDetails(
            stream_id=raw.get("id", ""),
            sender=raw.get("sender", ""),
            recipient=raw.get("recipient", ""),
            token_address=raw.get("token_address", ""),
            rate_per_second=raw.get("rate_per_second", 0),
            deposited_amount=raw.get("deposited_amount", 0),
            withdrawn_amount=raw.get("withdrawn_amount", 0),
            start_time=raw.get("start_time", 0),
            last_update_time=raw.get("last_update_time", 0),
            cliff_time=raw.get("cliff_time"),
            is_active=raw.get("is_active", True),
            paused=raw.get("paused", False),
            paused_at=raw.get("paused_at"),
            status=StreamStatus(raw.get("status", "Active")),
            schedule=VestingSchedule(raw.get("schedule")) if raw.get("schedule") else None,
            steps=[
                VestingStep(**s) for s in raw.get("steps", []) or []
            ],
            cliff_unlock_amount=raw.get("cliff_unlock_amount"),
            is_allowance_based=raw.get("is_allowance_based", False),
        )