import os
from functools import lru_cache
from typing import Iterable


@lru_cache(maxsize=1)
def _load_cluster_prompt_template() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "prompts", "cluster_label_prompt.txt")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def render_cluster_prompt(
    level_id: int,
    cluster_id: int,
    top_markers: Iterable[str],
    low_markers: Iterable[str],
    channel_list: Iterable[str] | None = None,
    channel_avg_pairs: Iterable[str] | None = None,
) -> str:
    tmpl = _load_cluster_prompt_template()
    top_str = ", ".join(top_markers)
    low_str = ", ".join(low_markers)
    return tmpl.format(
        level_id=level_id,
        cluster_id=cluster_id,
        top_markers=top_str,
        low_markers=low_str,
        channel_list=", ".join(channel_list or []),
        channel_avg_pairs="; ".join(channel_avg_pairs or []),
    )


