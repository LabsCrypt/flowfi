from __future__ import annotations

from typing import Any, Optional

from enum import Enum

from pydantic import BaseModel, Field, validator


class StreamStatus(str, Enum):
    Active = "Active"
    Paused = "Paused"
    Cancelled = "Cancelled"
    Completed = "Completed"


class VestingSchedule(str, Enum):
    Linear = "linear"
    StepTranches = "step_tranches"
    HybridCliffLinear = "hybrid_cliff_linear"


class VestingStep(BaseModel):
    unlock_time: int
    unlock_amount: int


class TokenMetadata(BaseModel):
    symbol: str
    name: str
    decimals: int = Field(default=7)


class StreamDetails(BaseModel):
    stream_id: str
    sender: str
    recipient: str
    token_address: str
    rate_per_second: int
    deposited_amount: int
    withdrawn_amount: int
    start_time: int
    last_update_time: int
    cliff_time: Optional[int] = None
    is_active: bool = True
    paused: bool = False
    paused_at: Optional[int] = None
    status: StreamStatus = StreamStatus.Active
    schedule: Optional[VestingSchedule] = None
    steps: Optional[list[VestingStep]] = None
    cliff_unlock_amount: Optional[int] = None
    is_allowance_based: bool = False

    @validator("rate_per_second", "deposited_amount", "withdrawn_amount", pre=True, always=True)
    def require_int(cls, v: Any) -> int:
        if isinstance(v, (int, float)):
            return int(v)
        raise ValueError("integer required")

    class Config:
        populate_by_name = True


class StreamEvent(BaseModel):
    id: str
    type: str
    ledger: int
    ledger_closed_at: str
    transaction_index: int
    operation_index: int
    in_successful_contract_call: bool = False
    contract_id: Optional[str] = None
    topic: list[str] = Field(default_factory=list)
    value: list[str] = Field(default_factory=list)


class ClaimableAmount(BaseModel):
    stream_id: str
    amount: int
    expires_at: int

    @validator("amount", "expires_at", pre=True, always=True)
    def require_int(cls, v: Any) -> int:
        if isinstance(v, (int, float)):
            return int(v)
        raise ValueError("integer required")