"""FlowFi Python SDK for Soroban payment streaming.

Provides :class:`FlowFiClient` (sync + async) and :class:`StreamBuilder` for
constructing, simulating, and signing stream operations.

Typical usage:

    from flowfi import FlowFiClient
    from flowfi.keypair import KeypairSigner

    client = FlowFiClient(
        rpc_url="https://soroban.stellar.org",
        contract_id="G....",
        network="",
        signer=KeypairSigner("S...."),
    )
    result = client.create_stream(...)

"""

from flowfi.client import FlowFiClient, AsyncFlowFiClient
from flowfi.builder import StreamBuilder
from flowfi.models import (
    StreamDetails,
    StreamStatus,
    VestingSchedule,
    TokenMetadata,
    StreamEvent,
)
from flowfi.errors import FlowFiError, FlowFiContractError
from flowfi.networks import validate_network_passphrase, NETWORK_PASSPHRASES
from flowfi.signers import KeypairSigner

__all__ = [
    "FlowFiClient",
    "AsyncFlowFiClient",
    "StreamBuilder",
    "StreamDetails",
    "StreamStatus",
    "VestingSchedule",
    "TokenMetadata",
    "StreamEvent",
    "FlowFiError",
    "FlowFiContractError",
    "validate_network_passphrase",
    "NETWORK_PASSPHRASES",
    "KeypairSigner",
]