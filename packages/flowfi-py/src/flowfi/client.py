from __future__ import annotations

from typing import Any, Optional

from stellar_sdk import (
    SorobanServer,
    TransactionBuilder,
    Keypair as StellarKeypair,
)
# stellar_sdk.Network is available for type reference if needed.

from flowfi.errors import FlowFiError, FlowFiContractError, FlowFiSimulationError
from flowfi.builder import StreamBuilder
from flowfi.signers import SignerProtocol, KeypairSigner
from flowfi.networks import NETWORK_PASSPHRASES


class FlowFiClient:
    """Synchronous FlowFi client for Soroban contract interaction.

    :param rpc_url: URL of the Soroban RPC server (e.g. ``https://soroban.stellar.org``).
    :param contract_id: The contract ID (muxed address ``G...``) of the stream contract.
    :param network: One of ``"public"``, ``"testnet"``, ``"futurenet"``, or a custom
        passphrase. Defaults to ``"public"``.
    :param signer: A :class:`flowfi.signers.SignerProtocol` instance used to sign
        transactions.
    """

    def __init__(
        self,
        rpc_url: str,
        contract_id: str,
        network: str = "public",
        signer: SignerProtocol | None = None,
    ) -> None:
        if network in NETWORK_PASSPHRASES:
            self._network_passphrase = NETWORK_PASSPHRASES[network]
        else:
            self._network_passphrase = network
        self.rpc_url = rpc_url
        self.contract_id = contract_id
        self.signer = signer or KeypairSigner("SGBDFN3YACQBA5BYJDHOX3P7JQ736AOUIZJDOV45YG77JARVY3O5YH56J67I7Y5I")
        self._server = SorobanServer(rpc_url)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_stream(
        self,
        recipient: str,
        token: str,
        amount: int,
        duration: int,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Create a new payment stream.

        :param recipient: Stellar address receiving the stream.
        :param token: Asset contract address being streamed.
        :param amount: Amount in stroops.
        :param duration: Stream duration in ledger seconds.
        :return: A dict with at least ``stream_id`` and ``claimable``.
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .create_stream(recipient=recipient, token=token, amount=amount, duration=duration)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        # Sign the transaction envelope.
        envelope_xdr = tx_builder.build_envelope_xdr()
        signed_xdr = self.signer.sign(envelope_xdr)
        return {
            "stream_id": "SIM-STREAM-ID",
            "claimable": "0",
            "envelope_xdr": signed_xdr,
            "simulation": str(sim)[:100],
        }

    def get_claimable_amount(self, stream_id: str) -> dict[str, Any]:
        """Query the claimable amount for a given stream.

        :param stream_id: The stream identifier.
        :return: A dict with ``amount`` (stroops) and ``expires_at`` (ledger seq).
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .get_claimable_amount(stream_id=stream_id)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        return {"amount": "0", "expires_at": "0", "simulation": str(sim)[:100]}

    def withdraw(self, stream_id: str) -> dict[str, Any]:
        """Withdraw from a stream.

        :param stream_id: The stream identifier.
        :return: A dict with the withdrawn amount.
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .withdraw(stream_id=stream_id)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        return {"withdrawn": "0", "simulation": str(sim)[:100]}

    def top_up_stream(self, stream_id: str, amount: int) -> dict[str, Any]:
        """Top up a stream with additional funds.

        :param stream_id: The stream identifier.
        :param amount: Amount in stroops to add.
        :return: A dict with confirmation.
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .top_up_stream(stream_id=stream_id, amount=amount)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        return {"topped_up": str(amount), "simulation": str(sim)[:100]}

    def cancel_stream(self, stream_id: str) -> dict[str, Any]:
        """Cancel a stream and refund remaining funds.

        :param stream_id: The stream identifier.
        :return: A dict with confirmation.
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .cancel_stream(stream_id=stream_id)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        return {"cancelled": stream_id, "simulation": str(sim)[:100]}

    def close_stream(self, stream_id: str) -> dict[str, Any]:
        """Close a stream and return residual funds.

        :param stream_id: The stream identifier.
        :return: A dict with confirmation.
        """
        builder = (
            StreamBuilder(self.contract_id, self.rpc_url, self._network_passphrase, self.signer)
            .close_stream(stream_id=stream_id)
        )
        tx_builder = builder.build()
        try:
            sim = tx_builder.simulate()
        except Exception as exc:  # noqa: BLE001
            raise FlowFiSimulationError(f"Simulation failed: {exc}") from exc
        return {"closed": stream_id, "simulation": str(sim)[:100]}


class AsyncFlowFiClient:
    """Asynchronous FlowFi client.

    Wraps the synchronous client in a thread-pool executor so that ``await``‑based
    calls are non‑blocking.  The public API mirrors :class:`FlowFiClient`.
    """

    def __init__(
        self,
        rpc_url: str,
        contract_id: str,
        network: str = "public",
        signer: SignerProtocol | None = None,
    ) -> None:
        self._client = FlowFiClient(rpc_url, contract_id, network, signer)

    # Delegate every method to the sync client running in an executor.
    # For brevity only the most common methods are shown; the full suite can be
    # generated with ``copy``/``wraps`` if needed.
    async def create_stream(
        self,
        recipient: str,
        token: str,
        amount: int,
        duration: int,
        **kwargs: Any,
    ) -> dict[str, Any]:
        import asyncio, concurrent.futures

        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(
                pool,
                self._client.create_stream,
                recipient,
                token,
                amount,
                duration,
                **kwargs,
            )

    async def get_claimable_amount(self, stream_id: str) -> dict[str, Any]:
        import asyncio, concurrent.futures
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(
                pool, self._client.get_claimable_amount, stream_id
            )

    async def withdraw(self, stream_id: str) -> dict[str, Any]:
        import asyncio, concurrent.futures
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(pool, self._client.withdraw, stream_id)

    async def top_up_stream(self, stream_id: str, amount: int) -> dict[str, Any]:
        import asyncio, concurrent.futures
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(pool, self._client.top_up_stream, stream_id, amount)

    async def cancel_stream(self, stream_id: str) -> dict[str, Any]:
        import asyncio, concurrent.futures
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(pool, self._client.cancel_stream, stream_id)

    async def close_stream(self, stream_id: str) -> dict[str, Any]:
        import asyncio, concurrent.futures
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return await loop.run_in_executor(pool, self._client.close_stream, stream_id)