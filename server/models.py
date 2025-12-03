from typing import Optional, List, Dict

from pydantic import BaseModel, Field


class CompositeSpec(BaseModel):
    """composite rendering parameters"""

    method: str = Field("weighted_mean", description='"mean"|"max"|"weighted_mean"')
    weights: Dict[int, float] = Field(default_factory=dict)
    colors: Dict[int, List[float]] = Field(default_factory=dict)
    alphas: Dict[int, float] = Field(default_factory=dict)


class AtlasRequest(BaseModel):
    """atlas rendering request body"""

    channels: List[int]
    composite: CompositeSpec = Field(default_factory=CompositeSpec)
    tile: Optional[int] = Field(
        default=None, description="Tile size; if omitted, auto-detected from Zarr"
    )


__all__ = ["CompositeSpec", "AtlasRequest"]


